'use strict';

const fs = require('fs').promises;
const path = require('path');
const { loadAppState, saveAppState } = require('./app-state-store.js');
const {
  readOrderRows,
  writeOrderRows,
  readFavoriteRows,
  writeFavoriteRows,
} = require('./relational-store.js');
const { resolveProjectRoot } = require('./paths.js');

const ORDERS_ID = 'orders';
const FAVORITES_ID = 'favorites';
const OAUTH_INDEX_ID = 'oauth_index';

function localPath(name) {
  return path.join(resolveProjectRoot(), name);
}

async function readLocalJson(file, fallback) {
  try {
    const raw = await fs.readFile(localPath(file), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeLocalJson(file, value) {
  await fs.writeFile(localPath(file), JSON.stringify(value, null, 2), 'utf8');
}

async function readLegacyOrders() {
  const remote = await loadAppState(ORDERS_ID, null);
  if (remote.ok && remote.value) {
    const items = Array.isArray(remote.value)
      ? remote.value
      : Array.isArray(remote.value.items)
        ? remote.value.items
        : null;
    if (items) return items;
  }
  return readLocalJson('orders.json', []);
}

let ordersImportTried = false;

async function readOrders() {
  const table = await readOrderRows();
  if (table.ok && table.rows.length) return table.rows;
  const legacy = await readLegacyOrders();
  if (table.ok && legacy.length && !ordersImportTried) {
    ordersImportTried = true;
    const saved = await writeOrderRows(legacy);
    if (saved.ok) return legacy;
    console.warn('[orders] table import failed:', saved.error?.message || saved.error);
  }
  return legacy;
}

async function writeOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const table = await writeOrderRows(list);
  if (!table.ok) {
    console.warn('[orders] table save failed:', table.error?.message || table.error);
    if (process.env.VERCEL) throw new Error('Не вдалося зберегти замовлення');
  }
  const remote = await saveAppState(ORDERS_ID, { items: list });
  if (!remote.ok && !table.ok) {
    await writeLocalJson('orders.json', list);
  }
}

async function readLegacyFavorites() {
  const remote = await loadAppState(FAVORITES_ID, null);
  if (remote.ok && remote.value) {
    const items = Array.isArray(remote.value)
      ? remote.value
      : Array.isArray(remote.value.items)
        ? remote.value.items
        : null;
    if (items) return items;
  }
  return readLocalJson('favorites.json', []);
}

let favoritesImportTried = false;

async function readFavorites() {
  const table = await readFavoriteRows();
  if (table.ok && table.rows.length) return table.rows;
  const legacy = await readLegacyFavorites();
  if (table.ok && legacy.length && !favoritesImportTried) {
    favoritesImportTried = true;
    const saved = await writeFavoriteRows(legacy);
    if (saved.ok) return legacy;
    console.warn('[favorites] table import failed:', saved.error?.message || saved.error);
  }
  return legacy;
}

async function writeFavorites(favorites) {
  const list = Array.isArray(favorites) ? favorites : [];
  const table = await writeFavoriteRows(list);
  if (!table.ok) {
    console.warn('[favorites] table save failed:', table.error?.message || table.error);
    if (process.env.VERCEL) throw new Error('Не вдалося зберегти обране');
  }
  const remote = await saveAppState(FAVORITES_ID, { items: list });
  if (!remote.ok && !table.ok) {
    await writeLocalJson('favorites.json', list);
  }
}

async function readOauthIndex() {
  const remote = await loadAppState(OAUTH_INDEX_ID, {});
  if (remote.ok && remote.value && typeof remote.value === 'object' && !Array.isArray(remote.value)) {
    return remote.value;
  }
  return {};
}

async function writeOauthIndex(index) {
  const remote = await saveAppState(OAUTH_INDEX_ID, index && typeof index === 'object' ? index : {});
  if (!remote.ok && process.env.VERCEL) {
    console.warn('[oauth-index] save failed:', remote.error?.message || remote.error);
  }
  return remote;
}

async function linkOauthInIndex(provider, providerUserId, userId) {
  if (!provider || !providerUserId || !userId) return;
  const index = await readOauthIndex();
  index[`${provider}:${providerUserId}`] = userId;
  await writeOauthIndex(index);
}

async function findUserIdInOauthIndex(provider, providerUserId) {
  if (!provider || !providerUserId) return null;
  const index = await readOauthIndex();
  return index[`${provider}:${providerUserId}`] || null;
}

module.exports = {
  readOrders,
  writeOrders,
  readFavorites,
  writeFavorites,
  readOauthIndex,
  linkOauthInIndex,
  findUserIdInOauthIndex,
};
