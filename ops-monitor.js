'use strict';

/**
 * Admin ops: email alerts for feedback/reports + hourly health digest.
 * Full "AI agent auto-fixes after email reply" needs Cursor Automation / chat approval.
 */
const { sendAppEmail } = require('./notifications.js');
const { loadAppState, saveAppState } = require('./app-state-store.js');
const reportsMod = require('./reports.js');
const supportTickets = require('./support-tickets.js');

const OPS_STATE_ID = 'ops_monitor_state';
const DEFAULT_ADMIN_EMAIL = 'slavafin100@gmail.com';

function adminEmail() {
  return String(process.env.ADMIN_ALERT_EMAIL || DEFAULT_ADMIN_EMAIL).trim();
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || 'https://mapfix-wine.vercel.app').replace(/\/$/, '');
}

async function readOpsState() {
  const remote = await loadAppState(OPS_STATE_ID, null);
  if (remote.ok && remote.value && typeof remote.value === 'object') return remote.value;
  return {
    lastDigestAt: null,
    lastReportIdsEmailed: [],
    lastTicketIdsEmailed: [],
  };
}

async function writeOpsState(state) {
  await saveAppState(OPS_STATE_ID, state || {});
}

/**
 * Lightweight triage: maps common user wording to likely fixes.
 * Cursor agent still needs explicit "так, виправляй" to apply code changes.
 */
function analyzeFeedback(text, { reason, subject } = {}) {
  const raw = `${subject || ''} ${text || ''}`.toLowerCase();
  const proposals = [];

  const push = (title, steps) => proposals.push({ title, steps });

  if (/замовити|order|кнопк/.test(raw) && /(не|нема|мертв|не працю|не реаг)/.test(raw)) {
    push('Кнопка «Замовити» / кліки в картці', [
      'Перевірити bind onclick після renderDetailBody (без outerHTML).',
      'Перевірити роль клієнта та redirect після логіну (?next=/?loc=…).',
    ]);
  }
  if (/графік|годин|відкрит|зачин|розклад|schedule/.test(raw)) {
    push('Графік роботи / статус «відкрито»', [
      'Звірити schedule vs openStatus у картці.',
      'Підтягнути live open/closed з графіка по днях (Київ).',
    ]);
  }
  if (/пошук|голос|gemini|категор/.test(raw)) {
    push('Пошук / каталог', [
      'Перевірити /api/search-ai і відповідь Gemini.',
      'Перевірити фільтр категорій на карті.',
    ]);
  }
  if (/вхід|логін|парол|telegram|otp|код/.test(raw)) {
    push('Авторизація', [
      'Перевірити Telegram bot / OTP / cookie JWT.',
      'Перевірити redirect після логіну (next=).',
    ]);
  }
  if (/фото|завант|прайс|цін/.test(raw)) {
    push('Фото / прайс майстра', [
      'Перевірити ліміти billing.limitsEnabled і upload API.',
      'Перевірити відображення цін formatDisplayPrice.',
    ]);
  }
  if (/повільн|лаг|довго|не вантаж|blank|біл/.test(raw)) {
    push('Швидкість / завантаження карти', [
      'Перевірити /api/data latency і розмір відповіді.',
      'Перевірити Vercel logs і час cold start.',
    ]);
  }
  if (/додаток|pwa|встанов|іконк/.test(raw)) {
    push('PWA / встановлення додатку', [
      'Перевірити manifest, icons, beforeinstallprompt / iOS інструкцію.',
    ]);
  }
  if (reason === 'site_bug' && !proposals.length) {
    push('Загальний баг сайту', [
      'Відтворити за описом на проді.',
      'Знайти місце в public/index.html / server.js і запропонувати мінімальний патч.',
    ]);
  }
  if (!proposals.length) {
    push('Потрібен ручний розбір', [
      'Прочитати звернення, відтворити сценарій, запропонувати точковий фікс у чаті Cursor.',
    ]);
  }

  return {
    summary: String(text || '').trim().slice(0, 280),
    proposals,
    replyHint: 'У Cursor напишіть: так, виправляй ' + (reason === 'site_bug' ? 'баг сайту' : 'це звернення'),
  };
}

