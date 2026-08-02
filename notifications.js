'use strict';

const { getTelegramBot } = require('./telegram-bot.js');
const { supabaseClient, USERS_TABLE, mapUserRow } = require('./supabaseClient.js');

async function sendTelegramToChatId(chatId, text) {
  const bot = getTelegramBot();
  if (!bot || !chatId) return { ok: false, error: 'not_configured' };
  try {
    await bot.telegram.sendMessage(chatId, String(text || '').slice(0, 3500));
    return { ok: true };
  } catch (err) {
    console.warn('[notify] telegram:', err.message);
    return { ok: false, error: err.message };
  }
}

async function sendTelegramToUserId(userId, text) {
  if (!userId) return { ok: false, error: 'no_user' };
  const { data, error } = await supabaseClient
    .from(USERS_TABLE)
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: 'user_not_found' };
  const user = mapUserRow(data);
  const telegramId = user?.telegramId;
  if (!telegramId) return { ok: false, error: 'telegram_not_linked' };
  return sendTelegramToChatId(telegramId, text);
}

async function sendAppEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  const from =
    process.env.RESET_EMAIL_FROM || process.env.EMAIL_FROM || 'Mapfix <onboarding@resend.dev>';
  if (!resendKey || !to) return { ok: false, error: 'email_not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) {
      console.warn('[notify] email:', await res.text());
      return { ok: false, error: 'send_failed' };
    }
    return { ok: true, provider: 'resend' };
  } catch (err) {
    console.warn('[notify] email error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyNewOrder({ providerId, clientLogin, locationTitle, serviceName, preferredAt, note }) {
  const lines = [
    '🆕 Нове замовлення Mapfix',
    '',
    `Послуга: ${serviceName}`,
    `Точка: ${locationTitle || '—'}`,
    `Клієнт: ${clientLogin || '—'}`,
  ];
  if (preferredAt) lines.push(`Бажаний час: ${preferredAt}`);
  if (note) lines.push(`Коментар: ${note}`);
  lines.push('', 'Відкрийте кабінет майстра → Замовлення.');
  const text = lines.join('\n');
  const tg = await sendTelegramToUserId(providerId, text);

  let emailResult = { ok: false };
  try {
    const { data } = await supabaseClient
      .from(USERS_TABLE)
      .select('*')
      .eq('id', providerId)
      .maybeSingle();
    const user = mapUserRow(data || {});
    if (user?.email) {
      emailResult = await sendAppEmail({
        to: user.email,
        subject: 'Нове замовлення Mapfix',
        html: `<p>${text.replace(/\n/g, '<br>')}</p>`,
      });
    }
  } catch (_) {}

  return { telegram: tg, email: emailResult };
}

async function notifyOrderStatus({ clientId, serviceName, status, locationTitle }) {
  const text = [
    '📦 Оновлення замовлення Mapfix',
    '',
    `Послуга: ${serviceName}`,
    `Точка: ${locationTitle || '—'}`,
    `Статус: ${status}`,
  ].join('\n');
  return sendTelegramToUserId(clientId, text);
}

module.exports = {
  sendTelegramToChatId,
  sendTelegramToUserId,
  sendAppEmail,
  notifyNewOrder,
  notifyOrderStatus,
};
