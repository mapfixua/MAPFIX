'use strict';

(function () {
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function dedupLabel(status) {
    const text = String(status || '');
    if (text === 'new') return 'нова';
    if (text.startsWith('duplicate_of ')) return 'дубль ' + text.slice('duplicate_of '.length);
    if (text.startsWith('possible_branch_of ')) return 'можливий філіал ' + text.slice('possible_branch_of '.length);
    if (text.startsWith('matches_deleted ')) return 'збіг із видаленою ' + text.slice('matches_deleted '.length);
    if (text.startsWith('matches_claimed ')) return 'зайнята майстром ' + text.slice('matches_claimed '.length);
    return text;
  }

  let map = null;
  let layer = null;

  function ensureMap() {
    const el = document.getElementById('placesV2Map');
    if (!el || typeof L === 'undefined') return null;
    if (!map) {
      map = L.map(el).setView([50.45, 30.52], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    setTimeout(() => map.invalidateSize(), 60);
    return map;
  }

  function showOnMap(rows) {
    const view = ensureMap();
    if (!view || !layer) return;
    layer.clearLayers();
    const points = (rows || []).filter((row) => Number.isFinite(Number(row.proposed_lat)) && Number.isFinite(Number(row.proposed_lng)));
    points.forEach((row) => {
      const marker = L.circleMarker([Number(row.proposed_lat), Number(row.proposed_lng)], {
        radius: 7,
        color: row.dedup_status === 'new' ? '#0f766e' : '#b45309',
        weight: 2,
        fillOpacity: 0.85,
      });
      marker.bindPopup(`<b>${esc(row.proposed_title)}</b><br>${esc(row.proposed_address || '')}<br>${esc(dedupLabel(row.dedup_status))}`);
      marker.addTo(layer);
    });
    if (points.length === 1) {
      view.setView([Number(points[0].proposed_lat), Number(points[0].proposed_lng)], 15);
    } else if (points.length > 1) {
      view.fitBounds(points.map((row) => [Number(row.proposed_lat), Number(row.proposed_lng)]), { padding: [24, 24] });
    }
  }

  function setMsg(text, isError) {
    const el = document.getElementById('placesV2Msg');
    if (!el) return;
    el.style.display = text ? 'block' : 'none';
    el.className = 'msg ' + (isError ? 'err' : 'ok');
    el.textContent = text || '';
  }

  async function api(url, options) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function loadPlacesV2() {
    const wave = document.getElementById('placesV2Wave')?.value || 'A';
    const status = document.getElementById('placesV2Status')?.value || '';
    const list = document.getElementById('placesV2List');
    const summary = document.getElementById('placesV2Summary');
    if (!list) return;
    list.innerHTML = '<p class="list-item-meta">Завантаження…</p>';
    setMsg('');
    await loadWaveStats();
    try {
      const query = new URLSearchParams({ wave });
      if (status) query.set('status', status);
      const data = await api('/api/admin/places-v2/candidates?' + query.toString(), { method: 'GET' });
      const rows = data.candidates || [];
      if (summary) {
        summary.textContent = rows.length
          ? `${rows.length} у черзі. Зелені мітки на карті — нові, жовті — потрібне рішення.`
          : 'Черга порожня. «Запустити хвилю A» заповнює її короткими кроками і нічого не публікує на карту.';
      }
      showOnMap(rows);
      if (!rows.length) {
        list.innerHTML = '<p class="list-item-meta">Немає рядків для цього фільтра.</p>';
        return;
      }
      list.innerHTML = rows
        .map((row) => {
          const services = Array.isArray(row.proposed_services) ? row.proposed_services.join(', ') : '';
          const subs = Array.isArray(row.proposed_subcats) ? row.proposed_subcats.join(', ') : '';
          const confidence =
            row.classifier_confidence == null ? '—' : Number(row.classifier_confidence).toFixed(2);
          const review = row.last_review_at ? String(row.last_review_at).slice(0, 10) : 'немає дати';
          const canAct = row.status === 'pending' || row.status === 'approved';
          return `<article class="list-item" data-lat="${esc(row.proposed_lat)}" data-lng="${esc(row.proposed_lng)}">
            <div class="list-item-head">
              <div>
                <div class="list-item-title">${esc(row.proposed_title || row.place_id)}</div>
                <div class="list-item-meta">${esc(row.proposed_address || '')}</div>
              </div>
              <span class="badge">${esc(row.status)}</span>
            </div>
            <div class="list-item-meta">
              ${esc(row.proposed_cat || '—')} / ${esc(subs || '—')}
              ${services ? ' · ' + esc(services) : ''}
            </div>
            <div class="list-item-meta">Дедуп: ${esc(dedupLabel(row.dedup_status))}${row.needs_review ? ' · ручна перевірка' : ''}</div>
            <div class="list-item-meta">Впевненість ${esc(confidence)} · останній відгук ${esc(review)} · ${esc(row.business_status || '')}</div>
            ${row.status === 'needs_classify' ? '<div class="list-item-meta">Класифікація не завершена. «Перекласифікувати» повторить її без Google.</div>' : ''}
            ${row.reject_reason ? `<div class="list-item-meta">Причина: ${esc(row.reject_reason)}</div>` : ''}
            <div class="list-item-actions">
              <button type="button" class="btn-small" data-focus="${esc(row.id)}">На карті</button>
              ${canAct ? `<button type="button" class="btn-small" data-approve="${esc(row.id)}">Схвалити</button>` : ''}
              ${row.status !== 'published' ? `<button type="button" class="btn-small btn-danger" data-reject="${esc(row.id)}">Відхилити</button>` : ''}
            </div>
          </article>`;
        })
        .join('');
    } catch (err) {
      list.innerHTML = '';
      setMsg(err.message, true);
    }
  }

  document.addEventListener('click', async (event) => {
    const focus = event.target?.closest?.('[data-focus]');
    const approve = event.target?.closest?.('[data-approve]');
    const reject = event.target?.closest?.('[data-reject]');
    if (focus) {
      const card = focus.closest('.list-item');
      const lat = Number(card?.dataset.lat);
      const lng = Number(card?.dataset.lng);
      const view = ensureMap();
      if (view && Number.isFinite(lat) && Number.isFinite(lng)) view.setView([lat, lng], 16);
    }
    if (approve) {
      try {
        await api('/api/admin/places-v2/candidates/' + encodeURIComponent(approve.dataset.approve) + '/approve', {
          method: 'POST',
          body: '{}',
        });
        setMsg('Схвалено');
        await loadPlacesV2();
      } catch (err) {
        setMsg(err.message, true);
      }
    }
    if (reject) {
      try {
        await api('/api/admin/places-v2/candidates/' + encodeURIComponent(reject.dataset.reject) + '/reject', {
          method: 'POST',
          body: JSON.stringify({ reason: 'admin_rejected' }),
        });
        setMsg('Відхилено');
        await loadPlacesV2();
      } catch (err) {
        setMsg(err.message, true);
      }
    }
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setProgress(text) {
    const el = document.getElementById('placesV2RunProgress');
    if (el) el.textContent = text || '';
  }

  function setRunButtons(disabled) {
    ['placesV2RunWave', 'placesV2ResetWave', 'placesV2Backfill', 'placesV2BackfillWrite', 'placesV2Reclassify'].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = disabled;
    });
  }

  function dedupProgress(data) {
    const buckets = data?.counts?.dedupBuckets || {};
    return `нові ${buckets.new || 0} · дублі ${buckets.duplicate || 0} · філіали ${buckets.branch || 0} · видалені ${buckets.deleted || 0} · зайняті ${buckets.claimed || 0}`;
  }

  function formatWaveProgress(data) {
    const req = data.requests || {};
    const counts = data.counts || {};
    const processed = data.processed ?? counts.pairsProcessed ?? 0;
    const total = data.total ?? counts.pairsTotal ?? 0;
    const httpStatus = counts.lastTextSearchHttpStatus;
    const errorBit = counts.lastTextSearchError
      ? ` · помилка Text Search${httpStatus ? ' HTTP ' + httpStatus : ''}`
      : '';
    const stop = data.stoppedReason || counts.stoppedReason;
    let stopBit = '';
    if (stop === 'google_quota') stopBit = ' · зупинка: денна квота Google';
    else if (stop === 'google_billing') stopBit = ' · зупинка: оплата або доступ Google';
    else if (stop === 'classifier_quota') stopBit = ' · зупинка: денна квота класифікатора (Gemini 429)';
    else if (stop) stopBit = ` · зупинка: ${stop}`;
    return `Пари ${processed} / ${total} · Text Search ${req.textSearch ?? counts.textSearch ?? 0} / ${req.maxTextSearch ?? 800} · Details ${req.details ?? counts.details ?? 0} / ${req.maxDetails ?? 800} · у черзі ${counts.staged ?? 0} · ${dedupProgress(data)}${errorBit}${stopBit}`;
  }

  function waveStopReason(reason) {
    return reason === 'text_search_error' || reason === 'google_quota' || reason === 'google_billing' || reason === 'classifier_quota';
  }

  function waveStopMessage(data) {
    const detail = data?.counts?.lastTextSearchError || '';
    if (data?.stoppedReason === 'google_quota') {
      return `Хвилю A зупинено: денна квота Google Places вичерпана (HTTP 429). Локальний ліміт Text Search не зменшено. ${detail}`.trim();
    }
    if (data?.stoppedReason === 'google_billing') {
      return `Хвилю A зупинено: Google відхилив Text Search (оплата або доступ, HTTP 403). ${detail}`.trim();
    }
    if (data?.stoppedReason === 'classifier_quota') {
      return 'Хвилю A зупинено: денна безкоштовна квота Gemini вичерпана (HTTP 429). Нові запити Text Search і Place Details не виконуються. Кандидати лишаються needs_classify — «Перекласифікувати» повторить класифікацію зі збережених даних, без Google.';
    }
    if (data?.stoppedReason === 'text_search_error') {
      return `Хвилю A зупинено після трьох однакових помилок Text Search. ${detail} Натисніть «Запустити хвилю A» ще раз, щоб повторити ці пари, або «Скинути хвилю A».`.trim();
    }
    return '';
  }

  function showTextSearchError(data) {
    const el = document.getElementById('placesV2RunError');
    if (!el) return;
    const message = data?.counts?.lastTextSearchError || '';
    if (!message) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    const status = data.counts.lastTextSearchHttpStatus;
    el.style.display = 'block';
    el.textContent = `Text Search${status ? ' HTTP ' + status : ''}: ${message}`;
  }

  async function loadWaveStats() {
    const wave = document.getElementById('placesV2Wave')?.value || 'A';
    try {
      const data = await api('/api/admin/places-v2/run?wave=' + encodeURIComponent(wave), { method: 'GET' });
      if (!data?.counts) return;
      setProgress(formatWaveProgress(data));
      showTextSearchError(data);
    } catch (_) {
      /* queue still loads when the run row is missing */
    }
  }

  function formatBackfillProgress(data) {
    const req = data.requests || {};
    const counts = data.counts || {};
    const mode = data.write ? 'запис' : 'dry-run';
    return `Backfill (${mode}) ${data.processed || 0} / ${data.total || 0} · впевнені ${counts.confident || 0} · пропущено ${counts.skipped || 0} · записано ${counts.written || 0} · Text Search ${req.textSearch || 0} / ${req.maxTextSearch || 500}`;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function loopChunks(url, body, onProgress) {
    let restart = false;
    for (let step = 0; step < 500; step += 1) {
      const payload = { ...body };
      if (restart) payload.restart = true;
      restart = false;
      const data = await api(url, { method: 'POST', body: JSON.stringify(payload) });
      onProgress(data);
      if (data.busy) {
        await sleep(1500);
        continue;
      }
      if (waveStopReason(data.stoppedReason)) return data;
      if (data.alreadyDone) {
        const again = window.confirm('Цей запуск уже завершено. Почати спочатку? Кеш зменшить повторні запити до Places.');
        if (!again) return data;
        restart = true;
        continue;
      }
      if (data.done) return data;
      await sleep(250);
    }
    throw new Error('Забагато кроків. Натисніть ще раз — курсор збережено, запуск продовжиться.');
  }

  document.getElementById('placesV2Reload')?.addEventListener('click', () => loadPlacesV2());
  document.getElementById('placesV2Status')?.addEventListener('change', () => loadPlacesV2());
  document.getElementById('placesV2Bulk')?.addEventListener('click', async () => {
    const wave = document.getElementById('placesV2Wave')?.value || 'A';
    try {
      const data = await api('/api/admin/places-v2/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({ wave }),
      });
      setMsg(`Схвалено ${data.approved} нових із високою впевненістю`);
      await loadPlacesV2();
    } catch (err) {
      setMsg(err.message, true);
    }
  });
  document.getElementById('placesV2Reclassify')?.addEventListener('click', async () => {
    const wave = document.getElementById('placesV2Wave')?.value || 'A';
    setRunButtons(true);
    setMsg('');
    let reclassified = 0;
    let stillPending = 0;
    try {
      let cursor = null;
      for (let step = 0; step < 200; step += 1) {
        const data = await api('/api/admin/places-v2/reclassify', {
          method: 'POST',
          body: JSON.stringify({ wave, cursor }),
        });
        reclassified += data.reclassified || 0;
        stillPending += data.stillPending || 0;
        const quota = data.stoppedReason === 'classifier_quota';
        setProgress(
          `Перекласифікація: ${reclassified} готово · ще без класифікації ${stillPending}${quota ? ' · зупинка: денна квота класифікатора' : ''}`
        );
        if (quota) {
          await loadPlacesV2();
          setProgress(
            `Перекласифікація: ${reclassified} готово · ще без класифікації ${stillPending} · зупинка: денна квота класифікатора`
          );
          setMsg('Класифікатор зупинено: денна безкоштовна квота Gemini (HTTP 429). Запити до Google не виконувались. Натисніть «Перекласифікувати» після відновлення квоти.', true);
          return;
        }
        if (data.done) break;
        cursor = data.nextCursor;
        await sleep(250);
      }
      await loadPlacesV2();
      setMsg(`Перекласифіковано ${reclassified}. Ще очікують класифікації: ${stillPending}. На карту нічого не публікується.`);
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setRunButtons(false);
    }
  });

  document.getElementById('placesV2Publish')?.addEventListener('click', async () => {
    const wave = document.getElementById('placesV2Wave')?.value || 'A';
    if (!window.confirm('Опублікувати схвалені рядки цієї хвилі на карту? Дублі, видалені й зайняті картки буде пропущено.')) return;
    try {
      const data = await api('/api/admin/places-v2/publish', {
        method: 'POST',
        body: JSON.stringify({ wave }),
      });
      setMsg(`Опубліковано ${data.published}. Пропущено ${data.skipped?.length || 0}.`);
      await loadPlacesV2();
    } catch (err) {
      setMsg(err.message, true);
    }
  });

  document.getElementById('placesV2RunWave')?.addEventListener('click', async () => {
    setRunButtons(true);
    setMsg('');
    try {
      const data = await loopChunks('/api/admin/places-v2/run', { wave: 'A' }, (step) => {
        setProgress(formatWaveProgress(step));
        showTextSearchError(step);
      });
      const pause = waveStopMessage(data);
      if (pause) {
        await loadPlacesV2();
        showTextSearchError(data);
        setProgress(formatWaveProgress(data));
        setMsg(pause, true);
        return;
      }
      const reason = data.stoppedReason ? ` · зупинка: ${data.stoppedReason}` : '';
      setMsg(`Хвилю A завершено. У черзі ${data.counts?.staged || 0}.${reason}`);
      await loadPlacesV2();
    } catch (err) {
      setMsg(`${err.message} Можна натиснути ще раз — курсор збережено.`, true);
    } finally {
      setRunButtons(false);
    }
  });

  document.getElementById('placesV2ResetWave')?.addEventListener('click', async () => {
    if (!window.confirm('Скинути курсор хвилі A і повторити пари з помилкою Text Search? Уже зібрані кандидати лишаться в черзі.')) return;
    setRunButtons(true);
    setMsg('');
    try {
      const data = await api('/api/admin/places-v2/reset-wave', {
        method: 'POST',
        body: JSON.stringify({ wave: 'A' }),
      });
      if (data.busy) {
        setMsg('Хвиля зараз виконується. Зачекайте і спробуйте скинути ще раз.', true);
        return;
      }
      if (data.reset !== true) {
        setMsg('Не вдалося скинути хвилю.', true);
        return;
      }
      setProgress(formatWaveProgress(data));
      showTextSearchError(data);
      setMsg('Хвилю A скинуто. Лічильники Text Search і Details обнулено, курсор на початку.');
      await loadWaveStats();
    } catch (err) {
      setMsg(err.message, true);
    } finally {
      setRunButtons(false);
    }
  });

  document.getElementById('placesV2Backfill')?.addEventListener('click', async () => {
    setRunButtons(true);
    setMsg('');
    try {
      const data = await loopChunks('/api/admin/places-v2/backfill', {}, (step) => {
        setProgress(formatBackfillProgress(step));
      });
      if (data.report) downloadJson('place-id-backfill.json', data.report);
      setMsg(`Dry-run завершено. Впевнені збіги: ${data.counts?.confident || 0}. Картки не змінювались.`);
    } catch (err) {
      setMsg(`${err.message} Можна натиснути ще раз — курсор збережено.`, true);
    } finally {
      setRunButtons(false);
    }
  });

  document.getElementById('placesV2BackfillWrite')?.addEventListener('click', async () => {
    if (!window.confirm('Записати знайдені Google place id у наявні картки? Зміниться лише поле google_place_id. Назву, телефон, адресу й інші поля не буде перезаписано.')) {
      return;
    }
    setRunButtons(true);
    setMsg('');
    try {
      const data = await loopChunks('/api/admin/places-v2/backfill', { write: true }, (step) => {
        setProgress(formatBackfillProgress(step));
      });
      setMsg(`Записано google_place_id: ${data.counts?.written || 0}. Інші поля карток не змінювались.`);
    } catch (err) {
      setMsg(`${err.message} Можна натиснути ще раз — курсор збережено.`, true);
    } finally {
      setRunButtons(false);
    }
  });

  window.loadPlacesV2 = loadPlacesV2;
})();
