'use strict';
/**
 * Admin statistics drill-down (superadmin «Статистика»).
 * Any element with data-drill inside #adminPaneAnalytics opens a full-screen sheet:
 *   data-drill="events"   data-drill-type="call|cta|view|…" [data-drill-mode="callrate"]
 *   data-drill="list"     data-drill-list="users|providers|clients|locations|claimed|photos|prices|views|pro"
 *   data-drill="location" data-drill-id="loc-…"
 *   data-drill="online"
 * Uses globals from admin.html: apiFetch, esc, showAdminPane, openLocationDetail, openUserDetail.
 */
(function () {
  const TYPE_META = {
    call: ['📞', 'Дзвінок', 'Дзвінки'],
    chat: ['💬', 'Написати', 'Написати'],
    directions: ['🧭', 'Маршрут', 'Маршрути'],
    map_focus: ['🗺️', 'На карті', 'На карті'],
    share: ['↗', 'Поділитись', 'Поділитись'],
    favorite: ['☆', 'В обране', 'В обране'],
    order: ['🛒', 'Замовлення', 'Замовлення'],
    claim: ['🔑', 'Claim (забрати картку)', 'Claim'],
    review: ['⭐', 'Відгук', 'Відгуки'],
    report: ['⚑', 'Скарга', 'Скарги'],
    dive: ['🔎', 'Детальніше', 'Детальніше'],
    view: ['👁', 'Перегляд картки', 'Перегляди карток'],
    page_view: ['📄', 'Перегляд сторінки', 'Перегляди сторінок'],
    search: ['🔍', 'Пошук', 'Пошукові запити'],
    login: ['🔐', 'Вхід', 'Входи'],
    register: ['🆕', 'Реєстрація', 'Реєстрації'],
    donate: ['💛', 'Клік «Донат»', 'Кліки «Донат»'],
    subscribe: ['⭐', 'Клік «Pro»', 'Кліки «Pro»'],
    support: ['🛟', 'Звернення', 'Звернення в підтримку'],
  };
  const LOCATION_TYPES = ['call', 'chat', 'directions', 'map_focus', 'share', 'favorite', 'order', 'claim', 'review', 'report', 'dive', 'view'];
  const ROLE_LABEL = { provider: 'майстер', client: 'клієнт', admin: 'адмін', guest: 'гість' };
  const RANGES = [
    ['today', 'Сьогодні'],
    ['yesterday', 'Вчора'],
    ['7d', '7 днів'],
    ['30d', '30 днів'],
    ['all', 'Усе'],
    ['custom', 'Період…'],
  ];
  const LIST_TITLES = {
    users: 'Користувачі',
    providers: 'Провайдери (майстри)',
    clients: 'Клієнти',
    admins: 'Адміни',
    locations: 'Локації',
    claimed: 'Локації з власником',
    unclaimed: 'Локації без власника',
    photos: 'Локації з фото',
    prices: 'Локації з прайсом',
    views: 'Перегляди карток за весь час',
    pro: 'Активні Pro',
    trial: 'У пробному періоді',
  };

  const h = (s) => (typeof esc === 'function' ? esc(s == null ? '' : String(s)) : String(s == null ? '' : s));
  const typeIcon = (t) => (TYPE_META[t] || ['•'])[0];
  const typeOne = (t) => (TYPE_META[t] || [null, t])[1];
  const typeMany = (t) => (TYPE_META[t] || [null, null, t])[2];

  function fmtTime(iso, withYear) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const sameYear = d.getFullYear() === new Date().getFullYear();
      return d.toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        day: '2-digit',
        month: '2-digit',
        ...(withYear || !sameYear ? { year: 'numeric' } : {}),
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return String(iso);
    }
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch (_) {
      return String(iso);
    }
  }
  function dayLabel(ymd) {
    const p = String(ymd || '').split('-');
    return p.length === 3 ? `${p[2]}.${p[1]}` : ymd;
  }
  function kyivToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  /* ---------- styles ---------- */
  const css = `
  .dr-overlay{position:fixed;inset:0;z-index:5000;background:rgba(15,23,42,.45);display:none}
  .dr-overlay.open{display:block}
  .dr-sheet{position:absolute;inset:0;background:#f8fafc;overflow:auto;-webkit-overflow-scrolling:touch}
  @media (min-width:900px){.dr-sheet{inset:24px auto 24px 50%;transform:translateX(-50%);width:820px;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.25)}}
  .dr-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-bottom:1px solid #e5e7eb}
  .dr-head h3{flex:1;margin:0;font-size:1.02rem;line-height:1.25;overflow:hidden;text-overflow:ellipsis}
  .dr-iconbtn{border:1px solid #e5e7eb;background:#fff;border-radius:10px;min-width:40px;height:40px;font-size:1.1rem;cursor:pointer}
  .dr-body{padding:12px 12px 40px}
  .dr-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:8px;scrollbar-width:none}
  .dr-chip{flex:0 0 auto;border:1px solid #d1d5db;background:#fff;border-radius:999px;padding:7px 12px;font-size:.85rem;font-weight:600;cursor:pointer;white-space:nowrap}
  .dr-chip.on{background:#0f766e;border-color:#0f766e;color:#fff}
  .dr-custom{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
  .dr-custom input{padding:7px;border:1px solid #d1d5db;border-radius:10px;font-size:.9rem}
  .dr-custom button{padding:8px 12px;border-radius:10px;border:0;background:#0f766e;color:#fff;font-weight:700}
  .dr-check{display:flex;align-items:center;gap:6px;font-size:.8rem;color:#475569;margin:2px 0 10px}
  .dr-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:10px}
  .dr-sum .k{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px}
  .dr-sum .k b{display:block;font-size:1.35rem;color:#0f766e}
  .dr-sum .k span{font-size:.75rem;color:#64748b;font-weight:700}
  .dr-sum .k.click{cursor:pointer}
  .dr-sum .k.on{border-color:#0f766e;box-shadow:0 0 0 1px #0f766e}
  .dr-note{font-size:.78rem;color:#64748b;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:8px 10px;margin-bottom:10px}
  .dr-bars{display:flex;align-items:flex-end;gap:3px;height:110px;overflow-x:auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:8px 8px 4px;margin-bottom:10px}
  .dr-bar{flex:1 0 18px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;cursor:pointer}
  .dr-bar i{display:block;width:100%;max-width:26px;background:#14b8a6;border-radius:4px 4px 0 0;min-height:2px}
  .dr-bar.zero i{background:#e2e8f0}
  .dr-bar em{font-style:normal;font-size:.62rem;color:#0f766e;font-weight:700;min-height:12px}
  .dr-bar small{font-size:.58rem;color:#94a3b8;white-space:nowrap}
  .dr-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid #e5e7eb;margin-bottom:10px;scrollbar-width:none}
  .dr-tab{flex:0 0 auto;border:0;background:none;padding:9px 10px;font-weight:700;font-size:.85rem;color:#64748b;border-bottom:2px solid transparent;cursor:pointer}
  .dr-tab.on{color:#0f766e;border-bottom-color:#0f766e}
  .dr-row{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:10px 12px;margin-bottom:6px;display:flex;gap:10px;align-items:flex-start}
  .dr-row.tap{cursor:pointer}
  .dr-row.tap:active{background:#f0fdfa}
  .dr-row .main{flex:1;min-width:0}
  .dr-row .t{font-weight:700;font-size:.92rem;word-break:break-word}
  .dr-row .m{font-size:.78rem;color:#64748b;margin-top:2px;word-break:break-word}
  .dr-row .n{font-weight:800;font-size:1.05rem;color:#0f766e;white-space:nowrap}
  .dr-row .bar{height:4px;background:#ccfbf1;border-radius:4px;margin-top:6px}
  .dr-row .bar i{display:block;height:4px;background:#14b8a6;border-radius:4px}
  .dr-ev .top{display:flex;justify-content:space-between;gap:8px;font-size:.8rem;color:#475569}
  .dr-ev .top b{color:#0f172a}
  .dr-link{border:0;background:none;padding:0;color:#0f766e;font-weight:700;text-align:left;cursor:pointer;font-size:.92rem}
  .dr-badge{display:inline-block;font-size:.68rem;font-weight:700;border-radius:999px;padding:1px 7px;background:#f1f5f9;color:#475569;margin-right:4px}
  .dr-badge.warn{background:#fff7ed;color:#c2410c}
  .dr-badge.ok{background:#dcfce7;color:#166534}
  .dr-more{display:block;width:100%;padding:11px;border-radius:12px;border:1px solid #d1d5db;background:#fff;font-weight:700;margin-top:6px;cursor:pointer}
  .dr-locinfo{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin-bottom:10px}
  .dr-locinfo .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .dr-locinfo .acts a,.dr-locinfo .acts button{padding:8px 12px;border-radius:10px;border:1px solid #0f766e;color:#0f766e;background:#fff;font-weight:700;text-decoration:none;font-size:.85rem;cursor:pointer}
  .dr-empty{color:#64748b;font-size:.88rem;padding:14px 4px}
  .dr-overlay button{width:auto;font-family:inherit;line-height:1.2}
  .dr-overlay .dr-iconbtn,.dr-overlay .dr-iconbtn:hover{background:#fff;color:#0f172a;padding:0}
  .dr-overlay .dr-chip,.dr-overlay .dr-chip:hover{background:#fff;color:#0f172a;border:1px solid #d1d5db;padding:7px 12px;border-radius:999px;font-size:.85rem}
  .dr-overlay .dr-chip.on,.dr-overlay .dr-chip.on:hover{background:#0f766e;border-color:#0f766e;color:#fff}
  .dr-overlay .dr-tab,.dr-overlay .dr-tab:hover{background:none;color:#64748b;border-radius:0;padding:9px 10px;font-size:.85rem}
  .dr-overlay .dr-tab.on,.dr-overlay .dr-tab.on:hover{color:#0f766e}
  .dr-overlay .dr-link,.dr-overlay .dr-link:hover{background:none;color:#0f766e;padding:0;border-radius:0;font-size:.92rem}
  .dr-overlay .dr-more,.dr-overlay .dr-more:hover{background:#fff;color:#0f172a;border:1px solid #d1d5db;width:100%}
  .dr-overlay .dr-custom button,.dr-overlay .dr-custom button:hover{background:#0f766e;color:#fff}
  .dr-overlay .dr-locinfo .acts button,.dr-overlay .dr-locinfo .acts button:hover{background:#fff;color:#0f766e;border:1px solid #0f766e;padding:8px 12px;font-size:.85rem}
  .dr-overlay label.dr-check{display:flex;font-weight:500;margin:2px 0 10px}
  .dr-overlay .dr-check input{width:18px;height:18px;margin:0;padding:0;flex:0 0 auto}
  .dr-overlay .dr-custom input{width:auto;flex:1 1 130px;margin:0}
  #adminPaneAnalytics [data-drill]{cursor:pointer;position:relative}
  #adminPaneAnalytics .stat-card[data-drill]::after{content:'›';position:absolute;right:10px;top:8px;color:#94a3b8;font-size:1.1rem}
  #adminPaneAnalytics .stat-card[data-drill]:active{transform:scale(.98)}
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const overlay = document.createElement('div');
  overlay.className = 'dr-overlay';
  overlay.innerHTML = '<div class="dr-sheet" role="dialog" aria-modal="true"><div class="dr-head"><button type="button" class="dr-iconbtn" data-dr-back aria-label="Назад">←</button><h3 id="drTitle"></h3><button type="button" class="dr-iconbtn" data-dr-close aria-label="Закрити">✕</button></div><div class="dr-body" id="drBody"></div></div>';
  document.body.appendChild(overlay);
  const titleEl = overlay.querySelector('#drTitle');
  const bodyEl = overlay.querySelector('#drBody');
  const sheetEl = overlay.querySelector('.dr-sheet');

  const state = {
    stack: [],
    range: { key: '30d', from: '', to: '' },
    includeAdmin: false,
    closingAll: false,
  };
  const cur = () => state.stack[state.stack.length - 1];

  /* ---------- navigation (works with the phone Back button) ---------- */
  function push(view) {
    state.stack.push(view);
    try {
      history.pushState({ mfDrill: state.stack.length }, '');
    } catch (_) {}
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    load(view);
  }
  function closeAll() {
    state.stack = [];
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
  window.addEventListener('popstate', () => {
    if (!state.stack.length) return;
    if (state.closingAll) {
      state.closingAll = false;
      closeAll();
      return;
    }
    state.stack.pop();
    if (!state.stack.length) closeAll();
    else render(cur());
  });
  overlay.querySelector('[data-dr-back]').addEventListener('click', () => history.back());
  overlay.querySelector('[data-dr-close]').addEventListener('click', () => {
    const n = state.stack.length;
    if (!n) return closeAll();
    state.closingAll = true;
    history.go(-n);
  });
  function leaveTo(fn) {
    const n = state.stack.length;
    closeAll();
    if (n) {
      state.closingAll = false;
      const onPop = () => {
        window.removeEventListener('popstate', onPop);
        fn();
      };
      window.addEventListener('popstate', onPop);
      history.go(-n);
    } else fn();
  }

  /* ---------- data ---------- */
  function rangeQuery() {
    const r = state.range;
    if (r.key === 'custom') return `from=${encodeURIComponent(r.from || '')}&to=${encodeURIComponent(r.to || r.from || '')}`;
    return `range=${encodeURIComponent(r.key)}`;
  }
  function eventsUrl(view, offset) {
    const p = [rangeQuery(), `limit=50`, `offset=${offset || 0}`];
    const type = view.kind === 'location' ? view.typeFilter || 'location' : view.type;
    if (type) p.push(`type=${encodeURIComponent(type)}`);
    if (view.kind === 'location') p.push(`locationId=${encodeURIComponent(view.id)}`);
    if (view.userId) p.push(`userId=${encodeURIComponent(view.userId)}`);
    if (state.includeAdmin) p.push('includeAdmin=1');
    return '/api/admin/analytics/events?' + p.join('&');
  }

  async function load(view) {
    titleEl.textContent = view.title || 'Деталі';
    bodyEl.innerHTML = '<p class="dr-empty">Завантаження…</p>';
    const seq = (view.seq = (view.seq || 0) + 1);
    try {
      if (view.kind === 'list') {
        view.data = await apiFetch(`/api/admin/analytics/list?kind=${encodeURIComponent(view.list)}`);
      } else if (view.kind === 'online') {
        view.data = { sessions: (window.adminAnalyticsLast?.live?.sessions || []).slice() };
      } else {
        view.data = await apiFetch(eventsUrl(view, 0));
        view.events = view.data.events || [];
      }
      if (view.seq !== seq || cur() !== view) return;
      render(view);
    } catch (err) {
      if (cur() !== view) return;
      bodyEl.innerHTML = `<p class="dr-empty" style="color:#b91c1c">${h(err.message)}</p>`;
    }
  }

  async function loadMore(view) {
    const d = view.data;
    if (!d || !d.hasMore) return;
    const next = await apiFetch(eventsUrl(view, (view.events || []).length));
    view.events = (view.events || []).concat(next.events || []);
    view.data.hasMore = next.hasMore;
    render(view);
  }

  /* ---------- render helpers ---------- */
  function rangeBar() {
    const r = state.range;
    const chips = RANGES.map(([k, label]) => `<button type="button" class="dr-chip${r.key === k ? ' on' : ''}" data-dr-range="${k}">${h(label)}</button>`).join('');
    const custom =
      r.key === 'custom'
        ? `<div class="dr-custom"><input type="date" id="drFrom" value="${h(r.from)}" max="${kyivToday()}"><span>—</span><input type="date" id="drTo" value="${h(r.to)}" max="${kyivToday()}"><button type="button" data-dr-apply>Показати</button></div>`
        : '';
    return `<div class="dr-chips">${chips}</div>${custom}<label class="dr-check"><input type="checkbox" data-dr-admin ${state.includeAdmin ? 'checked' : ''}> враховувати дії адмінів (мої тести)</label>`;
  }

  function sumCard(label, value, attrs) {
    return `<div class="k${attrs ? ' click' : ''}" ${attrs || ''}><b>${h(value)}</b><span>${h(label)}</span></div>`;
  }

  function dayBars(days) {
    if (!days || !days.length) return '';
    const max = Math.max(1, ...days.map((d) => d.count || 0));
    const today = kyivToday();
    const html = days
      .map((d) => {
        const pct = Math.max(d.count ? 6 : 2, Math.round(((d.count || 0) / max) * 100));
        return `<div class="dr-bar${d.count ? '' : ' zero'}" data-dr-day="${h(d.day)}" title="${h(d.day)}: ${d.count}"><em>${d.count || ''}</em><i style="height:${pct}%"></i><small>${d.day === today ? 'сьогодні' : h(dayLabel(d.day))}</small></div>`;
      })
      .join('');
    return `<div class="dr-bars" id="drBars">${html}</div>`;
  }

  function rowsList(items, lineFn, opts = {}) {
    if (!items || !items.length) return `<p class="dr-empty">${h(opts.empty || 'Порожньо')}</p>`;
    const max = Math.max(1, ...items.map((x) => x.count || 0));
    return items
      .map((x, i) => {
        const attrs = opts.attrs ? opts.attrs(x) : '';
        return `<div class="dr-row${attrs ? ' tap' : ''}" ${attrs}><div class="main"><div class="t">${i + 1}. ${lineFn(x)}</div>${opts.meta ? `<div class="m">${opts.meta(x)}</div>` : ''}${
          opts.noBar ? '' : `<div class="bar"><i style="width:${Math.round(((x.count || 0) / max) * 100)}%"></i></div>`
        }</div><div class="n">${h(opts.value ? opts.value(x) : x.count)}</div></div>`;
      })
      .join('');
  }

  function whoHtml(e) {
    if (e.user) return `👤 <b>${h(e.user.name)}</b>${e.user.role ? ` (${h(ROLE_LABEL[e.user.role] || e.user.role)})` : ''}`;
    if (e.legacy) return 'хто — невідомо';
    return `гість${e.session ? ` · відвідувач #${h(e.session)}` : ''}`;
  }

  function eventRow(e, view) {
    const loc = view.kind === 'location' ? null : e.location;
    const locHtml = loc
      ? `<div><button type="button" class="dr-link" data-dr-loc="${h(loc.id)}">${h(loc.title)}</button>${loc.exists ? '' : ' <span class="dr-badge warn">картку видалено</span>'}</div><div class="m">${h([loc.catName, loc.address].filter(Boolean).join(' · '))}</div>`
      : '';
    const extra = [];
    if (e.type === 'search' && e.meta?.q) extra.push(`«${h(e.meta.q)}»${e.meta.matched ? ' <span class="dr-badge ok">знайдено</span>' : ''}`);
    if (e.type === 'page_view' && e.path) extra.push(`<code>${h(e.path)}</code>`);
    if ((e.type === 'login' || e.type === 'register') && e.meta?.method) extra.push(`спосіб: ${h(e.meta.method)}`);
    const details = [e.device, e.source ? `джерело: ${e.source}` : ''].filter(Boolean).map(h).join(' · ');
    const legacy = e.legacy
      ? `<div class="m"><span class="dr-badge warn">старі дані</span>${e.meta?.counter > 1 ? 'час — останнього з кількох кліків' : 'до запуску детальної статистики'}</div>`
      : '';
    const showType = !(view.kind === 'events' && view.type && !view.type.includes(',') && !['cta', 'location', 'all'].includes(view.type));
    return `<div class="dr-row dr-ev"><div class="main"><div class="top"><b>${showType ? `${typeIcon(e.type)} ${h(typeOne(e.type))}` : h(fmtTime(e.at))}</b><span>${showType ? h(fmtTime(e.at)) : ''}</span></div>${locHtml}${
      extra.length ? `<div class="m">${extra.join(' · ')}</div>` : ''
    }<div class="m">${whoHtml(e)}</div>${details ? `<div class="m">${details}</div>` : ''}${legacy}</div></div>`;
  }

  function eventsTab(view) {
    const evs = view.events || [];
    if (!evs.length) return '<p class="dr-empty">За цей період подій немає.</p>';
    return evs.map((e) => eventRow(e, view)).join('') + (view.data.hasMore ? '<button type="button" class="dr-more" data-dr-more>Показати ще</button>' : '');
  }

  function locsTab(view) {
    const d = view.data;
    const callrate = view.mode === 'callrate';
    return rowsList(d.byLocation, (x) => `${h(x.title)}${x.exists ? '' : ' <span class="dr-badge warn">видалено</span>'}`, {
      empty: 'Немає подій по картках за цей період',
      attrs: (x) => `data-dr-loc="${h(x.id)}"`,
      meta: (x) => {
        const parts = [x.catName, x.address].filter(Boolean).map(h);
        const types = Object.entries(x.byType || {})
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `${typeIcon(t)} ${n}`)
          .join(' ');
        if (types && Object.keys(x.byType || {}).length > 1) parts.push(types);
        if (callrate || view.type === 'view') parts.push(`👁 ${x.viewsAllTime} переглядів усього`);
        if (callrate) parts.push(`call rate ${x.viewsAllTime ? Math.round((x.count / x.viewsAllTime) * 1000) / 10 : 0}%`);
        return parts.join(' · ');
      },
    });
  }

  function simpleTab(items, empty, fmt) {
    return rowsList(items, (x) => (fmt ? fmt(x) : h(x.key)), { empty });
  }

  function usersTab(view) {
    return rowsList(view.data.byUser, (x) => `${h(x.name)}${x.role ? ` <span class="dr-badge">${h(ROLE_LABEL[x.role] || x.role)}</span>` : ''}`, {
      empty: 'Дій від зареєстрованих користувачів немає',
      attrs: (x) => (x.id ? `data-dr-user="${h(x.id)}"` : ''),
    });
  }

  /* ---------- views ---------- */
  function renderEvents(view) {
    const d = view.data;
    if (d.ok === false) {
      bodyEl.innerHTML = rangeBar() + `<p class="dr-empty" style="color:#b91c1c">${h(d.error || 'Немає даних')}</p>`;
      return;
    }
    const isLoc = view.kind === 'location';
    const parts = [];
    if (isLoc) {
      const L = d.location;
      if (L) {
        const at = L.allTime || {};
        const allTime = LOCATION_TYPES.filter((t) => t !== 'view' && at[t]).map((t) => `${typeIcon(t)} ${at[t]}`).join(' · ');
        parts.push(`<div class="dr-locinfo"><div class="t" style="font-weight:800">${h(L.title)}${L.trashed ? ' <span class="dr-badge warn">у кошику</span>' : ''}</div><div class="m" style="font-size:.8rem;color:#64748b">${h(
          [L.catName, L.address].filter(Boolean).join(' · ')
        )}</div><div class="m" style="font-size:.8rem;color:#64748b;margin-top:4px">Власник: ${h(L.ownerName || 'немає')} · 📷 ${L.photos} · прайс: ${L.prices}</div><div class="m" style="font-size:.8rem;color:#64748b;margin-top:4px">За весь час: 👁 ${L.viewsAllTime}${allTime ? ' · ' + allTime : ''}</div><div class="acts"><a href="${h(L.url)}" target="_blank" rel="noopener">Відкрити на сайті ↗</a><button type="button" data-dr-admin-loc="${h(L.id)}">Редагувати картку</button></div></div>`);
      }
    }
    parts.push(rangeBar());

    if (isLoc) {
      const bt = d.byType || {};
      const all = Object.values(bt).reduce((a, n) => a + n, 0);
      const chips = [`<div class="k click${!view.typeFilter ? ' on' : ''}" data-dr-tf=""><b>${view.typeFilter ? '…' : all}</b><span>Усі події</span></div>`]
        .concat(
          LOCATION_TYPES.filter((t) => bt[t] || view.typeFilter === t).map(
            (t) => `<div class="k click${view.typeFilter === t ? ' on' : ''}" data-dr-tf="${t}"><b>${bt[t] || 0}</b><span>${typeIcon(t)} ${h(typeMany(t))}</span></div>`
          )
        )
        .join('');
      parts.push(`<div class="dr-sum">${chips}</div>`);
    } else {
      const sum = [sumCard('Подій', d.total)];
      sum.push(sumCard('Унікальних відвідувачів', d.uniqueSessions));
      sum.push(sumCard(d.uniqueUsers ? `Від зареєстрованих (${d.uniqueUsers} ос.)` : 'Від зареєстрованих', d.loggedInEvents));
      if (d.byLocation?.length) sum.push(sumCard('Карток', d.byLocation.length));
      const bt = Object.entries(d.byType || {});
      if (bt.length > 1) bt.sort((a, b) => b[1] - a[1]).forEach(([t, n]) => sum.push(sumCard(`${typeIcon(t)} ${typeMany(t)}`, n, `data-dr-open-type="${t}"`)));
      parts.push(`<div class="dr-sum">${sum.join('')}</div>`);
    }

    const notes = [];
    if (d.legacyCount) notes.push(`${d.legacyCount} з ${d.total} — старі дані (до 08.10.2026): відомо лише картку й час останнього кліку, без того, хто натискав.`);
    if (view.type === 'view' || view.type === 'page_view' || view.type === 'login') notes.push('Детальні події пишуться з 08.10.2026; загальні лічильники за весь час — на головному екрані статистики.');
    if (d.adminExcluded) notes.push(`Приховано ${d.adminExcluded} дій адмінів.`);
    if (d.truncated) notes.push('Показано перші 10 000 подій — звузьте період.');
    if (notes.length) parts.push(`<div class="dr-note">${notes.map(h).join('<br>')}</div>`);

    parts.push(dayBars(d.byDay));

    const tabs = [];
    if (!isLoc && (d.byLocation?.length || LOCATION_TYPES.includes(view.type) || view.type === 'cta')) tabs.push(['locs', 'По картках']);
    if (view.type === 'view') tabs.push(['alltime', 'За весь час']);
    tabs.push(['events', 'Події']);
    if (view.type === 'search') tabs.push(['queries', 'Запити']);
    if (view.type === 'page_view') tabs.push(['paths', 'Сторінки']);
    tabs.push(['sources', 'Джерела']);
    tabs.push(['devices', 'Пристрої']);
    if (d.byUser?.length) tabs.push(['users', 'Хто']);
    if (!view.tab || !tabs.some(([k]) => k === view.tab)) view.tab = tabs[0][0];
    parts.push(`<div class="dr-tabs">${tabs.map(([k, l]) => `<button type="button" class="dr-tab${view.tab === k ? ' on' : ''}" data-dr-tab="${k}">${h(l)}</button>`).join('')}</div>`);

    let content = '';
    if (view.tab === 'locs') content = locsTab(view);
    else if (view.tab === 'events') content = eventsTab(view);
    else if (view.tab === 'queries') content = simpleTab(d.byQuery, 'Запитів немає', (x) => `«${h(x.key)}»`);
    else if (view.tab === 'paths') content = simpleTab(d.byPath, 'Сторінок немає', (x) => `<code>${h(x.key)}</code>`);
    else if (view.tab === 'sources') content = simpleTab(d.bySource, 'Немає даних') + '<p class="dr-empty" style="font-size:.75rem">Джерело — utm-мітка або сайт, з якого перейшли (Google, Facebook, Telegram…). Для дій на картках береться з першого заходу цього відвідувача.</p>';
    else if (view.tab === 'devices') content = simpleTab(d.byDevice, 'Немає даних');
    else if (view.tab === 'users') content = usersTab(view);
    else if (view.tab === 'alltime') content = '<div id="drAllTime"><p class="dr-empty">Завантаження…</p></div>';
    parts.push(`<div id="drTab">${content}</div>`);
    bodyEl.innerHTML = parts.join('');

    const onTab = bodyEl.querySelector('.dr-tab.on');
    if (onTab && onTab.parentElement) {
      const bar = onTab.parentElement;
      if (onTab.offsetLeft + onTab.offsetWidth > bar.clientWidth) bar.scrollLeft = onTab.offsetLeft - 16;
    }
    const bars = bodyEl.querySelector('#drBars');
    if (bars) bars.scrollLeft = bars.scrollWidth;
    if (view.tab === 'alltime') {
      apiFetch('/api/admin/analytics/list?kind=views')
        .then((res) => {
          const el = bodyEl.querySelector('#drAllTime');
          if (el) el.innerHTML = locationRows((res.rows || []).filter((r) => r.views > 0), 'views');
        })
        .catch((err) => {
          const el = bodyEl.querySelector('#drAllTime');
          if (el) el.innerHTML = `<p class="dr-empty">${h(err.message)}</p>`;
        });
    }
  }

  function locationRows(rows, valueKey) {
    return rowsList(
      rows.map((r) => ({ ...r, count: r[valueKey || 'views'] })),
      (x) => h(x.title),
      {
        empty: 'Порожньо',
        attrs: (x) => `data-dr-loc="${h(x.id)}"`,
        meta: (x) =>
          [x.catName, x.address, `👁 ${x.views}`, `📞 ${x.call}`, `усі кліки ${x.ctaTotal}`, `📷 ${x.photos}`, `прайс ${x.prices}`, x.ownerName ? `власник: ${x.ownerName}` : 'без власника']
            .filter(Boolean)
            .map(h)
            .join(' · '),
      }
    );
  }

  function renderList(view) {
    const d = view.data || {};
    const rows = d.rows || [];
    const head = `<div class="dr-sum">${sumCard('Усього', d.total ?? rows.length)}</div>`;
    let html = '';
    if (['users', 'providers', 'clients', 'admins'].includes(view.list)) {
      html = rowsList(
        rows.map((r) => ({ ...r, count: r.cards })),
        (x) => `${h(x.name)} <span class="dr-badge">${h(ROLE_LABEL[x.role] || x.role)}</span>`,
        {
          empty: 'Порожньо',
          noBar: true,
          value: (x) => (x.cards ? `${x.cards} карт.` : ''),
          attrs: (x) => `data-dr-user="${h(x.id)}"`,
          meta: (x) =>
            [
              x.createdAt ? `з ${fmtDate(x.createdAt)}` : 'дата реєстрації невідома',
              x.telegram ? 'Telegram' : '',
              x.google ? 'Google' : '',
              x.apple ? 'Apple' : '',
              x.email ? 'email' : '',
              x.login && x.login !== x.name ? `логін ${x.login}` : '',
            ]
              .filter(Boolean)
              .map(h)
              .join(' · '),
        }
      );
    } else if (['pro', 'trial'].includes(view.list)) {
      html = rowsList(
        rows.map((r) => ({ ...r, count: 0 })),
        (x) => h(x.name),
        {
          empty: view.list === 'pro' ? 'Активних Pro поки немає' : 'Порожньо',
          noBar: true,
          value: (x) => (x.activePaid ? 'Pro' : x.inTrial ? 'пробний' : ''),
          attrs: (x) => (x.id ? `data-dr-user="${h(x.id)}"` : ''),
          meta: (x) =>
            [
              x.paidUntil ? `оплачено до ${fmtDate(x.paidUntil)}` : '',
              x.lastPaidAt ? `остання оплата ${fmtDate(x.lastPaidAt)}${x.lastAmount ? ` (${x.lastAmount} грн)` : ''}` : '',
              x.trialStartedAt ? `пробний з ${fmtDate(x.trialStartedAt)}` : '',
            ]
              .filter(Boolean)
              .map(h)
              .join(' · '),
        }
      );
    } else {
      html = locationRows(rows, 'views');
    }
    bodyEl.innerHTML = head + html;
  }

  function renderOnline(view) {
    const ss = view.data.sessions || [];
    bodyEl.innerHTML =
      `<div class="dr-sum">${sumCard('Зараз на сайті', ss.length)}</div>` +
      (ss.length
        ? ss
            .map(
              (s) =>
                `<div class="dr-row"><div class="main"><div class="t"><code>${h(s.path || '/')}</code></div><div class="m">${h(ROLE_LABEL[s.role] || s.role || 'гість')} · активність ${h(fmtTime(s.at))}</div></div></div>`
            )
            .join('')
        : '<p class="dr-empty">Зараз нікого немає.</p>') +
      '<p class="dr-empty" style="font-size:.75rem">Онлайн — ті, хто був активний за останні 90 секунд.</p>';
  }

  function render(view) {
    titleEl.textContent = view.title || 'Деталі';
    overlay.querySelector('[data-dr-back]').style.visibility = state.stack.length > 1 ? 'visible' : 'hidden';
    if (!view.data) return load(view);
    if (view.kind === 'list') renderList(view);
    else if (view.kind === 'online') renderOnline(view);
    else renderEvents(view);
  }

  /* ---------- interactions inside the sheet ---------- */
  bodyEl.addEventListener('click', (ev) => {
    const view = cur();
    if (!view) return;
    const t = ev.target.closest('[data-dr-range],[data-dr-apply],[data-dr-tab],[data-dr-loc],[data-dr-user],[data-dr-more],[data-dr-day],[data-dr-tf],[data-dr-open-type],[data-dr-admin-loc]');
    if (!t) return;
    if (t.dataset.drRange) {
      const k = t.dataset.drRange;
      if (k === 'custom') {
        const today = kyivToday();
        state.range = { key: 'custom', from: state.range.from || today, to: state.range.to || today };
        render(view);
        return;
      }
      state.range = { key: k, from: '', to: '' };
      view.data = null;
      load(view);
    } else if (t.hasAttribute('data-dr-apply')) {
      const from = bodyEl.querySelector('#drFrom')?.value || '';
      const to = bodyEl.querySelector('#drTo')?.value || from;
      if (!from) return;
      state.range = { key: 'custom', from, to };
      load(view);
    } else if (t.dataset.drTab) {
      view.tab = t.dataset.drTab;
      render(view);
    } else if (t.hasAttribute('data-dr-more')) {
      t.disabled = true;
      t.textContent = 'Завантаження…';
      loadMore(view).catch((err) => {
        t.textContent = err.message;
      });
    } else if (t.dataset.drDay) {
      state.range = { key: 'custom', from: t.dataset.drDay, to: t.dataset.drDay };
      view.tab = 'events';
      load(view);
    } else if (t.hasAttribute('data-dr-tf')) {
      view.typeFilter = t.dataset.drTf || '';
      view.tab = 'events';
      load(view);
    } else if (t.dataset.drOpenType) {
      const type = t.dataset.drOpenType;
      push({ kind: 'events', type, title: `${typeIcon(type)} ${typeMany(type)}` });
    } else if (t.dataset.drAdminLoc) {
      const id = t.dataset.drAdminLoc;
      leaveTo(() => {
        showAdminPane('locations', { keepDetail: true });
        openLocationDetail(id);
      });
    } else if (t.dataset.drLoc) {
      const id = t.dataset.drLoc;
      const raw = t.classList.contains('dr-link') ? t.textContent : t.querySelector('.t')?.textContent;
      const title = String(raw || 'Картка').replace(/^\d+\.\s*/, '').replace(/\s*видалено\s*$/, '');
      push({ kind: 'location', id, title: title.trim() });
    } else if (t.dataset.drUser) {
      const id = t.dataset.drUser;
      leaveTo(() => {
        showAdminPane('users');
        if (typeof openUserDetail === 'function') openUserDetail(id);
      });
    }
  });
  bodyEl.addEventListener('change', (ev) => {
    const view = cur();
    if (view && ev.target.matches('[data-dr-admin]')) {
      state.includeAdmin = ev.target.checked;
      load(view);
    }
  });

  /* ---------- entry points ---------- */
  function specFromEl(el) {
    const kind = el.dataset.drill;
    const title = el.dataset.drillTitle || el.querySelector('.stat-label, .metric-chart-title')?.textContent || '';
    if (kind === 'events') return { kind, type: el.dataset.drillType || 'all', mode: el.dataset.drillMode || '', title };
    if (kind === 'list') return { kind, list: el.dataset.drillList, title: title || LIST_TITLES[el.dataset.drillList] || 'Список' };
    if (kind === 'location') return { kind, id: el.dataset.drillId, title: title || 'Картка' };
    if (kind === 'online') return { kind, title: title || 'Зараз на сайті' };
    return null;
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('#adminPaneAnalytics [data-drill]');
    if (!el) return;
    const spec = specFromEl(el);
    if (!spec) return;
    ev.preventDefault();
    push(spec);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.stack.length) overlay.querySelector('[data-dr-close]').click();
    const el = ev.target.closest?.('#adminPaneAnalytics [data-drill]');
    if (el && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      el.click();
    }
  });
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.querySelector('[data-dr-close]').click();
  });

  window.AdminStatsDrill = {
    open: (spec) => push(spec),
    TYPE_META,
  };
  void sheetEl;
})();
