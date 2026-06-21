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
  if (digits.startsWith('380')) {
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

async function createTelegramLinkToken({ userId, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!userId || !normalizedPhone) {
    throw new Error('userId and phone are required');
  }

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

  const { data: existingTelegramUser } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (existingTelegramUser && existingTelegramUser.id !== linkRow.user_id) {
    return { ok: false, error: 'telegram_already_linked' };
  }

  const now = new Date().toISOString();

  const { error: userError } = await supabaseClient
    .from(USERS_TABLE)
    .update({
      phone: linkRow.phone,
      telegram_id: chatId,
      telegram_linked_at: now,
    })
    .eq('id', linkRow.user_id);

  if (userError) {
    if (userError.code === '23505') {
      return { ok: false, error: 'phone_or_telegram_conflict' };
    }
    console.error('[telegram-auth] user update:', userError.message);
    return { ok: false, error: 'db_error' };
  }

  const { error: markUsedError } = await supabaseClient
    .from(LINK_TOKENS_TABLE)
    .update({ used_at: now, telegram_id: chatId })
    .eq('id', linkRow.id);

  if (markUsedError) {
    console.error('[telegram-auth] mark token used:', markUsedError.message);
  }

  const { data: user } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, login, phone, role')
    .eq('id', linkRow.user_id)
    .maybeSingle();

  return { ok: true, user, phone: linkRow.phone };
}

module.exports = {
  normalizePhone,
  createTelegramLinkToken,
  getTelegramBotLink,
  consumeTelegramLinkToken,
  LINK_TOKEN_TTL_MS,
};
