const express = require('express');
const otpAuth = require('../otp-auth.js');
const passwordReset = require('../password-reset.js');
const { sendOtpToTelegram } = require('../telegram-bot.js');
const { setAuthCookie } = require('../auth-jwt.js');

const OTP_ERROR_MESSAGES = {
  invalid_phone: 'Вкажіть коректний номер телефону',
  invalid_email: 'Вкажіть коректний email',
  invalid_code: 'Невірний код',
  invalid_password: 'Пароль має містити щонайменше 6 символів',
  invalid_token: 'Посилання недійсне або вже використане',
  token_expired: 'Посилання прострочене. Запросіть нове',
  user_not_found: 'Користувача не знайдено',
  telegram_not_linked:
    'Telegram ще не підключено. Увійдіть логіном/паролем і відкрийте «Підключити Telegram»',
  bot_not_configured: 'Telegram-бот не налаштовано',
  send_failed: 'Не вдалося надіслати повідомлення',
  email_not_configured: 'Email-відновлення ще не налаштоване (RESEND_API_KEY)',
  email_column_missing: 'Виконайте міграцію 006_password_reset.sql у Supabase',
  table_missing: 'Виконайте міграцію 006_password_reset.sql у Supabase',
  too_many_requests: 'Зачекайте хвилину перед повторним запитом',
  too_many_attempts: 'Перевищено кількість спроб. Запросіть новий код',
  code_not_found: 'Код не знайдено. Запросіть новий',
  code_expired: 'Код прострочений. Запросіть новий',
  db_error: 'Помилка сервера. Спробуйте пізніше',
};

function otpErrorStatus(error) {
  switch (error) {
    case 'invalid_phone':
    case 'invalid_email':
    case 'invalid_code':
    case 'invalid_password':
    case 'invalid_token':
    case 'code_expired':
    case 'token_expired':
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
    case 'email_not_configured':
    case 'email_column_missing':
    case 'table_missing':
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
  const secret = String(
    explicitSecret || process.env.JWT_SECRET || process.env.SESSION_SECRET || ''
  ).trim();
  const isProd = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  if (isProd && (!secret || secret === 'mapfix-dev-secret-change-in-production')) {
    throw new Error('JWT_SECRET must be set in production');
  }
  return secret || 'mapfix-dev-secret-change-in-production';
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  }
  if (process.env.VERCEL_URL) {
    return `https://${String(process.env.VERCEL_URL).replace(/^https?:\/\//, '')}`;
  }
  const host = req.get('host');
  if (host) {
    const proto = req.protocol || 'http';
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
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

  // --- Password reset: phone (Telegram OTP) ---
  router.post('/password/reset-request', async (req, res) => {
    try {
      const method = String(req.body?.method || 'phone').toLowerCase();

      if (method === 'email') {
        const result = await passwordReset.requestPasswordResetByEmail(
          req.body?.email,
          getPublicBaseUrl(req)
        );
        if (!result.ok) {
          return otpErrorResponse(res, result.error, otpErrorStatus(result.error));
        }
        return res.json({
          ok: true,
          method: 'email',
          message:
            'Якщо акаунт з таким email існує, ми надіслали посилання для відновлення пароля.',
        });
      }

      const otpResult = await passwordReset.requestPasswordResetByPhone(req.body?.phone, secret);
      if (!otpResult.ok) {
        return otpErrorResponse(res, otpResult.error, otpErrorStatus(otpResult.error));
      }

      const sendResult = await sendOtpToTelegram(otpResult.phone, otpResult.code, {
        purpose: 'reset',
      });
      if (!sendResult.ok) {
        await otpAuth.cancelOtpById(otpResult.otpId);
        return otpErrorResponse(res, sendResult.error, 503);
      }

      res.json({
        ok: true,
        method: 'phone',
        expiresAt: otpResult.expiresAt,
        phone: otpResult.phone,
        message: 'Код для відновлення пароля надіслано в Telegram.',
      });
    } catch (err) {
      console.error('[POST /api/auth/password/reset-request]', err);
      otpErrorResponse(res, 'db_error', 503);
    }
  });

  router.post('/password/reset', async (req, res) => {
    try {
      const method = String(req.body?.method || 'phone').toLowerCase();
      const newPassword = req.body?.newPassword || req.body?.password;

      if (method === 'email') {
        const result = await passwordReset.resetPasswordByEmailToken({
          token: req.body?.token,
          newPassword,
        });
        if (!result.ok) {
          return otpErrorResponse(res, result.error, otpErrorStatus(result.error));
        }
        if (result.user) setAuthCookie(res, result.user, secret);
        const data = await readData();
        return res.json({
          ok: true,
          method: 'email',
          user: result.user
            ? await toPublicUserWithProfile(result.user, data)
            : null,
        });
      }

      const result = await passwordReset.resetPasswordByPhone({
        phone: req.body?.phone,
        code: req.body?.code,
        newPassword,
        secret,
      });
      if (!result.ok) {
        return otpErrorResponse(res, result.error, otpErrorStatus(result.error));
      }

      setAuthCookie(res, result.user, secret);
      const data = await readData();
      res.json({
        ok: true,
        method: 'phone',
        user: await toPublicUserWithProfile(result.user, data),
      });
    } catch (err) {
      console.error('[POST /api/auth/password/reset]', err);
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
