const crypto = require('crypto');

const COOKIE_NAME = 'mapfix_auth';
const JWT_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(user, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = {
    id: user.id,
    login: user.login,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + JWT_MAX_AGE_SEC,
  };
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.id || !payload.login || !payload.role) return null;
    return { id: payload.id, login: payload.login, role: payload.role };
  } catch {
    return null;
  }
}

function isProduction() {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

function getCookieOptions(overrides = {}) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    maxAge: JWT_MAX_AGE_SEC * 1000,
    path: '/',
    ...overrides,
  };
}

function attachAuth(secret) {
  return (req, res, next) => {
    const token = req.cookies?.[COOKIE_NAME];
    req.authUser = verifyToken(token, secret);
    next();
  };
}

function setAuthCookie(res, user, secret) {
  res.cookie(COOKIE_NAME, signToken(user, secret), getCookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, getCookieOptions({ maxAge: 0 }));
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  attachAuth,
  setAuthCookie,
  clearAuthCookie,
  getCookieOptions,
};
