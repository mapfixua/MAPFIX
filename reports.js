'use strict';

const crypto = require('crypto');
const { loadAppState, saveAppState } = require('./app-state-store.js');

const REPORTS_ID = 'moderation_reports';
const STATUSES = ['new', 'reviewing', 'resolved', 'rejected'];

async function readReports() {
  const remote = await loadAppState(REPORTS_ID, null);
  if (remote.ok && remote.value) {
    const items = Array.isArray(remote.value)
      ? remote.value
      : Array.isArray(remote.value.items)
        ? remote.value.items
        : null;
    if (items) return items;
  }
  return [];
}

async function writeReports(list) {
  const remote = await saveAppState(REPORTS_ID, { items: Array.isArray(list) ? list : [] });
  if (!remote.ok && process.env.VERCEL && !remote.missing) {
    throw new Error('Не вдалося зберегти скаргу');
  }
  return remote;
}

function publicReport(r) {
  if (!r) return null;
  return {
    id: r.id,
    reporterId: r.reporterId,
    reporterLogin: r.reporterLogin || '',
    contact: r.contact || '',
    locationId: r.locationId || '',
    locationTitle: r.locationTitle || '',
    reason: r.reason || '',
    message: r.message || '',
    page: r.page || '',
    status: r.status || 'new',
    adminNote: r.adminNote || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function createReport({ user, locationId, locationTitle, reason, message, contact, page }) {
  const msg = String(message || '').trim().slice(0, 2000);
  const why = String(reason || 'other').trim().slice(0, 40);
  const contactStr = String(contact || '').trim().slice(0, 120);
  const pageStr = String(page || '').trim().slice(0, 200);
  if (msg.length < 5) throw new Error('Опишіть причину скарги детальніше');
  const now = new Date().toISOString();
  const report = {
    id: crypto.randomUUID(),
    reporterId: user?.id || null,
    reporterLogin: user?.login || (contactStr ? `гість` : 'гість'),
    contact: contactStr,
    locationId: locationId || '',
    locationTitle: locationTitle || '',
    reason: why,
    message: msg,
    page: pageStr,
    status: 'new',
    adminNote: '',
    createdAt: now,
    updatedAt: now,
  };
  const list = await readReports();
  list.unshift(report);
  await writeReports(list.slice(0, 500));
  return publicReport(report);
}

async function listReports() {
  return (await readReports()).map(publicReport);
}

async function updateReport(id, { status, adminNote }) {
  const list = await readReports();
  const idx = list.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error('Скаргу не знайдено');
  if (status) {
    if (!STATUSES.includes(status)) throw new Error('Невідомий статус');
    list[idx].status = status;
  }
  if (adminNote !== undefined) list[idx].adminNote = String(adminNote || '').slice(0, 2000);
  list[idx].updatedAt = new Date().toISOString();
  await writeReports(list);
  return publicReport(list[idx]);
}

async function countOpenReports() {
  return (await readReports()).filter((r) => r.status === 'new' || r.status === 'reviewing').length;
}

module.exports = {
  STATUSES,
  createReport,
  listReports,
  updateReport,
  countOpenReports,
};
