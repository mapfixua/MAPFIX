'use strict';
/**
 * Lightweight client analytics for Mapfix.
 * Include on public pages: <script src="/mf-analytics.js"></script>
 *
 * Visit source:
 * - sessionStorage `mf_utm` — this tab
 * - localStorage `mf_utm_first` — first UTM touch, kept 30 days; a later visit
 *   without UTM does not replace it
 * - localStorage `mf_visit_day` — last page_view day in Europe/Kyiv (YYYY-MM-DD)
 * - localStorage `mf_recent` — up to 8 recently opened cards
 */
(function () {
  try {
    if (window.MapfixAnalytics) return;

    var SID_KEY = 'mf_sid';
    var UTM_KEY = 'mf_utm';
    var FIRST_KEY = 'mf_utm_first';
    var REF_KEY = 'mf_ref';
    var VISIT_KEY = 'mf_visit_day';
    var RECENT_KEY = 'mf_recent';
    var FIRST_MS = 30 * 24 * 60 * 60 * 1000;
    var CLICK_KEYS = ['fbclid', 'gclid', 'ttclid', 'yclid'];
    var TRACK_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].concat(CLICK_KEYS);

    var sid = localStorage.getItem(SID_KEY);
    if (!sid) {
      sid =
        (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        's-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(SID_KEY, sid);
    }

    function post(url, body) {
      try {
        var payload = JSON.stringify(body);
        if (navigator.sendBeacon) {
          var blob = new Blob([payload], { type: 'application/json' });
          if (navigator.sendBeacon(url, blob)) return;
        }
        fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
        }).catch(function () {});
      } catch (_) {}
    }

    function clip(value, max) {
      var s = String(value == null ? '' : value).trim();
      return s ? s.slice(0, max) : '';
    }

    function readJson(storage, key) {
      try {
        var raw = storage.getItem(key);
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_) {
        return null;
      }
    }

    function toPublicUtm(raw) {
      if (!raw || typeof raw !== 'object') return null;
      var out = {};
      var source = clip(raw.source, 48);
      if (source) out.source = source;
      var medium = clip(raw.medium, 48);
      var campaign = clip(raw.campaign, 64);
      var content = clip(raw.content, 48);
      var term = clip(raw.term, 48);
      if (medium) out.medium = medium;
      if (campaign) out.campaign = campaign;
      if (content) out.content = content;
      if (term) out.term = term;
      for (var i = 0; i < CLICK_KEYS.length; i++) {
        var key = CLICK_KEYS[i];
        var value = clip(raw[key], 140);
        if (value) out[key] = value;
      }
      if (!out.source && !out.fbclid && !out.gclid && !out.ttclid && !out.yclid) return null;
      return out;
    }

    function writeSession(utm) {
      if (!utm) return;
      try {
        sessionStorage.setItem(UTM_KEY, JSON.stringify(utm));
      } catch (_) {}
    }

    function readFirstTouch() {
      var raw = readJson(localStorage, FIRST_KEY);
      if (!raw || !raw.source || !raw.ts) return null;
      if (Date.now() - Number(raw.ts) > FIRST_MS) {
        try {
          localStorage.removeItem(FIRST_KEY);
        } catch (_) {}
        return null;
      }
      return toPublicUtm(raw);
    }

    function saveFirstTouch(utm) {
      if (!utm || !utm.source || readFirstTouch()) return;
      try {
        var row = { ts: Date.now() };
        Object.keys(utm).forEach(function (key) {
          row[key] = utm[key];
        });
        localStorage.setItem(FIRST_KEY, JSON.stringify(row));
      } catch (_) {}
    }

    function clickIdsFromSearch(params) {
      var out = {};
      for (var i = 0; i < CLICK_KEYS.length; i++) {
        var key = CLICK_KEYS[i];
        var value = clip(params.get(key), 140);
        if (value) out[key] = value;
      }
      return out;
    }

    function hasClick(clicks) {
      return CLICK_KEYS.some(function (key) {
        return !!clicks[key];
      });
    }

    function mergeClickIds(base, clicks) {
      var out = {};
      if (base) {
        Object.keys(base).forEach(function (key) {
          if (key !== 'ts') out[key] = base[key];
        });
      }
      Object.keys(clicks || {}).forEach(function (key) {
        if (clicks[key]) out[key] = clicks[key];
      });
      return toPublicUtm(out);
    }

    function readUtm() {
      try {
        var params = new URLSearchParams(window.location.search);
        var source = clip(params.get('utm_source'), 48);
        var clicks = clickIdsFromSearch(params);
        if (source) {
          var fromUrl = { source: source };
          var medium = clip(params.get('utm_medium'), 48);
          var campaign = clip(params.get('utm_campaign'), 64);
          var content = clip(params.get('utm_content'), 48);
          var term = clip(params.get('utm_term'), 48);
          if (medium) fromUrl.medium = medium;
          if (campaign) fromUrl.campaign = campaign;
          if (content) fromUrl.content = content;
          if (term) fromUrl.term = term;
          var prev = toPublicUtm(readJson(sessionStorage, UTM_KEY));
          if (prev && prev.source === source) {
            CLICK_KEYS.forEach(function (key) {
              if (!clicks[key] && prev[key]) clicks[key] = prev[key];
            });
          }
          var current = mergeClickIds(fromUrl, clicks);
          writeSession(current);
          saveFirstTouch(current);
          return current;
        }
        var session = toPublicUtm(readJson(sessionStorage, UTM_KEY));
        if (session && session.source) {
          var mergedSession = mergeClickIds(session, clicks);
          if (hasClick(clicks)) writeSession(mergedSession);
          return mergedSession;
        }
        var first = readFirstTouch();
        if (first) {
          var mergedFirst = mergeClickIds(first, clicks);
          writeSession(mergedFirst);
          return mergedFirst;
        }
        if (session) {
          var mergedOnly = mergeClickIds(session, clicks);
          if (hasClick(clicks)) writeSession(mergedOnly);
          return mergedOnly;
        }
        if (hasClick(clicks)) {
          var onlyClicks = toPublicUtm(clicks);
          writeSession(onlyClicks);
          return onlyClicks;
        }
        return null;
      } catch (_) {
        return null;
      }
    }

    function readRef() {
      try {
        var r = document.referrer || '';
        if (r && r.indexOf(window.location.host) === -1) {
          sessionStorage.setItem(REF_KEY, r.slice(0, 300));
          return r.slice(0, 300);
        }
        return sessionStorage.getItem(REF_KEY) || '';
      } catch (_) {
        return '';
      }
    }

    function pathNow() {
      return window.location.pathname || '/';
    }

    function kyivDayKey(date) {
      var zones = ['Europe/Kyiv', 'Europe/Kiev'];
      for (var i = 0; i < zones.length; i++) {
        try {
          return new Intl.DateTimeFormat('en-CA', {
            timeZone: zones[i],
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(date || new Date());
        } catch (_) {}
      }
      return new Date(date || Date.now()).toISOString().slice(0, 10);
    }

    function consumeReturning() {
      var today = kyivDayKey(new Date());
      var prev = '';
      try {
        prev = localStorage.getItem(VISIT_KEY) || '';
      } catch (_) {}
      try {
        localStorage.setItem(VISIT_KEY, today);
      } catch (_) {}
      return prev && prev !== today ? 1 : 0;
    }

    function isStandalone() {
      try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.navigator && window.navigator.standalone === true) return true;
      } catch (_) {}
      return false;
    }

    function context() {
      var meta = {};
      if (isStandalone()) meta.standalone = 1;
      return {
        sid: sid,
        utm: readUtm(),
        ref: readRef(),
        path: pathNow(),
        meta: meta,
      };
    }

    function readRecent() {
      var raw = readJson(localStorage, RECENT_KEY);
      if (!Array.isArray(raw)) return [];
      var out = [];
      for (var i = 0; i < raw.length && out.length < 8; i++) {
        var item = raw[i];
        if (!item || typeof item !== 'object') continue;
        var id = clip(item.id, 80);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) continue;
        if (out.some(function (row) { return row.id === id; })) continue;
        out.push({ id: id, title: clip(item.title, 80) || id });
      }
      return out;
    }

    function rememberRecent(loc) {
      var id = clip(loc && loc.id, 80);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return readRecent();
      var title = clip(loc && loc.title, 80) || id;
      var list = readRecent().filter(function (row) { return row.id !== id; });
      list.unshift({ id: id, title: title });
      list = list.slice(0, 8);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } catch (_) {}
      return list;
    }

    function withTracking(href) {
      try {
        var u = new URL(href, window.location.origin);
        var utm = readUtm() || {};
        var cur = new URLSearchParams(window.location.search);
        var map = {
          utm_source: utm.source || '',
          utm_medium: utm.medium || '',
          utm_campaign: utm.campaign || '',
          utm_content: utm.content || '',
          utm_term: utm.term || '',
          fbclid: utm.fbclid || '',
          gclid: utm.gclid || '',
          ttclid: utm.ttclid || '',
          yclid: utm.yclid || '',
        };
        TRACK_KEYS.forEach(function (key) {
          if (!map[key]) map[key] = clip(cur.get(key), key.indexOf('utm_') === 0 ? 64 : 140);
          if (map[key] && !u.searchParams.has(key)) u.searchParams.set(key, map[key]);
        });
        return u.pathname + u.search + u.hash;
      } catch (_) {
        return href;
      }
    }

    window.MapfixAnalytics = {
      sid: sid,
      context: context,
      withTracking: withTracking,
      readRecent: readRecent,
      rememberRecent: rememberRecent,
      page: function (path) {
        var ctx = context();
        var meta = {};
        Object.keys(ctx.meta || {}).forEach(function (key) {
          meta[key] = ctx.meta[key];
        });
        if (consumeReturning()) meta.returning = 1;
        var body = { path: path || ctx.path, sid: ctx.sid, ref: ctx.ref || '' };
        if (ctx.utm) body.utm = ctx.utm;
        if (Object.keys(meta).length) body.meta = meta;
        post('/api/analytics/page', body);
      },
      search: function (query, source, matched, resultCount) {
        var ctx = context();
        var body = {
          query: query,
          source: source || 'search',
          matched: !!matched,
          sid: ctx.sid,
          utm: ctx.utm,
          ref: ctx.ref,
          path: ctx.path,
        };
        if (resultCount != null && resultCount !== '') {
          var n = Number(resultCount);
          if (isFinite(n) && n >= 0) {
            body.result_count = Math.min(32767, Math.round(n));
            body.matched = body.result_count > 0;
          }
        }
        post('/api/analytics/search', body);
      },
      event: function (name) {
        var ctx = context();
        post('/api/analytics/event', { name: name, sid: ctx.sid, path: ctx.path, utm: ctx.utm, ref: ctx.ref });
      },
      pwa: function (kind) {
        var ctx = context();
        post('/api/analytics/event', {
          name: kind === 'install' ? 'pwa_install' : 'pwa_banner',
          sid: ctx.sid,
          path: ctx.path,
          utm: ctx.utm,
          ref: ctx.ref,
          meta: ctx.meta,
        });
      },
      heartbeat: function () {
        post('/api/analytics/heartbeat', { sid: sid, path: pathNow() });
      },
    };

    window.MapfixAnalytics.page();
    window.MapfixAnalytics.heartbeat();
    setInterval(function () {
      window.MapfixAnalytics.heartbeat();
    }, 30000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') window.MapfixAnalytics.heartbeat();
    });
  } catch (_) {}
})();
