const crypto = require('crypto');
const { supabaseClient, USERS_TABLE } = require('./supabaseClient.js');

const LINK_TOKENS_TABLE = 'telegram_link_tokens';
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) {
    return '+38' + digits;
  }
  if (digits.length === 9) {
    return '+380' + digits;
  }
  if (digits.startsWith('380') && digits.length >= 12) {
    return '+' + digits;
  }
  if (digits.startsWith('38') && digits.length >= 12) {
    return '+' + digits;
  }
  return digits.startsWith('+') ? digits : '+' + digits;
}

function generateLinkTokenValue() {
  return crypto.randomBytes(16).toString('hex');
}

async function updateUserPhone(userId, phone) {
  const { error } = await supabaseClient
    .from(USERS_TABLE)
    .update({ phone })
    .eq('id', userId);
  return error;
}

async function trySetUserTelegramId(userId, telegramId, linkedAt) {
  const chatId = Number(telegramId);
  const now = linkedAt || new Date().toISOString();

  const { error: snakeError } = await supabaseClient
    .from(USERS_TABLE)
    .update({ telegram_id: chatId, telegram_linked_at: now })
    .eq('id', userId);

  if (!snakeError) return { ok: true, mode: 'telegram_id' };

  const { error: camelError } = await supabaseClient
    .from(USERS_TABLE)
    .update({ telegramId: chatId, telegramLinkedAt: now })
    .eq('id', userId);

  if (!camelError) return { ok: true, mode: 'telegramId' };

  return {
    ok: false,
    error: snakeError?.message || camelError?.message || 'telegram_column_missing',
  };
}

/**
 * Resolve Telegram chat id for a phone.
 * Prefer users.telegram_id when present; otherwise fall back to last successful link token.
 */
async function getTelegramIdForPhone(phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  for (const column of ['telegram_id', 'telegramId']) {
    const { data: user, error: userError } = await supabaseClient
      .from(USERS_TABLE)
      .select(`id, ${column}`)
      .eq('phone', normalizedPhone)
      .maybeSingle();

    if (userError) continue;
    const value = user?.[column];
    if (value) return Number(value);
  }

  const { data: userByPhone } = await supabaseClient
    .from(USERS_TABLE)
    .select('id')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (userByPhone?.id) {
    const { data: byUser, error: byUserError } = await supabaseClient
      .from(LINK_TOKENS_TABLE)
      .select('telegram_id')
      .eq('user_id', userByPhone.id)
      .not('telegram_id', 'is', null)
      .not('used_at', 'is', null)
      .order('used_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!byUserError && byUser?.telegram_id) {
      return Number(byUser.telegram_id);
    }
  }

  const { data: linkRow, error: linkError } = await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .select('telegram_id')
    .eq('phone', normalizedPhone)
    .not('telegram_id', 'is', null)
    .not('used_at', 'is', null)
    .order('used_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (linkError) {
    console.error('[telegram-auth] link token lookup:', linkError.message);
    return null;
  }

  return linkRow?.telegram_id ? Number(linkRow.telegram_id) : null;
}

async function findLinkedUserIdByTelegramId(telegramId) {
  const chatId = Number(telegramId);
  if (!Number.isFinite(chatId)) return null;

  for (const column of ['telegram_id', 'telegramId']) {
    const { data: user, error: userError } = await supabaseClient
      .from(USERS_TABLE)
      .select('id')
      .eq(column, chatId)
      .maybeSingle();

    if (!userError && user?.id) return user.id;
  }

  const { data: linkRow, error: linkError } = await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .select('user_id')
    .eq('telegram_id', chatId)
    .not('used_at', 'is', null)
    .order('used_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (linkError) {
    console.error('[telegram-auth] telegram owner lookup:', linkError.message);
    return null;
  }

  return linkRow?.user_id ?? null;
}

