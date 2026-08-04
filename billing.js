'use strict';

const crypto = require('crypto');
const { loadAppState, saveAppState } = require('./app-state-store.js');

const BILLING_ID = 'billing';
const MONO_JAR_URL = 'https://send.monobank.ua/jar/6KwyVZAiKy';
const SUBSCRIPTION_PRICE_UAH = 99;
const TRIAL_DAYS = 90;
const FREE_MAX_PRICES = 3;
const FREE_MAX_PHOTOS = 0;
const PAID_MAX_PHOTOS = 6;
const MAX_EVENTS = 2000;

function emptyState() {
  return {
    subscriptions: {},
    events: [],
    settings: {
      // When false — everyone gets Pro-like limits (photos + unlimited prices).
      limitsEnabled: false,
    },
  };
}

async function readBilling() {
  const remote = await loadAppState(BILLING_ID, null);
  if (remote.ok && remote.value && typeof remote.value === 'object') {
    const base = emptyState();
    return {
      subscriptions:
        remote.value.subscriptions && typeof remote.value.subscriptions === 'object'
          ? remote.value.subscriptions
          : {},
      events: Array.isArray(remote.value.events) ? remote.value.events : [],
      settings: {
        ...base.settings,
        ...(remote.value.settings && typeof remote.value.settings === 'object'
          ? remote.value.settings
          : {}),
      },
    };
  }
  return emptyState();
}

async function writeBilling(state) {
  const base = emptyState();
  const payload = {
    subscriptions: state.subscriptions || {},
    events: Array.isArray(state.events) ? state.events.slice(0, MAX_EVENTS) : [],
    settings: {
      ...base.settings,
      ...(state.settings && typeof state.settings === 'object' ? state.settings : {}),
    },
  };
  const remote = await saveAppState(BILLING_ID, payload);
  if (!remote.ok && process.env.VERCEL && !remote.missing) {
    throw new Error('Не вдалося зберегти білінг');
  }
  return remote;
}

function limitsAreEnabled(state) {
  // Default OFF until admin turns them on (launch mode).
  if (!state?.settings || typeof state.settings.limitsEnabled === 'undefined') {
    return false;
  }
  return Boolean(state.settings.limitsEnabled);
}

function addMonths(iso, months) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setMonth(d.getMonth() + Number(months || 1));
  return d.toISOString();
}

function addDays(iso, days) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

function ensureSub(state, userId, meta = {}) {
  if (!state.subscriptions[userId]) {
    state.subscriptions[userId] = {
      userId,
      login: meta.login || '',
      companyName: meta.companyName || '',
      trialStartedAt: meta.trialStartedAt || null,
      paidUntil: null,
      lastPaidAt: null,
      lastAmount: null,
      payments: [],
      mapBoost: false,
      updatedAt: new Date().toISOString(),
    };
  } else {
    if (meta.login) state.subscriptions[userId].login = meta.login;
    if (meta.companyName) state.subscriptions[userId].companyName = meta.companyName;
    if (meta.trialStartedAt && !state.subscriptions[userId].trialStartedAt) {
      state.subscriptions[userId].trialStartedAt = meta.trialStartedAt;
    }
  }
  return state.subscriptions[userId];
}

/**
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.login]
 * @param {string} [opts.companyName]
 * @param {string|null} [opts.profileCreatedAt]
 * @param {boolean} [opts.isAdmin]
 * @param {object} [opts.state] — optional preloaded billing state
 */
