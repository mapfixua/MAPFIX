const crypto = require('crypto');
const { supabaseClient, USERS_TABLE, mapUserRow } = require('./supabaseClient.js');
const { normalizePhone, getTelegramIdForPhone } = require('./telegram-auth.js');

const OTP_CODES_TABLE = 'otp_codes';
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

function hashOtpCode(code, phone, secret) {
  return crypto.createHmac('sha256', String(secret || '')).update(`${phone}:${code}`).digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function codesMatch(storedHash, code, phone, secret) {
  const expected = hashOtpCode(code, phone, secret);
  const stored = String(storedHash || '');
  if (stored.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

async function findUserByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login, role, phone, passwordHash')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const user = mapUserRow(data);
  if (!user.telegramId) {
    user.telegramId = await getTelegramIdForPhone(normalizedPhone);
  }
  return user;
}

async function invalidateActiveOtps(phone) {
  const now = new Date().toISOString();
  const { error } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .update({ consumed_at: now })
    .eq('phone', phone)
    .is('consumed_at', null);

  if (error) throw new Error(error.message);
}

async function cancelOtpById(id) {
  if (!id) return;
  const { error } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('[otp-auth] cancel otp:', error.message);
  }
}

async function requestOtp(phone, secret) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
    return { ok: false, error: 'invalid_phone' };
  }

  const user = await findUserByPhone(normalizedPhone);
  if (!user) {
    return { ok: false, error: 'user_not_found' };
  }
  const telegramId = user.telegramId || (await getTelegramIdForPhone(normalizedPhone));
  if (!telegramId) {
    return { ok: false, error: 'telegram_not_linked' };
  }

  const cooldownSince = new Date(Date.now() - OTP_RESEND_COOLDOWN_MS).toISOString();
  const { data: recentOtp, error: recentError } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .select('id, created_at')
    .eq('phone', normalizedPhone)
    .gte('created_at', cooldownSince)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recentError) {
    console.error('[otp-auth] cooldown lookup:', recentError.message);
    return { ok: false, error: 'db_error' };
  }
  if (recentOtp) {
    return { ok: false, error: 'too_many_requests' };
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code, normalizedPhone, secret);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  await invalidateActiveOtps(normalizedPhone);

  const { data: inserted, error: insertError } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .insert({
      phone: normalizedPhone,
      code_hash: codeHash,
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();

  if (insertError) {
    console.error('[otp-auth] insert otp:', insertError.message);
    return { ok: false, error: 'db_error' };
  }

  console.log('[otp-auth] OTP created', {
    user_id: user.id,
    phone: normalizedPhone,
    otp_id: inserted.id,
  });

  return {
    ok: true,
    code,
    otpId: inserted.id,
    expiresAt: inserted.expires_at,
    phone: normalizedPhone,
    user,
  };
}

async function verifyOtp(phone, code, secret) {
  const normalizedPhone = normalizePhone(phone);
  const cleanCode = String(code || '').trim();

  if (!normalizedPhone || normalizedPhone.replace(/\D/g, '').length < 10) {
    return { ok: false, error: 'invalid_phone' };
  }
  if (!/^\d{6}$/.test(cleanCode)) {
    return { ok: false, error: 'invalid_code' };
  }

  const { data: otpRow, error: lookupError } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .select('*')
    .eq('phone', normalizedPhone)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.error('[otp-auth] verify lookup:', lookupError.message);
    return { ok: false, error: 'db_error' };
  }

  if (!otpRow) {
    return { ok: false, error: 'code_not_found' };
  }

  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    await cancelOtpById(otpRow.id);
    return { ok: false, error: 'code_expired' };
  }

  if (otpRow.attempts >= otpRow.max_attempts) {
    await cancelOtpById(otpRow.id);
    return { ok: false, error: 'too_many_attempts' };
  }

  if (!codesMatch(otpRow.code_hash, cleanCode, normalizedPhone, secret)) {
    const nextAttempts = otpRow.attempts + 1;
    const updates = { attempts: nextAttempts };
    if (nextAttempts >= otpRow.max_attempts) {
      updates.consumed_at = new Date().toISOString();
    }

    const { error: attemptError } = await supabaseClient
      .from(OTP_CODES_TABLE)
      .update(updates)
      .eq('id', otpRow.id);

    if (attemptError) {
      console.error('[otp-auth] increment attempts:', attemptError.message);
    }

    return {
      ok: false,
      error: nextAttempts >= otpRow.max_attempts ? 'too_many_attempts' : 'invalid_code',
    };
  }

  const now = new Date().toISOString();
  const { error: consumeError } = await supabaseClient
    .from(OTP_CODES_TABLE)
    .update({ consumed_at: now })
    .eq('id', otpRow.id);

  if (consumeError) {
    console.error('[otp-auth] consume otp:', consumeError.message);
    return { ok: false, error: 'db_error' };
  }

  const user = await findUserByPhone(normalizedPhone);
  if (!user) {
    return { ok: false, error: 'user_not_found' };
  }

  console.log('[otp-auth] OTP verified', {
    user_id: user.id,
    phone: normalizedPhone,
    otp_id: otpRow.id,
  });

  return { ok: true, user, phone: normalizedPhone };
}

module.exports = {
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  requestOtp,
  verifyOtp,
  cancelOtpById,
  findUserByPhone,
};
