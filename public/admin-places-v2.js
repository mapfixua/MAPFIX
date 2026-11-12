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
    try {
      const query = new URLSearchParams({ wave });
      if (status) query.set('status', status);
      const data = await api('/api/admin/places-v2/candidates?' + query.toString(), { method: 'GET' });
      const rows = data.candidates || [];
      if (summary) {
        summary.textContent = rows.length
          ? `${rows.length} у черзі. Зелені мітки на карті — нові, жовті — потрібне рішення.`
          : 'Черга порожня. Хвилю запускають скриптом import-places-v2.js (dry-run пише лише сюди).';
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

  window.loadPlacesV2 = loadPlacesV2;
})();