function getEntitlements(opts = {}) {
  const {
    userId,
    login = '',
    companyName = '',
    profileCreatedAt = null,
    isAdmin = false,
    state = null,
  } = opts;

  const limitsOn = limitsAreEnabled(state);

  if (isAdmin || !limitsOn) {
    return {
      plan: isAdmin ? 'admin' : limitsOn ? 'free' : 'open',
      active: true,
      inTrial: false,
      paid: isAdmin ? true : false,
      trialEndsAt: null,
      paidUntil: null,
      daysLeft: null,
      maxPhotos: PAID_MAX_PHOTOS,
      maxPrices: null,
      mapBoost: true,
      priceUah: SUBSCRIPTION_PRICE_UAH,
      trialDays: TRIAL_DAYS,
      monoJarUrl: MONO_JAR_URL,
      canUploadPhotos: true,
      canAddUnlimitedPrices: true,
      limitsEnabled: limitsOn,
      login,
      companyName,
      clickCount: null,
    };
  }

  const sub = state?.subscriptions?.[userId] || null;
  const now = Date.now();
  const trialStart = sub?.trialStartedAt || profileCreatedAt || null;
  const trialEndsAt = trialStart ? addDays(trialStart, TRIAL_DAYS) : null;
  const inTrial = trialEndsAt ? new Date(trialEndsAt).getTime() > now : false;
  const paidUntil = sub?.paidUntil || null;
  const paid = paidUntil ? new Date(paidUntil).getTime() > now : false;
  const active = inTrial || paid;

  let daysLeft = null;
  const end = paid ? paidUntil : inTrial ? trialEndsAt : null;
  if (end) {
    daysLeft = Math.max(0, Math.ceil((new Date(end).getTime() - now) / 86400000));
  }

  return {
    plan: paid ? 'pro' : inTrial ? 'trial' : 'free',
    active,
    inTrial,
    paid,
    trialEndsAt,
    paidUntil,
    daysLeft,
    maxPhotos: active ? PAID_MAX_PHOTOS : FREE_MAX_PHOTOS,
    maxPrices: active ? null : FREE_MAX_PRICES,
    mapBoost: Boolean(paid || sub?.mapBoost),
    priceUah: SUBSCRIPTION_PRICE_UAH,
    trialDays: TRIAL_DAYS,
    monoJarUrl: MONO_JAR_URL,
    canUploadPhotos: active,
    canAddUnlimitedPrices: active,
    limitsEnabled: true,
    login: sub?.login || login,
    companyName: sub?.companyName || companyName,
    clickCount: null,
  };
}

async function getEntitlementsForUser(user, profile) {
  const state = await readBilling();
  return getEntitlements({
    userId: user.id,
    login: user.login || '',
    companyName: profile?.companyName || '',
    profileCreatedAt: profile?.createdAt || null,
    isAdmin: user.role === 'admin',
    state,
  });
}

async function trackClick({ user, type, meta = {} }) {
  const kind = type === 'subscribe' ? 'subscribe' : 'donate';
  const state = await readBilling();
  const event = {
    id: crypto.randomUUID(),
    type: kind,
    userId: user?.id || null,
    login: user?.login || '',
    role: user?.role || '',
    amountHint: kind === 'subscribe' ? SUBSCRIPTION_PRICE_UAH : null,
    note: String(meta.note || '').slice(0, 200),
    at: new Date().toISOString(),
  };
  state.events.unshift(event);
  if (kind === 'subscribe' && user?.id) {
    ensureSub(state, user.id, {
      login: user.login,
      companyName: meta.companyName || '',
      trialStartedAt: meta.trialStartedAt || null,
    });
  }
  await writeBilling(state);
  return {
    event,
    url: MONO_JAR_URL,
    suggestedAmount: kind === 'subscribe' ? SUBSCRIPTION_PRICE_UAH : null,
    commentHint:
      kind === 'subscribe' && user?.login
        ? `Mapfix Pro @${user.login}`
        : kind === 'donate'
          ? 'На розвиток Mapfix'
          : '',
  };
}

async function markPaid({
  userId,
  login = '',
  companyName = '',
  amount = SUBSCRIPTION_PRICE_UAH,
  months = 1,
  note = '',
  trialStartedAt = null,
  adminLogin = '',
}) {
  if (!userId) throw new Error('Потрібен userId');
  const mos = Math.max(1, Math.min(24, Number(months) || 1));
  const amt = Math.max(0, Number(amount) || SUBSCRIPTION_PRICE_UAH);
  const state = await readBilling();
  const sub = ensureSub(state, userId, { login, companyName, trialStartedAt });
  const now = new Date().toISOString();
  const base =
    sub.paidUntil && new Date(sub.paidUntil).getTime() > Date.now() ? sub.paidUntil : now;
  sub.paidUntil = addMonths(base, mos);
  sub.lastPaidAt = now;
  sub.lastAmount = amt;
  sub.mapBoost = true;
  sub.updatedAt = now;
  const payment = {
    id: crypto.randomUUID(),
    amount: amt,
    months: mos,
    paidAt: now,
    note: String(note || '').slice(0, 500),
    source: 'admin',
    adminLogin: adminLogin || '',
  };
  sub.payments = [payment, ...(Array.isArray(sub.payments) ? sub.payments : [])].slice(0, 100);
  await writeBilling(state);
  return { subscription: publicSubscription(sub), payment };
}

