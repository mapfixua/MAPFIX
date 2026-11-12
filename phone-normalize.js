'use strict';

/** Same phone folding Mapfix already uses for Telegram auth and imports. */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) {
    return '+38' + digits;
  }
  if (digits.length === 9) {
    return '+380' + digits;
  }
  if (digits.startsWith('380') && digits.length >= 12) {
    return '+' + digits;
  }
  if (digits.startsWith('38') && digits.length >= 12) {
    return '+' + digits;
  }
  return digits.startsWith('+') ? digits : '+' + digits;
}

module.exports = { normalizePhone };
