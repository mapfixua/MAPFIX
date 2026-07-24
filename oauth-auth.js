'use strict';

const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { OAuth2Client } = require('google-auth-library');
const { supabaseClient, USERS_TABLE, mapUserRow, toUserRow } = require('./supabaseClient.js');

const googleClient = new OAuth2Client();
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

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

  const row = toUserRow(user);
  if (googleId) {
    row.googleId = googleId;
  }
  if (appleId) {
    row.appleId = appleId;
  }

  const { error } = await supabaseClient.from(USERS_TABLE).insert(row);
  if (error) {
    // Retry without oauth columns if migration not applied yet
    if (/google|apple/i.test(String(error.message || ''))) {
      const { error: err2 } = await supabaseClient.from(USERS_TABLE).insert(toUserRow(user));
      if (err2) throw new Error(err2.message);
    } else {
      throw new Error(error.message);
    }
  }

  return { user, companyName: role === 'provider' ? companyName || name || login : null };
}

async function verifyGoogleIdToken(idToken) {
  const audiences = getGoogleClientIds();
  if (!audiences.length) {
    return { ok: false, error: 'google_not_configured' };
  }
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: String(idToken || ''),
      audience: audiences.length === 1 ? audiences[0] : audiences,
    });
    const payload = ticket.getPayload() || {};
    if (!payload.sub) return { ok: false, error: 'invalid_token' };
    return {
      ok: true,
      googleId: payload.sub,
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
  if (!audiences.length) {
    return { ok: false, error: 'apple_not_configured' };
  }
  try {
    const { payload } = await jwtVerify(String(idToken || ''), appleJwks, {
      issuer: 'https://appleid.apple.com',
      audience: audiences,
    });
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

async function signInWithGoogle({ idToken, role, companyName }) {
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) return verified;

  let user = await findUserByOauth({
    googleId: verified.googleId,
    email: verified.email,
  });

  let created = false;
  let profileCompany = null;
  if (!user) {
    const createdUser = await createOauthUser({
      email: verified.email,
      name: verified.name,
      role,
      companyName,
      googleId: verified.googleId,
    });
    user = createdUser.user;
    profileCompany = createdUser.companyName;
    created = true;
  } else {
    await attachOauthIds(user.id, { googleId: verified.googleId });
    user.googleId = verified.googleId;
  }

  return { ok: true, user, created, profileCompany, provider: 'google' };
}

async function signInWithApple({ idToken, rawNonce, role, companyName, name }) {
  const verified = await verifyAppleIdToken(idToken, rawNonce);
  if (!verified.ok) return verified;

  let user = await findUserByOauth({
    appleId: verified.appleId,
    email: verified.email,
  });

  let created = false;
  let profileCompany = null;
  if (!user) {
    const createdUser = await createOauthUser({
      email: verified.email,
      name: name || verified.name,
      role,
      companyName,
      appleId: verified.appleId,
    });
    user = createdUser.user;
    profileCompany = createdUser.companyName;
    created = true;
  } else {
    await attachOauthIds(user.id, { appleId: verified.appleId });
    user.appleId = verified.appleId;
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