function publicSubscription(sub) {
  if (!sub) return null;
  const paid = sub.paidUntil && new Date(sub.paidUntil).getTime() > Date.now();
  return {
    userId: sub.userId,
    login: sub.login || '',
    companyName: sub.companyName || '',
    trialStartedAt: sub.trialStartedAt || null,
    paidUntil: sub.paidUntil || null,
    lastPaidAt: sub.lastPaidAt || null,
    lastAmount: sub.lastAmount ?? null,
    mapBoost: Boolean(sub.mapBoost),
    activePaid: Boolean(paid),
    payments: Array.isArray(sub.payments) ? sub.payments.slice(0, 20) : [],
    updatedAt: sub.updatedAt || null,
  };
}

async function adminOverview(profilesByUserId = {}) {
  const state = await readBilling();
  const now = Date.now();
  const events = state.events || [];
  const donateClicks = events.filter((e) => e.type === 'donate').length;
  const subscribeClicks = events.filter((e) => e.type === 'subscribe').length;

  const subs = Object.values(state.subscriptions || {}).map((sub) => {
    const profile = profilesByUserId[sub.userId];
    const ent = getEntitlements({
      userId: sub.userId,
      login: sub.login,
      companyName: sub.companyName || profile?.companyName,
      profileCreatedAt: sub.trialStartedAt || profile?.createdAt || null,
      state,
    });
    return { ...publicSubscription(sub), entitlements: ent };
  });

  const activePaid = subs.filter((s) => s.activePaid).length;
  const inTrial = subs.filter((s) => s.entitlements?.inTrial && !s.activePaid).length;
  const revenue = subs.reduce(
    (sum, s) =>
      sum +
      (Array.isArray(s.payments)
        ? s.payments.reduce((a, p) => a + (Number(p.amount) || 0), 0)
        : 0),
    0
  );

  return {
    stats: {
      donateClicks,
      subscribeClicks,
      activePaid,
      inTrial,
      revenueUah: revenue,
      eventsTotal: events.length,
    },
    events: events.slice(0, 200),
    subscriptions: subs.sort((a, b) => {
      const ta = new Date(a.lastPaidAt || a.updatedAt || 0).getTime();
      const tb = new Date(b.lastPaidAt || b.updatedAt || 0).getTime();
      return tb - ta;
    }),
    config: {
      monoJarUrl: MONO_JAR_URL,
      priceUah: SUBSCRIPTION_PRICE_UAH,
      trialDays: TRIAL_DAYS,
      freeMaxPrices: FREE_MAX_PRICES,
      freeMaxPhotos: FREE_MAX_PHOTOS,
      paidMaxPhotos: PAID_MAX_PHOTOS,
      limitsEnabled: limitsAreEnabled(state),
    },
    generatedAt: new Date(now).toISOString(),
  };
}

async function setLimitsEnabled(enabled, meta = {}) {
  const state = await readBilling();
  if (!state.settings) state.settings = {};
  state.settings.limitsEnabled = Boolean(enabled);
  state.settings.limitsUpdatedAt = new Date().toISOString();
  state.settings.limitsUpdatedBy = meta.adminLogin || '';
  await writeBilling(state);
  return {
    ok: true,
    limitsEnabled: state.settings.limitsEnabled,
    settings: state.settings,
  };
}

module.exports = {
  MONO_JAR_URL,
  SUBSCRIPTION_PRICE_UAH,
  TRIAL_DAYS,
  FREE_MAX_PRICES,
  FREE_MAX_PHOTOS,
  PAID_MAX_PHOTOS,
  getEntitlements,
  getEntitlementsForUser,
  trackClick,
  markPaid,
  adminOverview,
  publicSubscription,
  readBilling,
  setLimitsEnabled,
  limitsAreEnabled,
};