async function createTelegramLinkToken({ userId, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!userId || !normalizedPhone) {
    throw new Error('userId and phone are required');
  }
  if (normalizedPhone.replace(/\D/g, '').length < 10) {
    throw new Error('invalid phone');
  }

  const phoneError = await updateUserPhone(userId, normalizedPhone);
  if (phoneError) {
    if (phoneError.code === '23505') {
      throw new Error('phone_or_telegram_conflict');
    }
    throw new Error(phoneError.message);
  }

  // Invalidate unused prior tokens for this user so only the latest link works.
  await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .delete()
    .eq('user_id', userId)
    .is('used_at', null);

  const token = generateLinkTokenValue();
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();

  const { error } = await supabaseClient.from(LINK_TOKENS_TABLE).insert({
    token,
    user_id: userId,
    phone: normalizedPhone,
    expires_at: expiresAt,
  });

  if (error) throw new Error(error.message);
  return { token, expiresAt, phone: normalizedPhone };
}

function getTelegramBotLink(token) {
  const username = process.env.TELEGRAM_BOT_USERNAME || '';
  const clean = String(username).replace(/^@/, '');
  if (!clean) {
    return `https://t.me/YourBot?start=link_${token}`;
  }
  return `https://t.me/${clean}?start=link_${token}`;
}

async function consumeTelegramLinkToken(token, telegramId) {
  const cleanToken = String(token || '').trim();
  const chatId = Number(telegramId);
  if (!cleanToken || !Number.isFinite(chatId)) {
    return { ok: false, error: 'invalid_payload' };
  }

  console.log('[telegram-auth] consume link token', {
    telegram_id: chatId,
    token_prefix: cleanToken.slice(0, 8),
  });

  const { data: linkRow, error: linkError } = await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .select('*')
    .eq('token', cleanToken)
    .maybeSingle();

  if (linkError) {
    console.error('[telegram-auth] link lookup:', linkError.message);
    return { ok: false, error: 'db_error' };
  }

  if (!linkRow) {
    return { ok: false, error: 'token_not_found' };
  }

  if (linkRow.used_at) {
    return { ok: false, error: 'token_already_used' };
  }

  if (new Date(linkRow.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'token_expired' };
  }

  const existingOwnerId = await findLinkedUserIdByTelegramId(chatId);
  if (existingOwnerId && existingOwnerId !== linkRow.user_id) {
    return { ok: false, error: 'telegram_already_linked' };
  }

  const now = new Date().toISOString();

  const phoneError = await updateUserPhone(linkRow.user_id, linkRow.phone);
  if (phoneError) {
    if (phoneError.code === '23505') {
      return { ok: false, error: 'phone_or_telegram_conflict' };
    }
    console.error('[telegram-auth] user phone update:', phoneError.message);
    return { ok: false, error: 'db_error' };
  }

  const telegramColResult = await trySetUserTelegramId(linkRow.user_id, chatId, now);
  if (!telegramColResult.ok) {
    console.warn(
      '[telegram-auth] users.telegram_id columns missing; binding via telegram_link_tokens only:',
      telegramColResult.error
    );
  }

  // Critical: persist telegram_id on the token so OTP can resolve chat without users.telegram_id
  const { error: markUsedError } = await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .update({ used_at: now, telegram_id: chatId })
    .eq('id', linkRow.id)
    .is('used_at', null);

  if (markUsedError) {
    console.error('[telegram-auth] mark token used:', markUsedError.message);
    return { ok: false, error: 'db_error' };
  }

  const { data: user } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login, phone, role')
    .eq('id', linkRow.user_id)
    .maybeSingle();

  return { ok: true, user, phone: linkRow.phone, telegramId: chatId };
}

module.exports = {
  normalizePhone,
  updateUserPhone,
  getTelegramIdForPhone,
  findLinkedUserIdByTelegramId,
  createTelegramLinkToken,
  getTelegramBotLink,
  consumeTelegramLinkToken,
  LINK_TOKEN_TTL_MS,
  LINK_TOKENS_TABLE,
};
