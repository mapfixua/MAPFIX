'use strict';

const crypto = require('crypto');
const { supabaseClient } = require('./supabaseClient.js');

const BUCKET = process.env.SUPABASE_LOCATION_PHOTOS_BUCKET || 'location-photos';
const MAX_PHOTOS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .filter((p) => p && p.url)
    .map((p) => ({
      id: p.id || crypto.randomUUID(),
      url: String(p.url),
      path: p.path || null,
      createdAt: p.createdAt || null,
    }))
    .slice(0, MAX_PHOTOS);
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  const match = raw.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error('Підтримуються лише JPEG, PNG або WebP');
  }
  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error('Підтримуються лише JPEG, PNG або WebP');
  }
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('Порожній файл');
  if (buffer.length > MAX_BYTES) {
    throw new Error('Файл більший за 5 МБ');
  }
  return { mime, buffer };
}

function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

async function uploadLocationPhoto({ locationId, providerId, dataUrl }) {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const photoId = crypto.randomUUID();
  const ext = extForMime(mime);
  const path = `${providerId || 'anon'}/${locationId}/${photoId}.${ext}`;

  const { error } = await supabaseClient.storage.from(BUCKET).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    const msg = String(error.message || error);
    if (/Bucket not found|not found/i.test(msg)) {
      throw new Error('Виконайте міграцію 012_location_photos.sql (bucket location-photos)');
    }
    throw new Error(msg);
  }

  const { data } = supabaseClient.storage.from(BUCKET).getPublicUrl(path);
  return {
    id: photoId,
    url: data.publicUrl,
    path,
    createdAt: new Date().toISOString(),
  };
}

async function deleteLocationPhotoFile(path) {
  if (!path) return { ok: true };
  const { error } = await supabaseClient.storage.from(BUCKET).remove([path]);
  if (error) {
    console.warn('[location-photos] delete skip:', error.message);
    return { ok: false, error };
  }
  return { ok: true };
}

async function uploadSupportPhoto({ ticketId, userId, dataUrl }) {
  const { mime, buffer } = parseDataUrl(dataUrl);
  const photoId = crypto.randomUUID();
  const ext = extForMime(mime);
  const path = `support/${userId || 'anon'}/${ticketId || 'ticket'}/${photoId}.${ext}`;

  const { error } = await supabaseClient.storage.from(BUCKET).upload(path, buffer, {
    contentType: mime,
    upsert: false,
  });
  if (error) {
    const msg = String(error.message || error);
    if (/Bucket not found|not found/i.test(msg)) {
      throw new Error('Сховище фото не налаштовано (bucket location-photos)');
    }
    throw new Error(msg);
  }

  const { data } = supabaseClient.storage.from(BUCKET).getPublicUrl(path);
  return {
    id: photoId,
    url: data.publicUrl,
    path,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  MAX_PHOTOS,
  MAX_BYTES,
  ALLOWED_MIME,
  normalizePhotos,
  parseDataUrl,
  uploadLocationPhoto,
  uploadSupportPhoto,
  deleteLocationPhotoFile,
};
