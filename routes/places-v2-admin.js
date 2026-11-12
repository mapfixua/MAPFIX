'use strict';

const fs = require('fs');
const path = require('path');
const { planWave, runWave } = require('../places-v2.js');
const { getWave } = require('../places-waves.js');
const {
  upsertImportCandidates,
  listImportCandidates,
  getImportCandidate,
  updateImportCandidate,
  bulkApproveImportCandidates,
  approvable,
} = require('../import-candidates-store.js');
const { selectPublishable } = require('../places-publish.js');

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
        return res.status(500).json({ error: listed.error?.message || 'Не вдалося прочитати чергу' });
      }
      res.json({ ok: true, candidates: listed.rows });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Не вдалося прочитати чергу' });
    }
  });

  app.post('/api/admin/places-v2/run', requireAuth, requireAdmin, async (req, res) => {
    try {
      const waveName = req.body?.wave || 'A';
      getWave(waveName);
      const data = await readData();
      const reportDir = path.join(process.cwd(), 'reports');
      let stagedCount = 0;
      const result = await runWave({
        wave: waveName,
        locations: data.mockLocations || [],
        masterCatalog: data.masterCatalog || {},
        apiKey: process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY,
        geminiApiKey: process.env.GEMINI_API_KEY,
        maxTextSearch: req.body?.maxTextSearch,
        maxDetails: req.body?.maxDetails,
        onStage: async (chunk) => {
          if (!chunk.length) return;
          const saved = await upsertImportCandidates(chunk);
          if (!saved.ok) {
            const message = saved.error?.message || 'staging failed';
            throw new Error(message);
          }
          stagedCount += saved.upserted;
        },
      });
      try {
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(
          path.join(reportDir, `places-v2-wave-${result.wave}.json`),
          JSON.stringify({ ...result, candidates: undefined, candidateCount: result.candidates.length }, null, 2)
        );
      } catch (_) {
        /* report file is optional */
      }
      res.json({
        ok: true,
        dryRun: true,
        publishedLocations: 0,
        wave: result.wave,
        label: result.label,
        stoppedReason: result.stoppedReason,
        counts: result.counts,
        cost: result.cost,
        staged: stagedCount,
      });
    } catch (err) {
      console.error('[POST /api/admin/places-v2/run]', err.message);
      res.status(500).json({ error: err.message || 'Хвиля не виконана' });
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