function proposalsHtml(analysis) {
  const blocks = (analysis.proposals || [])
    .map(
      (p) =>
        `<p><b>${escapeHtml(p.title)}</b></p><ul>${(p.steps || [])
          .map((s) => `<li>${escapeHtml(s)}</li>`)
          .join('')}</ul>`
    )
    .join('');
  return `${blocks}<p style="color:#64748b;font-size:13px">${escapeHtml(analysis.replyHint || '')}</p>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function notifyAdminNewReport(report) {
  const to = adminEmail();
  if (!to) return { ok: false, error: 'no_admin_email' };
  const analysis = analyzeFeedback(report.message, {
    reason: report.reason,
    subject: report.locationTitle,
  });
  const subject =
    report.reason === 'site_bug'
      ? `[Mapfix] Помилка сайту · ${analysis.summary.slice(0, 60)}`
      : `[Mapfix] Скарга · ${String(report.locationTitle || report.locationId || 'точка').slice(0, 60)}`;

  const html = `
    <h2>Нове звернення Mapfix</h2>
    <p><b>Тип:</b> ${escapeHtml(report.reason || '—')}<br>
    <b>Хто:</b> ${escapeHtml(report.reporterLogin || 'гість')}${
      report.contact ? ` · контакт: ${escapeHtml(report.contact)}` : ''
    }<br>
    <b>Сторінка:</b> ${escapeHtml(report.page || '—')}<br>
    <b>Точка:</b> ${escapeHtml(report.locationTitle || report.locationId || '—')}<br>
    <b>ID:</b> <code>${escapeHtml(report.id)}</code></p>
    <p><b>Текст:</b><br>${escapeHtml(report.message).replace(/\n/g, '<br>')}</p>
    <hr>
    <h3>Пропозиції фіксу (для Cursor)</h3>
    ${proposalsHtml(analysis)}
    <p>Адмінка: <a href="${publicBaseUrl()}/admin">${publicBaseUrl()}/admin</a> → Скарги</p>
  `;

  const result = await sendAppEmail({ to, subject, html });
  if (result.ok) {
    const state = await readOpsState();
    const ids = new Set(state.lastReportIdsEmailed || []);
    ids.add(report.id);
    state.lastReportIdsEmailed = [...ids].slice(0, 200);
    await writeOpsState(state);
  }
  return { ...result, analysis };
}

async function notifyAdminNewTicket(ticket) {
  const to = adminEmail();
  if (!to) return { ok: false, error: 'no_admin_email' };
  const analysis = analyzeFeedback(ticket.message, { subject: ticket.subject });
  const subject = `[Mapfix] Підтримка · ${String(ticket.subject || '').slice(0, 60)}`;
  const html = `
    <h2>Звернення в підтримку</h2>
    <p><b>Від:</b> @${escapeHtml(ticket.userLogin)} (${escapeHtml(ticket.userRole)})<br>
    <b>Тема:</b> ${escapeHtml(ticket.subject)}<br>
    <b>ID:</b> <code>${escapeHtml(ticket.id)}</code></p>
    <p>${escapeHtml(ticket.message).replace(/\n/g, '<br>')}</p>
    <hr>
    <h3>Пропозиції</h3>
    ${proposalsHtml(analysis)}
  `;
  const result = await sendAppEmail({ to, subject, html });
  if (result.ok) {
    const state = await readOpsState();
    const ids = new Set(state.lastTicketIdsEmailed || []);
    ids.add(ticket.id);
    state.lastTicketIdsEmailed = [...ids].slice(0, 200);
    await writeOpsState(state);
  }
  return { ...result, analysis };
}

async function probeUrl(url, timeoutMs = 12000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: { Accept: 'application/json,text/html,*/*' },
    });
    const ms = Date.now() - started;
    return { ok: res.ok, status: res.status, ms, url };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, url, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

async function runHealthChecks() {
  const base = publicBaseUrl();
  const checks = await Promise.all([
    probeUrl(`${base}/`),
    probeUrl(`${base}/api/data`),
    probeUrl(`${base}/manifest.json`),
    probeUrl(`${base}/login.html`),
  ]);
  const allOk = checks.every((c) => c.ok);
  return { allOk, checks, checkedAt: new Date().toISOString() };
}

async function runHourlyDigest() {
  const to = adminEmail();
  const health = await runHealthChecks();
  const reports = await reportsMod.listReports();
  const tickets = await supportTickets.listAllTickets();
  const state = await readOpsState();
  const emailedReports = new Set(state.lastReportIdsEmailed || []);
  const emailedTickets = new Set(state.lastTicketIdsEmailed || []);

  const openReports = reports.filter((r) => r.status === 'new' || r.status === 'reviewing');
  const openTickets = tickets.filter((t) => t.status === 'new' || t.status === 'in_progress');
  const freshReports = openReports.filter((r) => !emailedReports.has(r.id)).slice(0, 10);
  const freshTickets = openTickets.filter((t) => !emailedTickets.has(t.id)).slice(0, 10);

  // Email only when unhealthy or there is open work
  const shouldEmail = !health.allOk || openReports.length > 0 || openTickets.length > 0;
  if (!shouldEmail) {
    state.lastDigestAt = new Date().toISOString();
    await writeOpsState(state);
    return { ok: true, skipped: true, reason: 'all_clear_no_email', health };
  }

  const healthRows = health.checks
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.url.replace(publicBaseUrl(), ''))}</td><td>${
          c.ok ? 'OK' : 'FAIL'
        }</td><td>${c.status}</td><td>${c.ms}ms</td><td>${escapeHtml(c.error || '')}</td></tr>`
    )
    .join('');

  const reportBlocks = openReports
    .slice(0, 8)
    .map((r) => {
      const a = analyzeFeedback(r.message, { reason: r.reason, subject: r.locationTitle });
      return `<div style="margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:8px">
        <b>${escapeHtml(r.reason === 'site_bug' ? '🐞 Баг сайту' : r.locationTitle || 'Скарга')}</b>
        · ${escapeHtml(r.status)} · <code>${escapeHtml(r.id.slice(0, 8))}</code><br>
        ${escapeHtml(a.summary)}<br>
        <i>Пропозиція:</i> ${escapeHtml(a.proposals[0]?.title || '')}
        — ${escapeHtml((a.proposals[0]?.steps || []).join(' '))}
      </div>`;
    })
    .join('');

  const ticketBlocks = openTickets
    .slice(0, 5)
    .map((t) => {
      const a = analyzeFeedback(t.message, { subject: t.subject });
      return `<div style="margin:12px 0;padding:12px;border:1px solid #e2e8f0;border-radius:8px">
        <b>Підтримка:</b> ${escapeHtml(t.subject)} (@${escapeHtml(t.userLogin)})<br>
        ${escapeHtml(a.summary)}<br>
        <i>Пропозиція:</i> ${escapeHtml(a.proposals[0]?.title || '')}
      </div>`;
    })
    .join('');

  const subject = health.allOk
    ? `[Mapfix] Щогодинний дайджест · відкритих: ${openReports.length + openTickets.length}`
    : `[Mapfix] ⚠ Проблеми здоровʼя сайту`;

  const html = `
    <h2>Mapfix — щогодинний моніторинг</h2>
    <p>Час: ${escapeHtml(health.checkedAt)} · Сайт: ${
      health.allOk ? '<b style="color:green">OK</b>' : '<b style="color:#b91c1c">Є збої</b>'
    }</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">
      <tr><th>Шлях</th><th>Статус</th><th>HTTP</th><th>Час</th><th>Помилка</th></tr>
      ${healthRows}
    </table>
    <h3>Відкриті звернення (${openReports.length})</h3>
    ${reportBlocks || '<p>Немає</p>'}
    <h3>Відкрита підтримка (${openTickets.length})</h3>
    ${ticketBlocks || '<p>Немає</p>'}
    <hr>
    <p>Щоб я виправив у коді: відкрийте Cursor і напишіть<br>
    <code>так, виправляй &lt;короткий опис або id&gt;</code></p>
    <p>Адмінка: <a href="${publicBaseUrl()}/admin">${publicBaseUrl()}/admin</a></p>
  `;

  const result = await sendAppEmail({ to, subject, html });
  state.lastDigestAt = new Date().toISOString();
  for (const r of freshReports) emailedReports.add(r.id);
  for (const t of freshTickets) emailedTickets.add(t.id);
  state.lastReportIdsEmailed = [...emailedReports].slice(0, 200);
  state.lastTicketIdsEmailed = [...emailedTickets].slice(0, 200);
  await writeOpsState(state);
  return { ok: result.ok, health, emailed: result.ok, openReports: openReports.length, openTickets: openTickets.length };
}

module.exports = {
  adminEmail,
  analyzeFeedback,
  notifyAdminNewReport,
  notifyAdminNewTicket,
  runHealthChecks,
  runHourlyDigest,
};
