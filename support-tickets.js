'use strict';

const crypto = require('crypto');
const { loadAppState, saveAppState } = require('./app-state-store.js');
const { uploadSupportPhoto } = require('./location-photos.js');

const TICKETS_ID = 'support_tickets';
const MAX_PHOTOS = 3;
const MAX_MESSAGE = 4000;
const STATUSES = ['new', 'in_progress', 'done'];

async function readTickets() {
  const remote = await loadAppState(TICKETS_ID, null);
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

async function writeTickets(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  const remote = await saveAppState(TICKETS_ID, { items: list });
  if (!remote.ok && process.env.VERCEL) {
    console.warn('[support] save failed:', remote.error?.message || remote.error);
    if (!remote.missing) throw new Error('Не вдалося зберегти звернення');
  }
  return remote;
}

function publicTicket(t) {
  if (!t) return null;
  return {
    id: t.id,
    userId: t.userId,
    userLogin: t.userLogin || '',
    userRole: t.userRole || '',
    subject: t.subject || '',
    message: t.message || '',
    status: t.status || 'new',
    photos: Array.isArray(t.photos) ? t.photos : [],
    adminReply: t.adminReply || '',
    adminPhotos: Array.isArray(t.adminPhotos) ? t.adminPhotos : [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function createTicket({ user, subject, message, photoDataUrls }) {
  const subj = String(subject || '').trim().slice(0, 120);
  const msg = String(message || '').trim().slice(0, MAX_MESSAGE);
  if (subj.length < 3) throw new Error('Вкажіть тему (мін. 3 символи)');
  if (msg.length < 5) throw new Error('Опишіть проблему детальніше');

  const id = crypto.randomUUID();
  const photos = [];
  const urls = Array.isArray(photoDataUrls) ? photoDataUrls.slice(0, MAX_PHOTOS) : [];
  for (const dataUrl of urls) {
    if (!dataUrl) continue;
    const uploaded = await uploadSupportPhoto({ ticketId: id, userId: user.id, dataUrl });
    photos.push(uploaded);
  }

  const now = new Date().toISOString();
  const ticket = {
    id,
    userId: user.id,
    userLogin: user.login || '',
    userRole: user.role || '',
    subject: subj,
    message: msg,
    status: 'new',
    photos,
    adminReply: '',
    adminPhotos: [],
    createdAt: now,
    updatedAt: now,
  };

  const list = await readTickets();
  list.unshift(ticket);
  await writeTickets(list);
  return publicTicket(ticket);
}

async function listTicketsForUser(userId) {
  const list = await readTickets();
  return list.filter((t) => t.userId === userId).map(publicTicket);
}

async function listAllTickets() {
  const list = await readTickets();
  return list.map(publicTicket);
}

async function updateTicketAdmin(ticketId, { status, adminReply, photoDataUrls, adminUserId }) {
  const list = await readTickets();
  const idx = list.findIndex((t) => t.id === ticketId);
  if (idx === -1) throw new Error('Звернення не знайдено');
  const ticket = list[idx];

  if (status) {
    const s = String(status).trim();
    if (!STATUSES.includes(s)) throw new Error('Невідомий статус');
    ticket.status = s;
  }
  if (adminReply !== undefined) {
    ticket.adminReply = String(adminReply || '').trim().slice(0, MAX_MESSAGE);
  }

  const urls = Array.isArray(photoDataUrls) ? photoDataUrls.slice(0, MAX_PHOTOS) : [];
  if (urls.length) {
    if (!Array.isArray(ticket.adminPhotos)) ticket.adminPhotos = [];
    for (const dataUrl of urls) {
      if (!dataUrl) continue;
      if (ticket.adminPhotos.length >= MAX_PHOTOS) break;
      const uploaded = await uploadSupportPhoto({
        ticketId,
        userId: adminUserId || 'admin',
        dataUrl,
      });
      ticket.adminPhotos.push(uploaded);
    }
  }

  ticket.updatedAt = new Date().toISOString();
  list[idx] = ticket;
  await writeTickets(list);
  return publicTicket(ticket);
}

async function countOpenTickets() {
  const list = await readTickets();
  return list.filter((t) => t.status === 'new' || t.status === 'in_progress').length;
}

module.exports = {
  STATUSES,
  MAX_PHOTOS,
  createTicket,
  listTicketsForUser,
  listAllTickets,
  updateTicketAdmin,
  countOpenTickets,
};
