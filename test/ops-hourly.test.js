'use strict';

require('./env.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const rollups = require('../analytics-rollups.js');
const opsMonitor = require('../ops-monitor.js');

const originalStep = rollups.runCronStep;
const originalDigest = opsMonitor.runHourlyDigest;

rollups.runCronStep = async () => ({
  ok: true,
  day: '2026-11-15',
  days: ['2026-11-13', '2026-11-14', '2026-11-15'],
  rolled: [
    { day: '2026-11-13', grains: 1, searches: 0, locations: 1 },
    { day: '2026-11-14', grains: 1, searches: 0, locations: 1 },
    { day: '2026-11-15', grains: 1, searches: 0, locations: 1 },
  ],
  errors: [],
  missing: false,
  purged: { impressions: 0, events: 0, batches: 1 },
  elapsedMs: 5,
});
opsMonitor.runHourlyDigest = async () => ({ ok: true, skipped: true, reason: 'test' });

const app = require('../server.js');

function request(method, path, headers) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: headers || {} },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            server.close(() => {
              let body = Buffer.concat(chunks).toString('utf8');
              try {
                body = JSON.parse(body);
              } catch (_) {}
              resolve({ status: res.statusCode, body });
            });
          });
        }
      );
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
      req.end();
    });
  });
}

test('hourly cron accepts GET and POST with Bearer CRON_SECRET and rejects the old header', async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousSecret = process.env.CRON_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.CRON_SECRET = 'test-cron-secret';
  try {
    const open = await request('GET', '/api/ops/hourly');
    assert.equal(open.status, 401);
    assert.equal(open.body.error, 'Unauthorized');

    const spoofed = await request('GET', '/api/ops/hourly', { 'x-vercel-cron': '1' });
    assert.equal(spoofed.status, 401);

    const posted = await request('POST', '/api/ops/hourly', {
      authorization: 'Bearer test-cron-secret',
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.ok, true);
    assert.deepEqual(posted.body.analyticsRollup.days, ['2026-11-13', '2026-11-14', '2026-11-15']);
    assert.equal(posted.body.analyticsRollup.day, '2026-11-15');

    const got = await request('GET', '/api/ops/hourly', {
      authorization: 'bearer test-cron-secret',
    });
    assert.equal(got.status, 200);
    assert.equal(got.body.analyticsRollup.day, '2026-11-15');
  } finally {
    process.env.NODE_ENV = previousEnv;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    rollups.runCronStep = originalStep;
    opsMonitor.runHourlyDigest = originalDigest;
  }
});
