/**
 * Синхронізація даних карти між вкладками (admin ↔ index).
 * Після змін у data.json адмінка викликає notifyChange(),
 * карта підписується через subscribe() і робить свіжий fetch.
 */
(function (global) {
  const KEY = 'mapfix:dataVersion';
  const CHANNEL = 'mapfix-data-sync';
  let lastVersion = global.__mapfixDataVersion || null;
  let channel = null;

  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch (_) {
    channel = null;
  }

  function getVersion() {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  }

  function notifyChange() {
    const version = String(Date.now());
    try {
      localStorage.setItem(KEY, version);
    } catch (_) {}
    if (channel) {
      channel.postMessage({ type: 'data-changed', version });
    }
    lastVersion = version;
    global.__mapfixDataVersion = version;
  }

  function shouldRefresh(version) {
    if (!version) return false;
    if (lastVersion === null) {
      lastVersion = version;
      global.__mapfixDataVersion = version;
      return false;
    }
    if (version === lastVersion) return false;
    lastVersion = version;
    global.__mapfixDataVersion = version;
    return true;
  }

  function subscribe(callback) {
    const stored = getVersion();
    if (stored) {
      lastVersion = stored;
      global.__mapfixDataVersion = stored;
    }

    const runIfNew = (version) => {
      if (shouldRefresh(version)) callback(version);
    };

    window.addEventListener('storage', (e) => {
      if (e.key === KEY && e.newValue) runIfNew(e.newValue);
    });

    if (channel) {
      channel.onmessage = (e) => {
        if (e.data?.type === 'data-changed') runIfNew(e.data.version);
      };
    }

    const checkStored = () => runIfNew(getVersion());

    window.addEventListener('focus', checkStored);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkStored();
    });
    window.addEventListener('pageshow', checkStored);
  }

  global.MapfixDataSync = { notifyChange, subscribe, getVersion, KEY };
})(window);
