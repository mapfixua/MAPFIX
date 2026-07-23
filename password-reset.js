'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { supabaseClient, USERS_TABLE, mapUserRow } = require('./supabaseClient.js');
const { normalizePhone } = require('./telegram-auth.js');
const otpAuth = require('./otp-auth.js');

const RESET_TOKENS_TABLE = 'password_reset_tokens';
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function updateUserPassword(userId, newPassword) {
  if (!userId || String(newPassword || '').length < 6) {
    return { ok: false, error: 'invalid_password' };
  }
  const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
  const { error } = await supabaseClient
    .from(USERS_TABLE)
    .update({ passwordHash })
    .eq('id', userId);

  if (error) {
    console.error('[password-reset] update password:', error.message);
    return { ok: false, error: 'db_error' };
  }
  return { ok: true };
}

async function findUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login, role, phone, email, passwordHash')
    .eq('email', normalized)
    .maybeSingle();

  if (error) {
    if (String(error.message).includes('email')) {
      return { missingColumn: true };
    }
    throw new Error(error.message);
  }
  return data ? mapUserRow({ ...data, email: data.email }) : null;
}

/**
 * Step 1 (phone): create OTP and return code for Telegram send (caller sends).
 */
async function requestPasswordResetByPhone(phone, secret) {
  return otpAuth.requestOtp(phone, secret);
}

/**
 * Step 2 (phone): verify OTP and set new password.
 */
async function resetPasswordByPhone({ phone, code, newPassword, secret }) {
  if (String(newPassword || '').length < 6) {
    return { ok: false, error: 'invalid_password' };
  }

  const verify = await otpAuth.verifyOtp(phone, code, secret);
  if (!verify.ok) return verify;

  const updated = await updateUserPassword(verify.user.id, newPassword);
  if (!updated.ok) return updated;

  return { ok: true, user: verify.user, phone: verify.phone };
}

async function createEmailResetToken(userId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  await supabaseClient
    .from(RESET_TOKENS_TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null);

  const { error } = await supabaseClient.from(RESET_TOKENS_TABLE).insert({
    user_id: userId,
    email: normalizeEmail(email),
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  if (error) {
    console.error('[password-reset] insert token:', error.message);
    if (String(error.message).includes('password_reset_tokens')) {
      return { ok: false, error: 'table_missing' };
    }
    return { ok: false, error: 'db_error' };
  }

  return { ok: true, token, expiresAt };
}

async function sendResetEmail({ to, resetUrl }) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESET_EMAIL_FROM || process.env.EMAIL_FROM || 'Mapfix <onboarding@resend.dev>';

  if (resendKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: 'Відновлення пароля Mapfix',
        html: `
          <p>Ви запросили відновлення пароля на Mapfix.</p>
          <p><a href="${resetUrl}">Натисніть тут, щоб встановити новий пароль</a></p>
          <p>Посилання дійсне 30 хвилин. Якщо це були не ви — ігноруйте лист.</p>
        `,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[password-reset] Resend error:', body);
      return { ok: false, error: 'send_failed' };
    }
    return { ok: true, provider: 'resend' };
  }

  // Dev fallback: log link (do not expose in API response)
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    console.log('[password-reset] DEV email link for', to, '→', resetUrl);
    return { ok: true, provider: 'dev_log' };
  }

  return { ok: false, error: 'email_not_configured' };
}

/**
 * Request reset by email. Always returns generic ok to avoid account enumeration,
 * except hard config errors.
 */
async function requestPasswordResetByEmail(email, publicBaseUrl) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ok: false, error: 'invalid_email' };
  }

  let user;
  try {
    user = await findUserByEmail(normalized);
  } catch (err) {
    return { ok: false, error: 'db_error' };
  }

  if (user?.missingColumn) {
    return { ok: false, error: 'email_column_missing' };
  }

  // Generic success when user not found (privacy)
  if (!user) {
    return { ok: true, sent: false };
  }

  const created = await createEmailResetToken(user.id, normalized);
  if (!created.ok) return created;

  const base = String(publicBaseUrl || '').replace(/\/$/, '') || 'http://localhost:3000';
  const resetUrl = `${base}/reset-password.html?token=${encodeURIComponent(created.token)}`;

  const sent = await sendResetEmail({ to: normalized, resetUrl });
  if (!sent.ok) return sent;

  return { ok: true, sent: true, expiresAt: created.expiresAt };
}

async function resetPasswordByEmailToken({ token, newPassword }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) return { ok: false, error: 'invalid_token' };
  if (String(newPassword || '').length < 6) {
    return { ok: false, error: 'invalid_password' };
  }

  const tokenHash = hashToken(cleanToken);
  const { data: row, error } = await supabaseClient
    .from(RESET_TOKENS_TABLE)
    .select('*')
    .eq('token_hash', tokenHash)
    .is('used_at', null)
    .maybeSingle();

  if (error) {
    console.error('[password-reset] token lookup:', error.message);
    return { ok: false, error: 'db_error' };
  }
  if (!row) return { ok: false, error: 'invalid_token' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'token_expired' };
  }

  const updated = await updateUserPassword(row.user_id, newPassword);
  if (!updated.ok) return updated;

  await supabaseClient
    .from(RESET_TOKENS_TABLE)
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id);

  const { data: user } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login, role, phone, email')
    .eq('id', row.user_id)
    .maybeSingle();

  return { ok: true, user: mapUserRow(user) };
}

module.exports = {
  normalizeEmail,
  isValidEmail,
  requestPasswordResetByPhone,
  resetPasswordByPhone,
  requestPasswordResetByEmail,
  resetPasswordByEmailToken,
  findUserByEmail,
  updateUserPassword,
};
