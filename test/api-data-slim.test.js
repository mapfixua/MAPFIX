'use strict';

require('./env.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = require('../server.js');

function request(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/data omits review bodies and stays under 400 KB', async (t) => {
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const res = await request(port, '/api/data');
  assert.equal(res.status, 200);
  assert.ok(res.body.length < 400 * 1024, `payload ${res.body.length} bytes`);
  const data = JSON.parse(res.body.toString('utf8'));
  assert.ok(Array.isArray(data.mockLocations) && data.mockLocations.length > 0);
  assert.ok(data.masterCatalog && typeof data.masterCatalog === 'object');
  for (const loc of data.mockLocations) {
    assert.equal(Object.prototype.hasOwnProperty.call(loc, 'reviews'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loc, 'workingHours'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loc, 'schedule'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(loc, 'photos'), false);
    assert.ok(loc.id && loc.title);
    assert.equal(typeof loc.lat, 'number');
    assert.equal(typeof loc.lng, 'number');
  }

  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const withReviews = (file.mockLocations || []).find(
    (loc) => loc && loc.id && Array.isArray(loc.reviews) && loc.reviews.length && !loc.deletedAt
  );
  assert.ok(withReviews, 'fixture with reviews');
  const listed = data.mockLocations.find((loc) => loc.id === withReviews.id);
  assert.ok(listed, 'reviewed card stays on the map payload');
  assert.equal(listed.reviewsCount, withReviews.reviewsCount);
  if (withReviews.text === 'Знайдено на Google Maps' && String(withReviews.workingHours || '').trim()) {
    assert.notEqual(listed.text, withReviews.text);
    assert.match(listed.text, /10:00/);
    assert.doesNotMatch(listed.text, /Google/i);
  }

  const detailRes = await request(port, '/api/locations/' + encodeURIComponent(withReviews.id));
  assert.equal(detailRes.status, 200);
  const detail = JSON.parse(detailRes.body.toString('utf8')).location;
  assert.equal(detail.id, withReviews.id);
  assert.ok(Array.isArray(detail.reviews) && detail.reviews.length > 0);
  assert.equal(detail.reviews[0].text, withReviews.reviews[0].text);
  assert.equal(typeof detail.workingHours, 'string');
  assert.equal(detail.text, listed.text);
  assert.ok(detail.workingHours);
});
