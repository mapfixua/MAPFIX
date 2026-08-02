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

    window.MapfixAnalytics = {
      sid: sid,
      page: function (path) {
        post('/api/analytics/page', { path: path || pathNow(), sid: sid });
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
