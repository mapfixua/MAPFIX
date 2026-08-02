'use strict';

/**
 * Google / Apple Sign-In without heavy deps (jose, google-auth-library).
 * Keeps the Vercel serverless bundle small and CJS-safe.
 */

const crypto = require('crypto');
const { supabaseClient, USERS_TABLE, mapUserRow, toUserRow } = require('./supabaseClient.js');

let googleCertsCache = { expiresAt: 0, byKid: {} };
let appleKeysCache = { expiresAt: 0, byKid: {} };

function getGoogleClientIds() {
  return [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID_IOS,
    process.env.VITE_GOOGLE_CLIENT_ID,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function getAppleClientIds() {
  return [
    process.env.APPLE_CLIENT_ID,
    process.env.APPLE_CLIENT_ID_IOS,
    process.env.VITE_APPLE_CLIENT_ID,
  ]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function isGoogleAuthConfigured() {
  return getGoogleClientIds().length > 0;
}

function isAppleAuthConfigured() {
  return getAppleClientIds().length > 0;
}

function oauthPublicConfig() {
  return {
    googleClientId: getGoogleClientIds()[0] || '',
    appleClientId: getAppleClientIds()[0] || '',
    googleEnabled: isGoogleAuthConfigured(),
    appleEnabled: isAppleAuthConfigured(),
  };
}

function makeLoginFromEmail(email, provider) {
  const local = String(email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
  const base = local.length >= 3 ? local : `${provider}_user`;
  return `${base}_${crypto.randomBytes(2).toString('hex')}`;
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(String(part || ''), 'base64url').toString('utf8'));
}

function parseJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_jwt');
  return {
    header: decodeJwtPart(parts[0]),
    payload: decodeJwtPart(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

function pemFromModExp(n, e) {
  const nBuf = Buffer.from(n, 'base64url');
  const eBuf = Buffer.from(e, 'base64url');
  const encodeLen = (len) => {
    if (len < 0x80) return Buffer.from([len]);
    const bytes = [];
    let v = len;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const encodeInt = (buf) => {
    let b = buf;
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return Buffer.concat([Buffer.from([0x02]), encodeLen(b.length), b]);
  };
  const seq = Buffer.concat([encodeInt(nBuf), encodeInt(eBuf)]);
  const body = Buffer.concat([Buffer.from([0x30]), encodeLen(seq.length), seq]);
  const b64 = body.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN RSA PUBLIC KEY-----\n${b64}\n-----END RSA PUBLIC KEY-----\n`;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
  return res.json();
}

async function getGoogleCertPem(kid) {
  const now = Date.now();
  if (!googleCertsCache.byKid[kid] || googleCertsCache.expiresAt < now) {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/certs');
    if (!res.ok) throw new Error('google_certs_failed');
    const certs = await res.json();
    const age = Number(String(res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    googleCertsCache = {
      expiresAt: now + age * 1000,
      byKid: certs,
    };
  }
  const pem = googleCertsCache.byKid[kid];
  if (!pem) throw new Error('unknown_kid');
  return pem;
}

async function getApplePublicKey(kid) {
  const now = Date.now();
  if (!appleKeysCache.byKid[kid] || appleKeysCache.expiresAt < now) {
    const data = await fetchJson('https://appleid.apple.com/auth/keys');
    const byKid = {};
    for (const jwk of data.keys || []) {
      byKid[jwk.kid] = crypto.createPublicKey(pemFromModExp(jwk.n, jwk.e));
    }
    appleKeysCache = { expiresAt: now + 6 * 60 * 60 * 1000, byKid };
  }
  const key = appleKeysCache.byKid[kid];
  if (!key) throw new Error('unknown_kid');
  return key;
}

function assertAud(aud, allowed) {
  const values = Array.isArray(aud) ? aud : [aud];
  return values.some((v) => allowed.includes(String(v)));
}

async function verifyGoogleIdToken(idToken) {
  const audiences = getGoogleClientIds();
  if (!audiences.length) return { ok: false, error: 'google_not_configured' };
  try {
    const { header, payload, signingInput, signature } = parseJwt(idToken);
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, error: 'invalid_token' };
    const pem = await getGoogleCertPem(header.kid);
    const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), pem, signature);
    if (!ok) return { ok: false, error: 'invalid_token' };

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      return { ok: false, error: 'invalid_token' };
    }
    if (!assertAud(payload.aud, audiences)) return { ok: false, error: 'invalid_token' };
    if (payload.exp && Number(payload.exp) < now) return { ok: false, error: 'invalid_token' };
    if (!payload.sub) return { ok: false, error: 'invalid_token' };

    return {
      ok: true,
      googleId: String(payload.sub),
      email: payload.email || null,
      emailVerified: Boolean(payload.email_verified),
      name: payload.name || payload.given_name || null,
    };
  } catch (err) {
    console.error('[oauth] google verify:', err.message);
    return { ok: false, error: 'invalid_token' };
  }
}

async function verifyAppleIdToken(idToken, rawNonce) {
  const audiences = getAppleClientIds();
  if (!audiences.length) return { ok: false, error: 'apple_not_configured' };
  try {
    const { header, payload, signingInput, signature } = parseJwt(idToken);
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, error: 'invalid_token' };
    const key = await getApplePublicKey(header.kid);
    const ok = crypto.verify('RSA-SHA256', Buffer.from(signingInput), key, signature);
    if (!ok) return { ok: false, error: 'invalid_token' };

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== 'https://appleid.apple.com') return { ok: false, error: 'invalid_token' };
    if (!assertAud(payload.aud, audiences)) return { ok: false, error: 'invalid_token' };
    if (payload.exp && Number(payload.exp) < now) return { ok: false, error: 'invalid_token' };
    if (!payload.sub) return { ok: false, error: 'invalid_token' };

    if (rawNonce) {
      const expected = crypto.createHash('sha256').update(String(rawNonce)).digest('hex');
      if (payload.nonce && payload.nonce !== expected) {
        return { ok: false, error: 'invalid_nonce' };
      }
    }

    return {
      ok: true,
      appleId: String(payload.sub),
      email: payload.email ? String(payload.email).toLowerCase() : null,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      name: null,
    };
  } catch (err) {
    console.error('[oauth] apple verify:', err.message);
    return { ok: false, error: 'invalid_token' };
  }
}

async function findUserByOauth({ googleId, appleId, email }) {
  if (googleId) {
    for (const column of ['googleId', 'google_id']) {
      const { data, error } = await supabaseClient
        .from(USERS_TABLE)
        .select('*')
        .eq(column, googleId)
        .maybeSingle();
      if (!error && data) return mapUserRow(data);
    }
    try {
      const { findUserIdInOauthIndex } = require('./kv-store.js');
      const mappedId = await findUserIdInOauthIndex('google', googleId);
      if (mappedId) {
        const { data, error } = await supabaseClient.from(USERS_TABLE).select('*').eq('id', mappedId).maybeSingle();
        if (!error && data) return mapUserRow(data);
      }
    } catch (err) {
      console.warn('[oauth] index lookup:', err.message);
    }
  }
  if (appleId) {
    for (const column of ['appleId', 'apple_id']) {
      const { data, error } = await supabaseClient
        .from(USERS_TABLE)
        .select('*')
        .eq(column, appleId)
        .maybeSingle();
      if (!error && data) return mapUserRow(data);
    }
    try {
      const { findUserIdInOauthIndex } = require('./kv-store.js');
      const mappedId = await findUserIdInOauthIndex('apple', appleId);
      if (mappedId) {
        const { data, error } = await supabaseClient.from(USERS_TABLE).select('*').eq('id', mappedId).maybeSingle();
        if (!error && data) return mapUserRow(data);
      }
    } catch (err) {
      console.warn('[oauth] index lookup:', err.message);
    }
  }
  if (email) {
    const { data, error } = await supabaseClient
      .from(USERS_TABLE)
      .select('*')
      .eq('email', String(email).toLowerCase())
      .maybeSingle();
    if (!error && data) return mapUserRow(data);
  }
  return null;
}

async function attachOauthIds(userId, { googleId, appleId }) {
  if (googleId) {
    for (const column of ['googleId', 'google_id']) {
      const { error } = await supabaseClient
        .from(USERS_TABLE)
        .update({ [column]: googleId })
        .eq('id', userId);
      if (!error) break;
    }
  }
  if (appleId) {
    for (const column of ['appleId', 'apple_id']) {
      const { error } = await supabaseClient
        .from(USERS_TABLE)
        .update({ [column]: appleId })
        .eq('id', userId);
      if (!error) break;
    }
  }
}

async function insertUserWithOauth(user, { googleId, appleId } = {}) {
  const base = toUserRow(user);
  const attempts = [];
  if (googleId || appleId) {
    attempts.push({
      ...base,
      ...(googleId ? { google_id: googleId } : {}),
      ...(appleId ? { apple_id: appleId } : {}),
    });
    attempts.push({
      ...base,
      ...(googleId ? { googleId } : {}),
      ...(appleId ? { appleId } : {}),
    });
  }
  attempts.push(base);

  let lastError = null;
  for (const row of attempts) {
    const { error } = await supabaseClient.from(USERS_TABLE).insert(row);
    if (!error) {
      const storedOauth = Boolean(row.google_id || row.googleId || row.apple_id || row.appleId);
      if (!storedOauth && (googleId || appleId)) {
        console.warn(
          '[oauth] users table missing google_id/apple_id columns. Run supabase/migrations/009_oauth_ids.sql'
        );
      }
      return { storedOauth };
    }
    lastError = error;
    const msg = String(error.message || '');
    if (!/schema cache|column|google|apple/i.test(msg)) break;
  }
  throw new Error(lastError?.message || 'Не вдалося створити користувача');
}

async function createOauthUser({
  email,
  name,
  role,
  companyName,
  googleId,
  appleId,
}) {
  const bcrypt = require('bcryptjs');
  const loginBase = makeLoginFromEmail(email || name, googleId ? 'google' : 'apple');
  let login = loginBase;
  for (let i = 0; i < 5; i++) {
    const { data } = await supabaseClient.from(USERS_TABLE).select('id').eq('login', login).maybeSingle();
    if (!data) break;
    login = `${loginBase}${i + 1}`;
  }

  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const user = {
    id: crypto.randomUUID(),
    login,
    passwordHash,
    role: role === 'provider' ? 'provider' : 'client',
  };
  if (email) user.email = String(email).toLowerCase();
  if (googleId) user.googleId = googleId;
  if (appleId) user.appleId = appleId;

  await insertUserWithOauth(user, { googleId, appleId });
  try {
    const { linkOauthInIndex } = require('./kv-store.js');
    if (googleId) await linkOauthInIndex('google', googleId, user.id);
    if (appleId) await linkOauthInIndex('apple', appleId, user.id);
  } catch (err) {
    console.warn('[oauth] index link:', err.message);
  }

  return { user, companyName: role === 'provider' ? companyName || name || login : null };
}

async function signInWithGoogle({ idToken, role, companyName }) {
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) return verified;
  if (!verified.email || !verified.emailVerified) {
    return { ok: false, error: 'email_not_verified' };
  }

  let user = await findUserByOauth({
    googleId: verified.googleId,
    email: verified.email,
  });

  // Never allow elevating to admin via OAuth body; provider only with company intent from register.
  const safeRole = role === 'provider' && companyName ? 'provider' : 'client';

  let created = false;
  let profileCompany = null;
  if (!user) {
    const createdUser = await createOauthUser({
      email: verified.email,
      name: verified.name,
      role: safeRole,
      companyName,
      googleId: verified.googleId,
    });
    user = createdUser.user;
    profileCompany = createdUser.companyName;
    created = true;
  } else {
    await attachOauthIds(user.id, { googleId: verified.googleId });
    user.googleId = verified.googleId;
    try {
      const { linkOauthInIndex } = require('./kv-store.js');
      await linkOauthInIndex('google', verified.googleId, user.id);
    } catch (_) {
      /* ignore */
    }
  }

  return { ok: true, user, created, profileCompany, provider: 'google' };
}

async function signInWithApple({ idToken, rawNonce, role, companyName, name }) {
  if (!rawNonce) return { ok: false, error: 'invalid_nonce' };
  const verified = await verifyAppleIdToken(idToken, rawNonce);
  if (!verified.ok) return verified;
  if (verified.email && verified.emailVerified === false) {
    return { ok: false, error: 'email_not_verified' };
  }

  let user = await findUserByOauth({
    appleId: verified.appleId,
    email: verified.email,
  });

  const safeRole = role === 'provider' && companyName ? 'provider' : 'client';

  let created = false;
  let profileCompany = null;
  if (!user) {
    const createdUser = await createOauthUser({
      email: verified.email,
      name: name || verified.name,
      role: safeRole,
      companyName,
      appleId: verified.appleId,
    });
    user = createdUser.user;
    profileCompany = createdUser.companyName;
    created = true;
  } else {
    await attachOauthIds(user.id, { appleId: verified.appleId });
    user.appleId = verified.appleId;
    try {
      const { linkOauthInIndex } = require('./kv-store.js');
      await linkOauthInIndex('apple', verified.appleId, user.id);
    } catch (_) {
      /* ignore */
    }
  }

  return { ok: true, user, created, profileCompany, provider: 'apple' };
}

module.exports = {
  oauthPublicConfig,
  isGoogleAuthConfigured,
  isAppleAuthConfigured,
  signInWithGoogle,
  signInWithApple,
};
