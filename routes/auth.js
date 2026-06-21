const express = require('express');
const otpAuth = require('../otp-auth.js');
const { sendOtpToTelegram } = require('../telegram-bot.js');
const { setAuthCookie } = require('../auth-jwt.js');

const OTP_ERROR_MESSAGES = {
  invalid_phone: 'Вкажіть коректний номер телефону',
  invalid_code: 'Невірний код',
  user_not_found: 'Користувача з таким номером не знайдено',
  telegram_not_linked: 'Спочатку підключіть Telegram через бота',
  bot_not_configured: 'Telegram-бот не налаштовано',
  send_failed: 'Не вдалося надіслати код у Telegram',
  too_many_requests: 'Зачекайте хвилину перед повторним запитом коду',
  too_many_attempts: 'Перевищено кількість спроб. Запросіть новий код',
  code_not_found: 'Код не знайдено. Запросіть новий',
  code_expired: 'Код прострочений. Запросіть новий',
  db_error: 'Помилка сервера. Спробуйте пізніше',
};

function otpErrorStatus(error) {
  switch (error) {
    case 'invalid_phone':
    case 'invalid_code':
    case 'code_expired':
      return 400;
    case 'user_not_found':
    case 'code_not_found':
      return 404;
    case 'telegram_not_linked':
      return 403;
    case 'too_many_requests':
    case 'too_many_attempts':
      return 429;
    case 'bot_not_configured':
    case 'send_failed':
    case 'db_error':
      return 503;
    default:
      return 400;
  }
}

function otpErrorResponse(res, error, status) {
  return res.status(status).json({
    ok: false,
    error,
    message: OTP_ERROR_MESSAGES[error] || 'Помилка авторизації',
  });
}

function resolveJwtSecret(explicitSecret) {
  return (
    explicitSecret ||
    process.env.JWT_SECRET ||
    process.env.SESSION_SECRET ||
    'mapfix-dev-secret-change-in-production'
  );
}

function createAuthRouter({ jwtSecret, toPublicUserWithProfile, readData }) {
  const router = express.Router();
  const secret = resolveJwtSecret(jwtSecret);

  router.post('/otp/request', async (req, res) => {
    try {
      const phone = req.body?.phone;
      const otpResult = await otpAuth.requestOtp(phone, secret);

      if (!otpResult.ok) {
        return otpErrorResponse(res, otpResult.error, otpErrorStatus(otpResult.error));
      }

      const sendResult = await sendOtpToTelegram(otpResult.phone, otpResult.code);
      if (!sendResult.ok) {
        await otpAuth.cancelOtpById(otpResult.otpId);
        return otpErrorResponse(res, sendResult.error, 503);
      }

      res.json({
        ok: true,
        expiresAt: otpResult.expiresAt,
        phone: otpResult.phone,
      });
    } catch (err) {
      console.error('[POST /api/auth/otp/request]', err);
      otpErrorResponse(res, 'db_error', 503);
    }
  });

  router.post('/otp/verify', async (req, res) => {
    try {
      const phone = req.body?.phone;
      const code = req.body?.code;
      const verifyResult = await otpAuth.verifyOtp(phone, code, secret);

      if (!verifyResult.ok) {
        return otpErrorResponse(res, verifyResult.error, otpErrorStatus(verifyResult.error));
      }

      setAuthCookie(res, verifyResult.user, secret);

      const data = await readData();
      res.status(200).json({
        ok: true,
        user: await toPublicUserWithProfile(verifyResult.user, data),
      });
    } catch (err) {
      console.error('[POST /api/auth/otp/verify]', err);
      otpErrorResponse(res, 'db_error', 503);
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
  OTP_ERROR_MESSAGES,
  otpErrorStatus,
};
