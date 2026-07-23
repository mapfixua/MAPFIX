const { Telegraf } = require('telegraf');
const {
  consumeTelegramLinkToken,
  getTelegramBotLink,
  getTelegramIdForPhone,
  normalizePhone,
} = require('./telegram-auth.js');
const { supabaseClient, USERS_TABLE } = require('./supabaseClient.js');

const WEBHOOK_PATH = '/api/telegram/webhook';

let botInstance = null;
let pollingStarted = false;

function isTelegramConfigured() {
  return Boolean(String(process.env.TELEGRAM_BOT_TOKEN || '').trim());
}

function getBotUsername() {
  return String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
}

function getPublicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//, '')}`;
  }
  return '';
}

function shouldUsePolling() {
  if (!isTelegramConfigured()) return false;
  if (String(process.env.TELEGRAM_MODE || '').toLowerCase() === 'webhook') return false;
  if (String(process.env.TELEGRAM_MODE || '').toLowerCase() === 'polling') return true;
  // Local/dev: polling works without a public HTTPS URL. Vercel: webhook only.
  return !process.env.VERCEL;
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
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
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
          '1. Увійдіть на сайт Mapfix.',
          '2. Відкрийте «Підключити Telegram» і вкажіть номер телефону.',
          '3. Натисніть Start у цьому чаті за посиланням із сайту.',
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
        'Підключення: на сайті Mapfix відкрийте «Підключити Telegram».',
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
      mode: shouldUsePolling() ? 'polling' : 'webhook',
      username: getBotUsername() || null,
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

/**
 * Start bot delivery:
 * - local/dev → long polling (works without public HTTPS)
 * - Vercel / TELEGRAM_MODE=webhook → setWebhook to PUBLIC_BASE_URL / VERCEL_URL
 */
async function startTelegramBotRuntime() {
  if (!isTelegramConfigured()) {
    console.warn(
      '[telegram] TELEGRAM_BOT_TOKEN not set — OTP/link bot disabled. Add TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME to .env'
    );
    return { ok: false, reason: 'not_configured' };
  }

  const bot = getTelegramBot();
  if (!bot) return { ok: false, reason: 'not_configured' };

  if (shouldUsePolling()) {
    if (pollingStarted) return { ok: true, mode: 'polling' };
    try {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      // Telegraf: launch() Promise resolves only when the bot STOPS — do not await it.
      bot.launch({ dropPendingUpdates: false }).catch((err) => {
        pollingStarted = false;
        console.error('[telegram] Polling crashed:', err.message);
      });
      pollingStarted = true;
      console.log(
        `[telegram] Polling started (local). Bot: @${getBotUsername() || 'unknown'}`
      );
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
      return { ok: true, mode: 'polling' };
    } catch (err) {
      console.error('[telegram] Failed to start polling:', err.message);
      return { ok: false, reason: 'polling_failed', error: err.message };
    }
  }

  const base = getPublicBaseUrl();
  if (!base) {
    console.warn(
      '[telegram] Webhook mode but PUBLIC_BASE_URL / VERCEL_URL is empty — set PUBLIC_BASE_URL=https://your-domain'
    );
    return { ok: false, reason: 'missing_public_url' };
  }

  try {
    const url = await setTelegramWebhook(base);
    console.log('[telegram] Webhook registered:', url);
    return { ok: true, mode: 'webhook', url };
  } catch (err) {
    console.error('[telegram] setWebhook failed:', err.message);
    return { ok: false, reason: 'webhook_failed', error: err.message };
  }
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
    .select('id, phone')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (lookupError) {
    console.error('[telegram] OTP user lookup:', lookupError.message);
    return { ok: false, error: 'db_error' };
  }

  if (!user?.id) {
    return { ok: false, error: 'user_not_found' };
  }

  const telegramId = await getTelegramIdForPhone(normalizedPhone);
  if (!telegramId) {
    return { ok: false, error: 'telegram_not_linked' };
  }

  const bot = getTelegramBot();
  if (!bot) {
    return { ok: false, error: 'bot_not_configured' };
  }

  try {
    await bot.telegram.sendMessage(
      telegramId,
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
      telegram_id: telegramId,
      phone: normalizedPhone,
    });
    return { ok: true, telegramId };
  } catch (err) {
    console.error('[telegram] sendMessage failed:', err.message);
    return { ok: false, error: 'send_failed' };
  }
}

function getTelegramStatus() {
  const configured = isTelegramConfigured();
  return {
    configured,
    username: getBotUsername() || null,
    mode: configured ? (shouldUsePolling() ? 'polling' : 'webhook') : null,
    publicBaseUrl: getPublicBaseUrl() || null,
    webhookPath: WEBHOOK_PATH,
    pollingStarted,
  };
}

module.exports = {
  WEBHOOK_PATH,
  isTelegramConfigured,
  getTelegramBot,
  handleTelegramWebhookUpdate,
  mountTelegramWebhook,
  getTelegramBotLink,
  setTelegramWebhook,
  startTelegramBotRuntime,
  sendOtpToTelegram,
  getTelegramStatus,
};
