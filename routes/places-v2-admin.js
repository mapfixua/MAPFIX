'use strict';

const { planWave } = require('../places-v2.js');
const { getWave } = require('../places-waves.js');
const { executeWaveChunk, executeWaveReset, executeBackfillChunk, waveRunId, describeWaveRun } = require('../places-chunk.js');
const { executeReclassifyChunk } = require('../places-reclassify.js');
const { searchBackfillCandidates } = require('../places-backfill.js');
const { createSupabasePlacesCache } = require('../places-cache-store.js');
const { getImportRun, saveImportRun, writeGooglePlaceId } = require('../import-runs-store.js');
const { getServiceRoleClient } = require('../supabaseClient.js');
const {
  upsertImportCandidates,
  listImportCandidates,
  listImportCandidatesNeedingClassify,
  listStagedForDedup,
  getImportCandidate,
  updateImportCandidate,
  bulkApproveImportCandidates,
  approvable,
} = require('../import-candidates-store.js');
const { selectPublishable } = require('../places-publish.js');

function migrationHint(message) {
  const text = String(message || '');
  if (/needs_classify|import_candidates_status_chk/i.test(text)) {
    return 'Застосуйте міграцію supabase/migrations/025_import_candidates_needs_classify.sql у Supabase SQL editor.';
  }
  if (/import_runs|import_candidates|places_response_cache|schema cache|does not exist|Could not find the table/i.test(text)) {
    return 'Застосуйте міграцію supabase/migrations/022_places_import_chunks_and_rls.sql у Supabase SQL editor.';
  }
  return text.slice(0, 300);
}

function requireServiceRole(res) {
  if (getServiceRoleClient()) return true;
  res.status(503).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not set' });
  return false;
}

async function readRun(id) {
  const loaded = await getImportRun(id);
  if (!loaded.ok) throw new Error(migrationHint(loaded.error?.message));
  return loaded.row;
}

async function writeRun(row) {
  const saved = await saveImportRun(row);
  if (!saved.ok) throw new Error(migrationHint(saved.error?.message));
}

function placesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
}

