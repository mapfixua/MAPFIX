const { Telegraf } = require('telegraf');
const {
  consumeTelegramLinkToken,
  getTelegramBotLink,
  normalizePhone,
} = require('./telegram-auth.js');
const { supabaseClient, USERS_TABLE } = require('./supabaseClient.js');

const WEBHOOK_PATH = '/api/telegram/webhook';

let botInstance = null;

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function getBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
}

function extractLinkToken(ctx) {
  const fromPayload = String(ctx.startPayload || '').trim();
  if (fromPayload.startsWith('link_')) {
    return fromPayload.slice('link_'.length);
  }

  const text = String(ctx.message?.text || '').trim();
  const startMatch = text.match(/^\/start(?:@\w+)?\s+link_(.+)$/i);
  if (startMatch) {
    return startMatch[1].trim();
  }

  return null;
}

function buildBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  const bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const chatId = ctx.chat?.id;
    const telegramId = ctx.from?.id;
    const linkToken = extractLinkToken(ctx);
    const username = getBotUsername();

    console.log('[telegram] /start', {
      chat_id: chatId,
      telegram_id: telegramId,
      has_link_token: Boolean(linkToken),
    });

    if (!linkToken) {
      await ctx.reply(
        [
          '👋 Вітаємо в Mapfix Bot!',
          '',
          'Цей бот надсилає коди входу на платформу Mapfix.',
          '',
          'Щоб підключити Telegram:',
          '1. Увійдіть на сайт Mapfix і вкажіть номер телефону.',
          '2. Натисніть «Підключити Telegram» — відкриється посилання з кодом.',
          '3. Натисніть Start у цьому чаті.',
          '',
          username ? `Бот: @${username}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
      return;
    }

    console.log('[telegram] linking token', {
      telegram_id: telegramId,
      token_prefix: linkToken.slice(0, 8),
    });

    const result = await consumeTelegramLinkToken(linkToken, telegramId);

    if (!result.ok) {
      console.warn('[telegram] link failed', { error: result.error, telegram_id: telegramId });
      const messages = {
        token_not_found: '❌ Посилання недійсне. Отримайте нове на сайті Mapfix.',
        token_expired: '⏰ Посилання прострочене. Отримайте нове на сайті Mapfix.',
        token_already_used:
          'ℹ️ Це посилання вже використано. Telegram уже підключено або потрібне нове посилання.',
        telegram_already_linked:
          '⚠️ Цей Telegram-акаунт уже привʼязаний до іншого профілю Mapfix.',
        phone_or_telegram_conflict:
          '⚠️ Цей номер або Telegram вже використовується іншим акаунтом.',
        invalid_payload: '❌ Некоректне посилання.',
        db_error: '❌ Помилка сервера. Спробуйте пізніше.',
      };
      await ctx.reply(messages[result.error] || '❌ Не вдалося підключити акаунт.');
      return;
    }

    console.log('[telegram] link success', {
      telegram_id: telegramId,
      user_id: result.user?.id,
      phone: result.phone,
    });

    await ctx.reply(
      [
        '✅ Telegram успішно підключено до Mapfix!',
        '',
        `📱 Телефон: ${result.phone}`,
        result.user?.login ? `👤 Профіль: ${result.user.login}` : '',
        '',
        'Тепер ви можете отримувати коди входу прямо в Telegram.',
      ]
        .filter(Boolean)
        .join('\n')
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      [
        'Mapfix Bot — коди входу без пароля.',
        '',
        '/start — інструкція або підключення акаунта',
        '',
        'Підключення: на сайті Mapfix натисніть «Підключити Telegram» і відкрийте посилання.',
      ].join('\n')
    );
  });

  bot.catch((err, ctx) => {
    console.error('[telegram-bot] handler error:', err);
    if (ctx?.reply) {
      ctx.reply('❌ Сталася помилка. Спробуйте ще раз.').catch(() => {});
    }
  });

  return bot;
}

function getTelegramBot() {
  if (!isTelegramConfigured()) return null;
  if (!botInstance) {
    botInstance = buildBot();
  }
  return botInstance;
}

async function handleTelegramWebhookUpdate(req, res) {
  const update = req.body;

  if (!update || typeof update.update_id !== 'number') {
    console.warn('[telegram] webhook: invalid payload', {
      has_body: Boolean(req.body),
      content_type: req.headers['content-type'],
    });
    return res.status(400).json({ ok: false, error: 'invalid_update' });
  }

  const message = update.message || update.edited_message;
  console.log('[telegram] webhook update', {
    update_id: update.update_id,
    chat_id: message?.chat?.id,
    telegram_id: message?.from?.id,
    text: message?.text,
  });

  const bot = getTelegramBot();
  if (!bot) {
    return res.status(503).json({ ok: false, error: 'bot_not_configured' });
  }

  await bot.handleUpdate(update, res);
}

function mountTelegramWebhook(app) {
  app.post(WEBHOOK_PATH, async (req, res) => {
    try {
      await handleTelegramWebhookUpdate(req, res);
    } catch (err) {
      console.error('[telegram] webhook handler error:', err);
      if (!res.headersSent) {
        res.sendStatus(500);
      }
    }
  });

  app.get(WEBHOOK_PATH, (_req, res) => {
    res.json({
      ok: true,
      message: 'Mapfix Telegram webhook. Telegram sends POST updates here.',
      configured: isTelegramConfigured(),
    });
  });
}

async function setTelegramWebhook(publicBaseUrl) {
  const bot = getTelegramBot();
  if (!bot || !publicBaseUrl) return null;

  const url = `${String(publicBaseUrl).replace(/\/$/, '')}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(url);
  return url;
}

async function sendOtpToTelegram(phone, code) {
  const normalizedPhone = normalizePhone(phone);
  const otpCode = String(code || '').trim();

  if (!normalizedPhone) {
    return { ok: false, error: 'invalid_phone' };
  }
  if (!/^\d{4,8}$/.test(otpCode)) {
    return { ok: false, error: 'invalid_code' };
  }

  const { data: user, error: lookupError } = await supabaseClient
    .from(USERS_TABLE)
    .select('id, telegram_id, phone')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (lookupError) {
    console.error('[telegram] OTP user lookup:', lookupError.message);
    return { ok: false, error: 'db_error' };
  }

  if (!user?.telegram_id) {
    return { ok: false, error: 'telegram_not_linked' };
  }

  const bot = getTelegramBot();
  if (!bot) {
    return { ok: false, error: 'bot_not_configured' };
  }

  try {
    await bot.telegram.sendMessage(
      user.telegram_id,
      [
        '🔐 Код входу Mapfix',
        '',
        otpCode,
        '',
        'Код дійсний обмежений час. Нікому не повідомляйте його.',
      ].join('\n')
    );
    console.log('[telegram] OTP sent', {
      user_id: user.id,
      telegram_id: user.telegram_id,
      phone: normalizedPhone,
    });
    return { ok: true, telegramId: user.telegram_id };
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err.message);
    return { ok: false, error: 'send_failed' };
  }
}

module.exports = {
  WEBHOOK_PATH,
  isTelegramConfigured,
  getTelegramBot,
  handleTelegramWebhookUpdate,
  mountTelegramWebhook,
  getTelegramBotLink,
  setTelegramWebhook,
  sendOtpToTelegram,
};
