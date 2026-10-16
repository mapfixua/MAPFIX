'use strict';
/**
 * Lightweight client analytics for Mapfix.
 * Include on public pages: <script src="/mf-analytics.js" defer></script>
 */
(function () {
  try {
    var KEY = 'mf_sid';
    var sid = localStorage.getItem(KEY);
    if (!sid) {
      sid =
        (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        's-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(KEY, sid);
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

    function pathNow() {
      return window.location.pathname || '/';
    }

    function readUtm() {
      try {
        var params = new URLSearchParams(window.location.search);
        var source = (params.get('utm_source') || '').trim();
        if (source) {
          var utm = {
            source: source.slice(0, 48),
            medium: (params.get('utm_medium') || '').trim().slice(0, 48),
            campaign: (params.get('utm_campaign') || '').trim().slice(0, 48),
            content: (params.get('utm_content') || '').trim().slice(0, 48),
            term: (params.get('utm_term') || '').trim().slice(0, 48),
          };
          sessionStorage.setItem('mf_utm', JSON.stringify(utm));
          return utm;
        }
        var stored = sessionStorage.getItem('mf_utm');
        return stored ? JSON.parse(stored) : null;
      } catch (_) {
        return null;
      }
    }

    var utm = readUtm();

    // External referrer of this visit (host only is kept server-side).
    function readRef() {
      try {
        var r = document.referrer || '';
        if (r && r.indexOf(window.location.host) === -1) {
          sessionStorage.setItem('mf_ref', r.slice(0, 300));
          return r.slice(0, 300);
        }
        return sessionStorage.getItem('mf_ref') || '';
      } catch (_) {
        return '';
      }
    }

    var ref = readRef();

    window.MapfixAnalytics = {
      sid: sid,
      page: function (path) {
        post('/api/analytics/page', { path: path || pathNow(), sid: sid, utm: utm, ref: ref });
      },
      search: function (query, source, matched) {
        post('/api/analytics/search', {
          query: query,
          source: source || 'search',
          matched: !!matched,
          sid: sid,
        });
      },
      event: function (name) {
        post('/api/analytics/event', { name: name, sid: sid, path: pathNow() });
      },
      heartbeat: function () {
        post('/api/analytics/heartbeat', { sid: sid, path: pathNow() });
      },
    };

    // Initial page view + presence
    window.MapfixAnalytics.page();
    window.MapfixAnalytics.heartbeat();
    setInterval(function () {
      window.MapfixAnalytics.heartbeat();
    }, 30000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        window.MapfixAnalytics.heartbeat();
      }
    });
  } catch (_) {}
})();