function mountPlacesV2Admin(app, deps) {
  const { requireAuth, requireAdmin, readData, persistLocationsPatch } = deps;

  app.get('/api/admin/places-v2/plan', requireAuth, requireAdmin, (req, res) => {
    try {
      const plan = planWave(req.query.wave || 'A');
      res.json({
        ok: true,
        wave: plan.wave,
        label: plan.label,
        targets: plan.targets,
        tileCount: plan.tileCount,
        plannedTextSearch: plan.plannedTextSearch,
        note: 'One Text Search per target per tile. Place Details run only for listings that pass OPERATIONAL, the Kyiv+Коцюбинське polygon, userRatingCount >= 1, and (for bakeries) the bakery filter, and that are not an exact place_id duplicate. Caps default to 800 Text Search and 800 Details per run.',
      });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Невідома хвиля' });
    }
  });

  app.get('/api/admin/places-v2/candidates', requireAuth, requireAdmin, async (req, res) => {
    try {
      const listed = await listImportCandidates({
        wave: req.query.wave ? String(req.query.wave).toUpperCase() : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
        limit: Number(req.query.limit) || 200,
      });
      if (!listed.ok) {
        return res.status(500).json({ error: migrationHint(listed.error?.message) || 'Не вдалося прочитати чергу' });
      }
      res.json({ ok: true, candidates: listed.rows });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Не вдалося прочитати чергу' });
    }
  });

  app.get('/api/admin/places-v2/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!requireServiceRole(res)) return;
      const waveDef = getWave(req.query.wave || 'A');
      const row = await readRun(waveRunId({
        wave: waveDef.id,
        query: '',
        tileStart: null,
        tileCount: null,
        hasTile: false,
      }));
      res.json(describeWaveRun(row, waveDef.id));
    } catch (err) {
      console.error('[GET /api/admin/places-v2/run]', err.message);
      res.status(500).json({ error: migrationHint(err.message) || 'Не вдалося прочитати запуск' });
    }
  });

  app.post('/api/admin/places-v2/reset-wave', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!requireServiceRole(res)) return;
      getWave(req.body?.wave || 'A');
      const payload = await executeWaveReset({
        body: req.body || {},
        getRun: readRun,
        saveRun: writeRun,
      });
      if (payload && payload.ok === false) {
        return res.status(payload.status || 409).json({ error: payload.error || 'Не вдалося скинути хвилю' });
      }
      res.json(payload);
    } catch (err) {
      console.error('[POST /api/admin/places-v2/reset-wave]', err.message);
      res.status(500).json({ error: migrationHint(err.message) || 'Не вдалося скинути хвилю' });
    }
  });

  app.post('/api/admin/places-v2/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!requireServiceRole(res)) return;
      if (!placesApiKey()) {
        return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not set' });
      }
      getWave(req.body?.wave || 'A');
      const data = await readData();
      const payload = await executeWaveChunk({
        body: req.body || {},
        locations: data.mockLocations || [],
        masterCatalog: data.masterCatalog || {},
        apiKey: placesApiKey(),
        geminiApiKey: process.env.GEMINI_API_KEY,
        cacheStore: createSupabasePlacesCache(),
        minIntervalMs: undefined,
        getRun: readRun,
        saveRun: writeRun,
        listStaged: async (wave) => {
          const listed = await listStagedForDedup(wave);
          if (!listed.ok) throw new Error(migrationHint(listed.error?.message));
          return listed.rows;
        },
        upsertCandidates: async (rows) => {
          const saved = await upsertImportCandidates(rows);
          if (!saved.ok) {
            return { ok: false, error: { message: migrationHint(saved.error?.message) } };
          }
          return saved;
        },
      });
      res.json(payload);
    } catch (err) {
      console.error('[POST /api/admin/places-v2/run]', err.message);
      const status = /Немає цілі|Невідома хвиля/.test(err.message || '') ? 400 : 500;
      res.status(status).json({ error: migrationHint(err.message) || 'Хвиля не виконана' });
    }
  });

  app.post('/api/admin/places-v2/reclassify', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!requireServiceRole(res)) return;
      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({ error: 'GEMINI_API_KEY is not set' });
      }
      const data = await readData();
      const payload = await executeReclassifyChunk({
        body: req.body || {},
        masterCatalog: data.masterCatalog || {},
        geminiApiKey: process.env.GEMINI_API_KEY,
        listCandidates: async (query) => {
          const listed = await listImportCandidatesNeedingClassify(query);
          if (!listed.ok) throw new Error(migrationHint(listed.error?.message));
          return listed.rows;
        },
        updateCandidate: async (id, patch) => {
          const updated = await updateImportCandidate(id, patch);
          if (!updated.ok) throw new Error(migrationHint(updated.error?.message));
          return updated.row;
        },
      });
      res.json(payload);
    } catch (err) {
      console.error('[POST /api/admin/places-v2/reclassify]', err.message);
      res.status(500).json({ error: migrationHint(err.message) || 'Перекласифікацію не виконано' });
    }
  });

  app.post('/api/admin/places-v2/backfill', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (!requireServiceRole(res)) return;
      if (!placesApiKey()) {
        return res.status(503).json({ error: 'GOOGLE_PLACES_API_KEY is not set' });
      }
      const write = req.body?.write === true;
      const data = await readData();
      const apiKey = placesApiKey();
      const payload = await executeBackfillChunk({
        body: req.body || {},
        loadLocations: async () => data.mockLocations || [],
        search: (loc) => searchBackfillCandidates(loc, apiKey),
        writePlaceId: write ? writeGooglePlaceId : null,
        cacheStore: createSupabasePlacesCache(),
        getRun: readRun,
        saveRun: writeRun,
      });
      res.json(payload);
    } catch (err) {
      console.error('[POST /api/admin/places-v2/backfill]', err.message);
      res.status(500).json({ error: migrationHint(err.message) || 'Backfill не виконано' });
    }
  });

  app.post('/api/admin/places-v2/candidates/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
      const found = await getImportCandidate(req.params.id);
      if (!found.ok) return res.status(500).json({ error: found.error?.message || 'Помилка' });
      if (!found.row) return res.status(404).json({ error: 'Кандидата не знайдено' });
      if (!approvable(found.row)) {
        return res.status(409).json({
          error: 'Цей рядок не публікується автоматично. Дублікат, видалена або зайнята картка лишається на перевірці — відхиліть її або відновіть локацію окремо.',
          dedupStatus: found.row.dedup_status,
        });
      }
      const updated = await updateImportCandidate(found.row.id, { status: 'approved', reject_reason: null });
      if (!updated.ok) return res.status(500).json({ error: updated.error?.message || 'Помилка' });
      res.json({ ok: true, candidate: updated.row });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Помилка' });
    }
  });

  app.post('/api/admin/places-v2/candidates/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
      const found = await getImportCandidate(req.params.id);
      if (!found.ok) return res.status(500).json({ error: found.error?.message || 'Помилка' });
      if (!found.row) return res.status(404).json({ error: 'Кандидата не знайдено' });
      if (found.row.status === 'published') {
        return res.status(409).json({ error: 'Уже опубліковано' });
      }
      const updated = await updateImportCandidate(found.row.id, {
        status: 'rejected',
        reject_reason: String(req.body?.reason || found.row.reject_reason || 'admin_rejected').slice(0, 200),
      });
      if (!updated.ok) return res.status(500).json({ error: updated.error?.message || 'Помилка' });
      res.json({ ok: true, candidate: updated.row });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Помилка' });
    }
  });

  app.post('/api/admin/places-v2/bulk-approve', requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await bulkApproveImportCandidates({
        wave: req.body?.wave ? String(req.body.wave).toUpperCase() : undefined,
        ids: Array.isArray(req.body?.ids) ? req.body.ids : undefined,
      });
      if (!result.ok) return res.status(500).json({ error: result.error?.message || 'Помилка' });
      res.json({ ok: true, approved: result.approved, considered: result.considered });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Помилка' });
    }
  });

  app.post('/api/admin/places-v2/publish', requireAuth, requireAdmin, async (req, res) => {
    try {
      const wave = req.body?.wave ? String(req.body.wave).toUpperCase() : undefined;
      const listed = await listImportCandidates({ wave, status: 'approved', limit: 500 });
      if (!listed.ok) return res.status(500).json({ error: listed.error?.message || 'Помилка' });
      const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
      const rows = listed.rows.filter((row) => !ids || ids.has(String(row.id)));
      const data = await readData();
      const { created, skipped } = selectPublishable(rows, data.mockLocations || [], data.masterCatalog || {});
      if (created.length) {
        const locs = created.map((item) => item.location);
        data.mockLocations = [...(data.mockLocations || []), ...locs];
        const saved = await persistLocationsPatch(data, locs);
        if (!saved.ok) {
          return res.status(500).json({ error: saved.error?.message || 'Не вдалося записати локації' });
        }
      }
      for (const item of created) {
        await updateImportCandidate(item.candidateId, {
          status: 'published',
          published_location_id: item.location.id,
        });
      }
      res.json({
        ok: true,
        importSource: 'places_v2',
        published: created.length,
        skipped,
      });
    } catch (err) {
      console.error('[POST /api/admin/places-v2/publish]', err.message);
      res.status(500).json({ error: err.message || 'Публікація не виконана' });
    }
  });
}

module.exports = { mountPlacesV2Admin };
