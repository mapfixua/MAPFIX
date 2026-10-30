        function loadStylesheet(href) {
            return new Promise((resolve) => {
                const exists = [...document.querySelectorAll('link[rel="stylesheet"]')].some(
                    (n) => (n.href || '').includes(href.split('/').slice(-2).join('/')) || n.href === href
                );
                if (exists) {
                    resolve();
                    return;
                }
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                link.onload = () => resolve();
                link.onerror = () => resolve();
                document.head.appendChild(link);
            });
        }
        function loadScriptOnce(src) {
            return new Promise((resolve, reject) => {
                const exists = [...document.scripts].some((s) => s.src === src);
                if (exists && window.L) {
                    resolve();
                    return;
                }
                const el = document.createElement('script');
                el.src = src;
                el.async = true;
                el.onload = resolve;
                el.onerror = () => reject(new Error('Не вдалося завантажити карту'));
                document.head.appendChild(el);
            });
        }
        function loadLeafletBundle() {
            if (window.__leafletReady) return window.__leafletReady;
            window.__leafletReady = (async () => {
                await Promise.all([
                    loadStylesheet('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'),
                    loadStylesheet('https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css'),
                ]);
                if (!window.L) {
                    await loadScriptOnce('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
                }
                if (!window.L?.markerClusterGroup) {
                    await loadScriptOnce(
                        'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js'
                    );
                }
            })();
            return window.__leafletReady;
        }
        const leafletReady = loadLeafletBundle();

        async function loadCatalogData() {
            let lastErr;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await fetch('/api/data', { credentials: 'same-origin' });
                    if (!res.ok) throw new Error('Не вдалося завантажити каталог');
                    const data = await res.json();
                    window.masterCatalog = data.masterCatalog || {};
                    window.mockLocations = data.mockLocations || [];
                    window.providerProfiles = data.providerProfiles || {};
                    window.catalogClicks = data.catalogClicks || {};
                    return;
                } catch (err) {
                    lastErr = err;
                    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
                }
            }
            throw lastErr || new Error('Не вдалося завантажити каталог');
        }

        document.addEventListener("DOMContentLoaded", async () => {
            await leafletReady;
            // Paint map tiles after Leaflet is loaded — CSS/JS no longer block first paint.
            const map = L.map('map', { zoomControl: false }).setView([50.49, 30.33], 14);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

            function clusterIcon(cluster) {
                const count = cluster.getChildCount();
                const tier = count >= 25 ? 'lg' : count >= 10 ? 'md' : 'sm';
                const size = tier === 'lg' ? 50 : tier === 'md' ? 42 : 34;
                return L.divIcon({
                    html: `<div class="mapfix-cluster mapfix-cluster--${tier}"><span>${count}</span></div>`,
                    className: 'mapfix-cluster-wrap',
                    iconSize: [size, size],
                    iconAnchor: [size / 2, size / 2],
                });
            }

            const markersLayer = L.markerClusterGroup({
                // Wider radius at city zoom so the map stays readable before a category is chosen
                maxClusterRadius: (zoom) => (zoom < 12 ? 80 : zoom < 14 ? 56 : 40),
                spiderfyOnMaxZoom: true,
                disableClusteringAtZoom: 16,
                showCoverageOnHover: false,
                zoomToBoundsOnClick: true,
                chunkedLoading: true,
                animate: true,
                iconCreateFunction: clusterIcon,
            });
            map.addLayer(markersLayer);

            const KOTSIUBYNSKE_CENTER = { lat: 50.49, lng: 30.33 };
            const KOTSIUBYNSKE_ZOOM = 14;
            const NEAR_ME_RADIUS_KM = 3;
            const KYIV_CENTER = { lat: 50.4501, lng: 30.5234 };
            const KYIV_ZOOM = 11;
            const DEFAULT_CENTER = KOTSIUBYNSKE_CENTER;
            const USER_FOCUS_ZOOM = 13;
            const MAPFIX_AREAS = {
                sviatoshyn: { key: 'sviatoshyn', name: 'Святошин', on: 'Святошині', lat: 50.4574, lng: 30.3553, zoom: 13, radiusKm: 2 },
                svyatoshyn: { key: 'sviatoshyn', name: 'Святошин', on: 'Святошині', lat: 50.4574, lng: 30.3553, zoom: 13, radiusKm: 2 },
                borshchahivka: { key: 'borshchahivka', name: 'Борщагівка', on: 'Борщагівці', lat: 50.4378, lng: 30.338, zoom: 13, radiusKm: 3.5 },
                borschagivka: { key: 'borshchahivka', name: 'Борщагівка', on: 'Борщагівці', lat: 50.4378, lng: 30.338, zoom: 13, radiusKm: 3.5 },
                akademmistechko: { key: 'akademmistechko', name: 'Академмістечко', on: 'Академмістечку', lat: 50.4655, lng: 30.355, zoom: 14, radiusKm: 1.5 },
                kotsiubynske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347, zoom: 14, radiusKm: 3 },
                kotsyubynske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347, zoom: 14, radiusKm: 3 },
                kotsiubinske: { key: 'kotsiubynske', name: 'Коцюбинське', on: 'Коцюбинському', lat: 50.4906, lng: 30.3347, zoom: 14, radiusKm: 3 },
            };
            // Keep in sync with AREA_RADIUS_KM / AREA_ADDRESS_RE in seo.js.
            const AREA_ADDRESS_RE = {
                sviatoshyn: /святошин/i,
                borshchahivka: /борщаг/i,
                akademmistechko: /академмістеч/i,
                kotsiubynske: /коцюбин/i,
            };
            const AREA_KEYS = ['sviatoshyn', 'borshchahivka', 'akademmistechko', 'kotsiubynske'];

            const State = { 
                category: null, 
                subcategory: null, 
                service: null, 
                selectedLocation: null,
                detailMode: null,
                area: null,
                userCoords: { ...DEFAULT_CENTER },
                geoReady: false,
                onlyOpen: false,
                onlyPhone: false,
                onlyPrice: false,
                onlyRated: false,
                sortType: 'distance',
                nearMe: false,
                formRatingScore: 5,
                currentUser: null,
                favoriteIds: new Set(),
                locationSearchQuery: '',
                aiSuggestions: [],
                viewLock: null,
            };
            
            let userMarkerInstance = null;
            const geoBtn = document.getElementById('geo-btn');

            function calculateDistance(lat1, lon1, lat2, lon2) {
                const R = 6371;
                const dLat = (lat2 - lat1) * Math.PI / 180;
                const dLon = (lon2 - lon1) * Math.PI / 180;
                const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                          Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
                return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
            }

            function drawUserMarker() {
                if (!State.geoReady) return;
                if (userMarkerInstance) map.removeLayer(userMarkerInstance);
                userMarkerInstance = L.marker([State.userCoords.lat, State.userCoords.lng], {
                    icon: L.divIcon({
                        className: 'user-location-marker-wrap',
                        html: '<div class="user-location-marker" aria-hidden="true"></div>',
                        iconSize: [18, 18],
                        iconAnchor: [9, 9],
                    }),
                    zIndexOffset: 1200,
                    interactive: false,
                    keyboard: false,
                }).addTo(map);
            }

            function resolveMapArea(raw) {
                return MAPFIX_AREAS[String(raw || '').toLowerCase().trim()] || null;
            }

            function areaPlaceName() {
                const a = MAPFIX_AREAS[State.area];
                return a ? a.name : '';
            }

            function cityScopeTitle() {
                const a = MAPFIX_AREAS[State.area];
                if (!a) return ' у Києві';
                return ' на ' + (a.on || a.name);
            }

            function applyMapArea(area) {
                if (!area) return;
                State.area = area.key;
                map.setView([area.lat, area.lng], area.zoom, { animate: true });
            }

            function shouldAutoCenterOnUser() {
                if (State.viewLock) return false;
                if (State.selectedLocation) return false;
                return !State.category && !State.subcategory && !State.service && !State.locationSearchQuery && !State.area;
            }

            let nearCircle = null;

            function setNearMeMode(on) {
                State.nearMe = Boolean(on);
                if (geoBtn) {
                    geoBtn.classList.toggle('active', State.nearMe);
                    geoBtn.setAttribute('aria-pressed', State.nearMe ? 'true' : 'false');
                }
                if (nearCircle) {
                    map.removeLayer(nearCircle);
                    nearCircle = null;
                }
                if (State.nearMe && State.geoReady) {
                    nearCircle = L.circle([State.userCoords.lat, State.userCoords.lng], {
                        radius: NEAR_ME_RADIUS_KM * 1000,
                        color: '#12c4b5',
                        weight: 2,
                        fillColor: '#12c4b5',
                        fillOpacity: 0.08,
                        interactive: false,
                    }).addTo(map);
                }
            }

            function focusNearMe() {
                const ll = L.latLng(State.userCoords.lat, State.userCoords.lng);
                const bounds = typeof ll.toBounds === 'function'
                    ? ll.toBounds(NEAR_ME_RADIUS_KM * 2000)
                    : L.latLngBounds([
                        [State.userCoords.lat - 0.03, State.userCoords.lng - 0.04],
                        [State.userCoords.lat + 0.03, State.userCoords.lng + 0.04],
                    ]);
                map.fitBounds(bounds, { padding: [28, 28], animate: true, maxZoom: 16 });
            }

            function showWholeKyiv() {
                State.viewLock = 'kyiv';
                setNearMeMode(false);
                map.setView([KYIV_CENTER.lat, KYIV_CENTER.lng], KYIV_ZOOM, { animate: true });
                try { syncMapMarkers(); } catch (_) {}
            }

            (function bootMapFromUrl() {
                const boot = window.__MAPFIX_LANDING || {};
                const parts = window.location.pathname.split('/').filter(Boolean);
                const params = new URLSearchParams(window.location.search);
                if (parts[0] === 'p' && parts[1]) State.viewLock = 'place';
                const latRaw = params.get('lat');
                const lngRaw = params.get('lng');
                const lat = Number(latRaw);
                const lng = Number(lngRaw);
                if (
                    latRaw != null &&
                    lngRaw != null &&
                    latRaw !== '' &&
                    lngRaw !== '' &&
                    Number.isFinite(lat) &&
                    Number.isFinite(lng) &&
                    Math.abs(lat) <= 90 &&
                    Math.abs(lng) <= 180
                ) {
                    const zoomRaw = params.get('zoom') || params.get('z');
                    const zoomNum = Number(zoomRaw);
                    const zoom = zoomRaw && Number.isFinite(zoomNum) ? Math.min(18, Math.max(3, zoomNum)) : KOTSIUBYNSKE_ZOOM;
                    State.viewLock = 'url';
                    map.setView([lat, lng], zoom, { animate: false });
                    return;
                }
                const qArea = params.get('area');
                const pathArea = ((parts[0] === 'kyiv' || parts[0] === 'kiev') && resolveMapArea(parts[1]))
                    ? parts[1]
                    : null;
                const area = resolveMapArea(boot.area || qArea || pathArea);
                if (area) applyMapArea(area);
            })();

            function setUserLocation(lat, lng, { center = false, zoom = USER_FOCUS_ZOOM } = {}) {
                State.userCoords = { lat: Number(lat), lng: Number(lng) };
                State.geoReady = true;
                drawUserMarker();
                if (State.nearMe) setNearMeMode(true);
                if (center) {
                    if (State.nearMe) focusNearMe();
                    else map.setView([State.userCoords.lat, State.userCoords.lng], zoom, { animate: true });
                }
                if (State.nearMe) {
                    try { syncMapMarkers(); } catch (_) {}
                }
                if (State.service || State.locationSearchQuery) {
                    try { renderLocationList(); } catch (_) {}
                }
            }

            function locateUser({ center = true, fromButton = false } = {}) {
                if (!navigator.geolocation) {
                    State.nearMe = false;
                    try { setNearMeMode(false); } catch (_) {}
                    if (fromButton) alert('Геолокація не підтримується цим браузером');
                    return;
                }
                if (geoBtn) geoBtn.classList.add('locating');
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        if (geoBtn) geoBtn.classList.remove('locating');
                        setUserLocation(pos.coords.latitude, pos.coords.longitude, {
                            center: fromButton ? true : center && shouldAutoCenterOnUser(),
                            zoom: USER_FOCUS_ZOOM,
                        });
                    },
                    (err) => {
                        if (geoBtn) geoBtn.classList.remove('locating');
                        State.nearMe = false;
                        try { setNearMeMode(false); } catch (_) {}
                        try { syncMapMarkers(); } catch (_) {}
                        console.warn('[geo]', err && err.message ? err.message : err);
                        if (fromButton) {
                            const denied = err && err.code === 1;
                            alert(
                                denied
                                    ? 'Доступ до геолокації заборонено. Дозвольте його в налаштуваннях браузера.'
                                    : 'Не вдалося визначити місцезнаходження. Спробуйте ще раз.'
                            );
                        }
                    },
                    {
                        enableHighAccuracy: true,
                        timeout: 12000,
                        maximumAge: 30000,
                    }
                );
            }

            if (geoBtn) {
                geoBtn.addEventListener('click', () => {
                    State.viewLock = 'near';
                    State.nearMe = true;
                    locateUser({ center: true, fromButton: true });
                });
            }
            document.getElementById('kyiv-btn')?.addEventListener('click', showWholeKyiv);

            async function refreshMapData() {
                await loadCatalogData();
                syncUI();
                if (State.service) {
                    renderLocationList();
                }
                syncMapMarkers();
            }

            async function loadSession() {
                try {
                    const meRes = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
                    const me = await meRes.json();
                    if (me.loggedIn) {
                        State.currentUser = me.user;
                        if (me.user.role === 'client') {
                            const favRes = await fetch('/api/client/favorites', { credentials: 'same-origin', cache: 'no-store' });
                            const favData = await favRes.json();
                            if (favRes.ok) {
                                State.favoriteIds = new Set(favData.locationIds || []);
                            }
                        }
                    }
                } catch (_) {}
            }

            try {
                await Promise.all([loadCatalogData(), loadSession()]);
            } catch (err) {
                console.error(err);
                const banner = document.getElementById('dataLoadBanner');
                if (banner) banner.classList.add('show');
                document.getElementById('dataLoadRetryBtn')?.addEventListener('click', () => {
                    location.reload();
                });
                return;
            }

            const userMenu = document.getElementById('userMenu');
            const profileBtn = document.getElementById('profileBtn');
            const googleImportModal = document.getElementById('googleImportModal');
            const googleImportPreview = document.getElementById('googleImportPreview');
            const googleImportMessage = document.getElementById('googleImportMessage');
            let googleImportData = null;

            function escapeHtml(value) {
                return String(value ?? '').replace(/[&<>"']/g, (char) => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[char]));
            }

            /** Display price: "1 200 грн", without kopeks. */
            function isFreePrice(raw) {
                const s = String(raw || '').trim();
                if (!s) return false;
                if (/безкоштовн|безплатн|\bfree\b/i.test(s)) return true;
                const digits = s.replace(/[^\d]/g, '');
                return digits !== '' && Number(digits) === 0;
            }

            function formatDisplayPrice(raw) {
                const s = String(raw || '').trim();
                if (!s) return '';
                if (isFreePrice(s)) return 'Безкоштовно';
                if (/уточн/i.test(s) || /домовлен/i.test(s)) return s;
                const compact = s.replace(/\s/g, '');
                const m = compact.match(/(\d+)/);
                if (!m) return s;
                const formatted = m[1].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
                const prefix = /^від\s*/i.test(s) ? 'від ' : '';
                return `${prefix}${formatted} грн`;
            }

            function getTelegramUsername(loc) {
                const raw =
                    loc?.importMeta?.telegramUsername ||
                    loc?.telegramUsername ||
                    loc?.telegram ||
                    '';
                return String(raw).replace(/^@/, '').trim();
            }

            function ratingStarsHtml(score) {
                const n = Math.max(0, Math.min(5, Math.round(Number(score) || 0)));
                return (
                    '<span class="profile-stars" aria-hidden="true">' +
                    '★'.repeat(n) +
                    '☆'.repeat(5 - n) +
                    '</span>'
                );
            }

            function defaultOrderServiceName(loc) {
                if (State.service?.name) return State.service.name;
                const keys = Object.keys(loc?.prices || {});
                return keys[0] || '';
            }

            function getChatHref(loc) {
                const tg = getTelegramUsername(loc);
                if (tg) return 'https://t.me/' + encodeURIComponent(tg);
                const phone = String(loc?.phone || '').replace(/\D/g, '');
                if (phone) return 'https://t.me/+' + phone;
                return '';
            }

            function findServicePrice(loc, serviceName) {
                const prices = loc?.prices || {};
                if (!serviceName) return '';
                if (Object.prototype.hasOwnProperty.call(prices, serviceName) && prices[serviceName]) {
                    return prices[serviceName];
                }
                const want = String(serviceName).trim().toLowerCase();
                const key = Object.keys(prices).find((k) => String(k).trim().toLowerCase() === want);
                return key ? prices[key] : '';
            }

            function openGoogleImport() {
                closeUserMenu();
                googleImportModal.classList.remove('hidden');
                googleImportMessage.textContent = '';
                document.getElementById('googleImportUrl').focus();
            }

            function closeGoogleImport() {
                googleImportModal.classList.add('hidden');
            }

            function renderGoogleImportPreview(data) {
                googleImportData = data;
                const place = data.place || {};
                const categories = (data.catalogOptions || []).map((category) =>
                    `<option value="${escapeHtml(category.key)}" ${category.key === data.category ? 'selected' : ''}>${escapeHtml(category.name || category.key)}</option>`
                ).join('');
                const selectedCategory = (data.catalogOptions || []).find((category) => category.key === data.category);
                const selectedSubs = new Set(
                    Array.isArray(data.subcategories) && data.subcategories.length
                        ? data.subcategories
                        : data.subcategory
                          ? [data.subcategory]
                          : []
                );
                const subCheckboxes = (selectedCategory?.subcats || []).map((subcategory) =>
                    `<label><input type="checkbox" class="google-import-sub" value="${escapeHtml(subcategory.key)}" ${selectedSubs.has(subcategory.key) ? 'checked' : ''}> ${escapeHtml(subcategory.name || subcategory.key)}</label>`
                ).join('');
                const schedule = Object.entries(place.schedule || {})
                    .map(([day, hours]) => `${escapeHtml(day)}: ${escapeHtml(hours)}`)
                    .join('<br>');
                const partialNotice = data.isPartial
                    ? '<p style="color:#b45309;margin:8px 0 0">Без API імпортовано базові дані: назву та координати. Інші поля можна додати пізніше.</p>'
                    : '';

                googleImportPreview.classList.remove('hidden');
                googleImportPreview.innerHTML = `
                    <strong style="font-size:15px">${escapeHtml(place.title || 'Місце')}</strong><br>
                    ${place.address ? `${escapeHtml(place.address)}<br>` : ''}
                    ${place.phone ? `${escapeHtml(place.phone)}<br>` : ''}
                    Координати: ${Number(place.lat).toFixed(5)}, ${Number(place.lng).toFixed(5)}
                    ${place.rating ? `<br>★ ${Number(place.rating).toFixed(1)} (${Number(place.reviewsCount) || 0} відгуків)` : ''}
                    ${schedule ? `<p><strong>Графік роботи</strong><br>${schedule}</p>` : ''}
                    ${partialNotice}
                    <label for="googleImportCategory">Категорія</label>
                    <select id="googleImportCategory">${categories}</select>
                    <label>Підкатегорії (можна кілька)</label>
                    <div id="googleImportSubcats" class="import-subcats-box">${subCheckboxes || '<span style="color:var(--muted)">Немає підкатегорій</span>'}</div>
                    <div class="import-modal-actions">
                        <button type="button" class="import-modal-primary" id="googleImportSaveBtn">Додати на карту</button>
                    </div>`;

                const categorySelect = document.getElementById('googleImportCategory');
                categorySelect.onchange = () => {
                    const category = (data.catalogOptions || []).find((item) => item.key === categorySelect.value);
                    const box = document.getElementById('googleImportSubcats');
                    box.innerHTML = (category?.subcats || []).map((subcategory) =>
                        `<label><input type="checkbox" class="google-import-sub" value="${escapeHtml(subcategory.key)}"> ${escapeHtml(subcategory.name || subcategory.key)}</label>`
                    ).join('') || '<span style="color:var(--muted)">Немає підкатегорій</span>';
                };
                document.getElementById('googleImportSaveBtn').onclick = () => runGoogleImport(false);
            }

            function getGoogleImportSelectedSubcats() {
                return [...document.querySelectorAll('.google-import-sub:checked')].map((el) => el.value);
            }

            async function runGoogleImport(dryRun) {
                const url = document.getElementById('googleImportUrl').value.trim();
                if (!url) {
                    googleImportMessage.className = 'import-message error';
                    googleImportMessage.textContent = 'Вставте посилання Google Maps';
                    return;
                }
                googleImportMessage.className = 'import-message';
                googleImportMessage.textContent = dryRun ? 'Розпізнаємо місце…' : 'Додаємо на карту…';
                const body = { url, dryRun };
                if (!dryRun) {
                    body.category = document.getElementById('googleImportCategory')?.value || googleImportData?.category;
                    const subs = getGoogleImportSelectedSubcats();
                    body.subcategories = subs;
                    body.subcategory = subs[0] || '';
                }
                try {
                    const response = await fetch('/api/import-google-maps-url', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.error || 'Не вдалося імпортувати місце');
                    if (dryRun) {
                        renderGoogleImportPreview(data);
                        googleImportMessage.className = 'import-message success';
                        googleImportMessage.textContent = `Знайдено. AI категорія: ${data.categoryName || data.category}`;
                    } else {
                        googleImportMessage.className = 'import-message success';
                        googleImportMessage.textContent = 'Місце додано на карту';
                        await refreshMapData();
                        setTimeout(closeGoogleImport, 900);
                    }
                } catch (error) {
                    googleImportMessage.className = 'import-message error';
                    googleImportMessage.textContent = error.message;
                }
            }

            document.getElementById('googleImportPreviewBtn').onclick = () => runGoogleImport(true);
            document.getElementById('googleImportClose').onclick = closeGoogleImport;
            googleImportModal.addEventListener('click', (event) => {
                if (event.target === googleImportModal) closeGoogleImport();
            });

            function closeUserMenu() {
                userMenu.classList.remove('show');
                profileBtn.setAttribute('aria-expanded', 'false');
            }

            function openUserMenu() {
                userMenu.classList.add('show');
                profileBtn.setAttribute('aria-expanded', 'true');
            }

            function pwaInstallMenuItemHtml() {
                if (window.MapfixPwa?.isStandalone?.()) return '';
                return `<button type="button" class="user-menu-item" id="installAppMenuBtn">📲 Встановити додаток</button>`;
            }

            function bindInstallAppMenuBtn() {
                const btn = document.getElementById('installAppMenuBtn');
                if (!btn) return;
                btn.onclick = () => {
                    closeUserMenu();
                    window.MapfixPwa?.promptInstall?.();
                };
            }

            function updateHeaderAuthUI() {
                const u = State.currentUser;
                const loginBtn = document.getElementById('loginHeaderBtn');
                profileBtn.classList.toggle('logged-in', !!u);
                profileBtn.classList.remove('hidden');
                if (loginBtn) loginBtn.classList.toggle('hidden', !!u);
                profileBtn.title = u ? u.login : 'Меню';
                profileBtn.textContent = u ? '👤' : '☰';

                if (!u) {
                    userMenu.innerHTML = `
                        <div class="user-menu-header">Гість</div>
                        <a class="user-menu-item" href="/login.html">Увійти</a>
                        <a class="user-menu-item" href="/register.html">Реєстрація</a>
                        <a class="user-menu-item" href="/register.html?role=provider">Реєстрація майстра</a>
                        <button type="button" class="user-menu-item" id="siteBugMenuBtn">🐞 Повідомити про помилку</button>
                        ${pwaInstallMenuItemHtml()}`;
                    bindInstallAppMenuBtn();
                    bindSiteBugMenuBtn();
                    return;
                }

                let cabinetLabel = 'Мій кабінет';
                let cabinetHref = '/client';
                if (u.role === 'provider') {
                    cabinetLabel = 'Кабінет бізнесу';
                    cabinetHref = '/admin';
                } else if (u.role === 'admin') {
                    cabinetLabel = 'Адмін-панель';
                    cabinetHref = '/admin';
                }

                userMenu.innerHTML = `
                    <div class="user-menu-header">
                        Ви в системі
                        <strong>${u.login}</strong>
                    </div>
                    <a class="user-menu-item" href="${cabinetHref}">${cabinetLabel}</a>
                    <button type="button" class="user-menu-item" id="importGoogleMenuBtn">Додати з Google Maps</button>
                    <button type="button" class="user-menu-item" id="siteBugMenuBtn">🐞 Повідомити про помилку</button>
                    ${pwaInstallMenuItemHtml()}
                    <button type="button" class="user-menu-item danger" id="logoutMenuBtn">Вийти</button>`;

                document.getElementById('importGoogleMenuBtn').onclick = openGoogleImport;
                bindInstallAppMenuBtn();
                bindSiteBugMenuBtn();
                document.getElementById('logoutMenuBtn').onclick = async () => {
                    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
                    State.currentUser = null;
                    State.favoriteIds = new Set();
                    closeUserMenu();
                    updateHeaderAuthUI();
                };
            }

            updateHeaderAuthUI();

            profileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (userMenu.classList.contains('show')) closeUserMenu();
                else openUserMenu();
            });

            document.addEventListener('click', (e) => {
                if (!e.target.closest('.profile-wrap')) closeUserMenu();
            });

            document.getElementById('addBusinessBtn').addEventListener('click', () => {
                window.startAddBusinessFlow();
            });

            window.startAddBusinessFlow = function() {
                const u = State.currentUser;
                if (!u) {
                    window.location.href = '/register.html?role=provider&next=' + encodeURIComponent('/admin?newLocation=1');
                    return;
                }
                if (u.role === 'client') {
                    window.location.href = '/register.html?role=provider&next=' + encodeURIComponent('/admin?newLocation=1');
                    return;
                }
                openGoogleImport();
            };

            document.getElementById('brandHomeBtn')?.addEventListener('click', () => {
                resetToHome();
            });

            function parseClientLanding() {
                const boot = window.__MAPFIX_LANDING;
                if (boot && (boot.cat || boot.area || boot.loc || boot.sub)) return boot;
                const parts = window.location.pathname.split('/').filter(Boolean).map((p) => {
                    try { return decodeURIComponent(p); } catch { return p; }
                });
                const q = new URLSearchParams(window.location.search);
                const cats = window.masterCatalog || {};
                const aliases = {
                    santekhnik: { cat: 'home', sub: 'plumber' },
                    santehnik: { cat: 'home', sub: 'plumber' },
                    elektrik: { cat: 'home', sub: 'electrician' },
                    elektryk: { cat: 'home', sub: 'electrician' },
                    'majster-dodomu': { cat: 'home', sub: 'handyman' },
                    shynomontazh: { cat: 'auto', sub: 'tyres' },
                    sto: { cat: 'auto' },
                    avtoservis: { cat: 'auto' },
                    manikiur: { cat: 'beauty' },
                    barbershop: { cat: 'beauty' },
                    'salon-krasy': { cat: 'beauty' },
                    'remont-tehniky': { cat: 'repair' },
                };
                let loc = q.get('loc');
                let cat = q.get('cat');
                let area = resolveMapArea(q.get('area'))?.key || null;
                let sub = q.get('sub');
                if (parts[0] === 'p' && parts[1]) loc = parts[1];
                if (parts[0] === 'kyiv' || parts[0] === 'kiev') {
                    const a = (parts[1] || '').toLowerCase();
                    const b = (parts[2] || '').toLowerCase();
                    const c = (parts[3] || '').toLowerCase();
                    const areaA = resolveMapArea(a);
                    const aliasA = aliases[a];
                    const aliasB = aliases[b];
                    if (areaA) {
                        area = areaA.key;
                        if (b && cats[b]) {
                            cat = b;
                            if (c) sub = c;
                        } else if (aliasB) {
                            cat = aliasB.cat;
                            sub = aliasB.sub || sub;
                        }
                    } else if (aliasA) {
                        cat = aliasA.cat;
                        sub = aliasA.sub || sub;
                    } else if (a && cats[a]) {
                        cat = a;
                        if (b) sub = b;
                    }
                }
                return { loc, cat, area, sub };
            }

            function sharePathFromState() {
                if (State.selectedLocation) return '/p/' + encodeURIComponent(State.selectedLocation.id);
                if (State.area && State.category && State.subcategory) {
                    return '/kyiv/' + encodeURIComponent(State.area) + '/' + encodeURIComponent(State.category) + '/' + encodeURIComponent(State.subcategory);
                }
                if (State.area && State.category) return '/kyiv/' + encodeURIComponent(State.area) + '/' + encodeURIComponent(State.category);
                if (State.area) return '/kyiv/' + encodeURIComponent(State.area);
                if (State.category && State.subcategory) {
                    return '/kyiv/' + encodeURIComponent(State.category) + '/' + encodeURIComponent(State.subcategory);
                }
                if (State.category) return '/kyiv/' + encodeURIComponent(State.category);
                return '/';
            }

            function categoryHref(catKey) {
                return State.area
                    ? '/kyiv/' + encodeURIComponent(State.area) + '/' + encodeURIComponent(catKey)
                    : '/kyiv/' + encodeURIComponent(catKey);
            }

            const urlParams = new URLSearchParams(window.location.search);
            const landing = parseClientLanding();
            const urlLoc = landing.loc || urlParams.get('loc');
            const urlCat = landing.cat || urlParams.get('cat');
            const urlSub = landing.sub || urlParams.get('sub');
            if (landing.area) {
                const area = resolveMapArea(landing.area);
                if (area) applyMapArea(area);
            }
            if (!urlLoc && urlCat && window.masterCatalog?.[urlCat]) {
                State.category = urlCat;
                if (urlSub && window.masterCatalog[urlCat]?.subcats?.[urlSub]) {
                    State.subcategory = urlSub;
                }
            }
            const qSearch = (urlParams.get('q') || '').trim();
            if (qSearch) State.locationSearchQuery = qSearch;
            if (urlLoc) {
                setTimeout(() => openMasterDetail(urlLoc, { mode: 'dive', forceMode: true }), 400);
            }
            if (urlParams.get('add') === '1') {
                setTimeout(() => {
                    const u = State.currentUser;
                    if (u && (u.role === 'provider' || u.role === 'admin')) openGoogleImport();
                }, 500);
            }
            if (urlParams.get('claim') === '1' && urlLoc) {
                setTimeout(() => {
                    document.getElementById('claimPhoneInput')?.focus();
                }, 700);
            }
            if (urlParams.get('feedback') === '1') {
                setTimeout(() => openSiteFeedbackModal(), 450);
            }

            window.placeOrder = async function(locationId, serviceName) {
                const backToLoc = '/p/' + encodeURIComponent(locationId);
                if (!State.currentUser) {
                    if (confirm('Увійдіть як клієнт, щоб замовити послугу. Перейти до входу?')) {
                        window.location.href = '/login.html?next=' + encodeURIComponent(backToLoc);
                    }
                    return;
                }
                if (State.currentUser.role !== 'client') {
                    alert('Замовлення доступне лише для ролі клієнта');
                    return;
                }
                const preferredAt = prompt('Бажана дата/час (або залиште порожнім):', '') || '';
                const note = prompt('Коментар для майстра (необовʼязково):', '') || '';
                const callBack = confirm('OK — щоб майстер передзвонив.\nСкасувати — без уподобань щодо дзвінка.')
                    ? 'call'
                    : 'any';
                try {
                    const res = await fetch('/api/orders', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            locationId,
                            serviceName,
                            preferredAt: preferredAt.trim() || undefined,
                            note: note.trim() || undefined,
                            contactMode: callBack,
                        }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error);
                    trackLocationClick(locationId, 'order');
                    alert('Замовлення створено! Майстра сповіщено. Дивіться статус у кабінеті клієнта.');
                } catch (err) {
                    alert(err.message);
                }
            };

            window.shareLocation = async function(locationId) {
                const loc = window.mockLocations.find((l) => l.id === locationId);
                const url = `${location.origin}/p/${encodeURIComponent(locationId)}?utm_source=share&utm_medium=button&utm_campaign=card`;
                const title = loc?.title || 'Mapfix';
                const text = loc ? `${loc.title} — ${loc.address || 'на Mapfix'}` : 'Mapfix';
                trackLocationClick(locationId, 'share');
                try {
                    if (navigator.share) {
                        await navigator.share({ title, text, url });
                        return;
                    }
                } catch (_) {}
                try {
                    await navigator.clipboard.writeText(url);
                    alert('Посилання скопійовано');
                } catch (_) {
                    prompt('Скопіюйте посилання:', url);
                }
            };

            window.showLocationQr = function(locationId) {
                trackLocationClick(locationId, 'share');
                const loc = window.mockLocations.find((l) => l.id === locationId);
                const src = `/api/qr/${encodeURIComponent(locationId)}.svg`;
                const old = document.getElementById('mf-qr-modal');
                if (old) old.remove();
                const wrap = document.createElement('div');
                wrap.id = 'mf-qr-modal';
                wrap.setAttribute('role', 'dialog');
                wrap.setAttribute('aria-label', 'QR-код картки');
                wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px';
                wrap.innerHTML = `<div style="background:#fff;border-radius:16px;padding:20px;max-width:340px;width:100%;text-align:center;color:#111">
                    <div style="font-weight:700;margin-bottom:6px">${escapeHtml(loc?.title || 'Mapfix')}</div>
                    <div style="font-size:13px;color:#555;margin-bottom:12px">Покажіть клієнту або роздрукуйте — QR відкриває цю картку на Mapfix</div>
                    <img src="${src}" alt="QR-код" style="width:240px;height:240px">
                    <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
                        <a href="${src}" download="mapfix-qr-${escapeHtml(locationId)}.svg" class="profile-quick-btn">Завантажити</a>
                        <button type="button" class="profile-quick-btn" data-close>Закрити</button>
                    </div></div>`;
                wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.hasAttribute('data-close')) wrap.remove(); });
                document.body.appendChild(wrap);
            };

            window.reportLocation = async function(locationId) {
                const backToLoc = '/p/' + encodeURIComponent(locationId);
                if (!State.currentUser) {
                    if (confirm('Увійдіть, щоб надіслати скаргу. Перейти до входу?')) {
                        location.href = '/login.html?next=' + encodeURIComponent(backToLoc);
                    }
                    return;
                }
                const message = prompt('Опишіть проблему з цим закладом:');
                if (!message || message.trim().length < 5) return;
                try {
                    const res = await fetch('/api/reports', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ locationId, reason: 'location', message: message.trim() }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error);
                    trackLocationClick(locationId, 'report');
                    alert('Скаргу надіслано. Дякуємо!');
                } catch (err) {
                    alert(err.message);
                }
            };

            function openSiteFeedbackModal() {
                const modal = document.getElementById('siteFeedbackModal');
                const msgEl = document.getElementById('siteFeedbackMsg');
                const textEl = document.getElementById('siteFeedbackMessage');
                if (!modal) return;
                if (msgEl) {
                    msgEl.className = 'site-feedback-msg';
                    msgEl.textContent = '';
                }
                if (textEl && !textEl.value) textEl.focus();
                modal.classList.add('show');
                modal.setAttribute('aria-hidden', 'false');
                closeUserMenu();
            }

            function closeSiteFeedbackModal() {
                const modal = document.getElementById('siteFeedbackModal');
                if (!modal) return;
                modal.classList.remove('show');
                modal.setAttribute('aria-hidden', 'true');
            }

            function bindSiteBugMenuBtn() {
                document.getElementById('siteBugMenuBtn')?.addEventListener('click', () => openSiteFeedbackModal());
            }

            document.getElementById('siteFeedbackCancel')?.addEventListener('click', () => closeSiteFeedbackModal());
            document.getElementById('siteFeedbackModal')?.addEventListener('click', (e) => {
                if (e.target === e.currentTarget) closeSiteFeedbackModal();
            });
            document.getElementById('siteFeedbackSend')?.addEventListener('click', async () => {
                const textEl = document.getElementById('siteFeedbackMessage');
                const contactEl = document.getElementById('siteFeedbackContact');
                const msgEl = document.getElementById('siteFeedbackMsg');
                const sendBtn = document.getElementById('siteFeedbackSend');
                const message = (textEl?.value || '').trim();
                if (message.length < 5) {
                    if (msgEl) {
                        msgEl.className = 'site-feedback-msg err';
                        msgEl.textContent = 'Опишіть проблему детальніше (мін. 5 символів)';
                    }
                    return;
                }
                if (sendBtn) sendBtn.disabled = true;
                try {
                    const res = await fetch('/api/feedback', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({
                            message,
                            contact: (contactEl?.value || '').trim(),
                            page: location.pathname + location.search,
                        }),
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || 'Не вдалося надіслати');
                    if (textEl) textEl.value = '';
                    if (contactEl) contactEl.value = '';
                    if (msgEl) {
                        msgEl.className = 'site-feedback-msg ok';
                        msgEl.textContent = 'Дякуємо! Повідомлення надіслано.';
                    }
                    setTimeout(() => closeSiteFeedbackModal(), 1200);
                } catch (err) {
                    if (msgEl) {
                        msgEl.className = 'site-feedback-msg err';
                        msgEl.textContent = err.message || 'Помилка надсилання';
                    }
                } finally {
                    if (sendBtn) sendBtn.disabled = false;
                }
            });

            window.toggleFavorite = async function(locationId) {
                if (!State.currentUser || State.currentUser.role !== 'client') {
                    if (confirm('Увійдіть як клієнт. Перейти до реєстрації?')) {
                        window.location.href = '/register.html';
                    }
                    return;
                }
                const isFav = State.favoriteIds.has(locationId);
                const url = isFav
                    ? `/api/client/favorites/${locationId}`
                    : '/api/client/favorites';
                const res = await fetch(url, {
                    method: isFav ? 'DELETE' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: isFav ? undefined : JSON.stringify({ locationId }),
                });
                const data = await res.json();
                if (!res.ok) return alert(data.error || 'Помилка');
                if (isFav) State.favoriteIds.delete(locationId);
                else {
                    State.favoriteIds.add(locationId);
                    trackLocationClick(locationId, 'favorite');
                }
                if (State.selectedLocation?.id === locationId) {
                    openMasterDetail(locationId, {
                        mode: State.detailMode || 'dive',
                        forceMode: true,
                    });
                }
            };

            const appShell = document.getElementById('app-shell');
            const categoryStrip = document.getElementById('categoryStrip');
            const catalogNav = document.getElementById('catalogNav');
            const sidebarContent = document.getElementById('sidebarContent');
            const navBackBtn = document.getElementById('navBackBtn');
            const navTitle = document.getElementById('navTitle');
            const sortPanelWrap = document.getElementById('sortPanelWrap');
            const sidebarListView = document.getElementById('sidebar-list-view');

            const CATEGORY_ICONS = {
                beauty: 'fa-scissors',
                auto: 'fa-car',
                repair: 'fa-wrench',
                pets: 'fa-paw',
                home: 'fa-house',
                education: 'fa-graduation-cap',
                sport: 'fa-dumbbell',
                rental: 'fa-key',
                medical: 'fa-heart-pulse',
                food: 'fa-utensils',
                furniture: 'fa-couch',
            };

            function categoryIconClass(catKey) {
                return CATEGORY_ICONS[catKey] || 'fa-map-location-dot';
            }

            function categoryLabel(name) {
                return String(name || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || name;
            }

            function isMobileLayout() {
                return window.matchMedia('(max-width: 768px)').matches;
            }

            function syncMobileViewport() {
                const shell = document.getElementById('app-shell');
                const root = document.documentElement;
                const mobile = isMobileLayout();
                const ua = navigator.userAgent || '';
                const android = /Android/i.test(ua);
                const standalone =
                    window.matchMedia('(display-mode: standalone)').matches ||
                    Boolean(window.navigator.standalone);
                const vv = window.visualViewport;
                let covered = 0;
                if (vv) {
                    covered = Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
                }
                let chromePad = covered;
                if (mobile && android && !standalone && chromePad < 40) chromePad = 48;
                if (!mobile) chromePad = 0;
                root.style.setProperty('--chrome-nav-pad', chromePad + 'px');

                if (!shell) return;
                if (!mobile || !vv) {
                    shell.style.position = '';
                    shell.style.top = '';
                    shell.style.left = '';
                    shell.style.right = '';
                    shell.style.height = '';
                    return;
                }
                shell.style.position = 'fixed';
                shell.style.left = '0';
                shell.style.right = '0';
                shell.style.top = Math.max(0, Math.round(vv.offsetTop)) + 'px';
                shell.style.height = Math.round(vv.height) + 'px';
            }

            syncMobileViewport();
            window.addEventListener('resize', syncMobileViewport);
            window.visualViewport?.addEventListener('resize', () => {
                syncMobileViewport();
                if (typeof map !== 'undefined' && map && map.invalidateSize) {
                    map.invalidateSize();
                }
            });
            window.visualViewport?.addEventListener('scroll', syncMobileViewport);

            function expandBottomSheet() {
                if (isMobileLayout()) {
                    appShell.classList.add('sheet-expanded');
                    appShell.classList.remove('sheet-dive', 'sheet-browse');
                }
                setTimeout(() => map.invalidateSize(), 400);
            }

            function browseBottomSheet() {
                if (isMobileLayout()) {
                    appShell.classList.add('sheet-expanded', 'sheet-browse');
                    appShell.classList.remove('sheet-dive');
                }
                setTimeout(() => map.invalidateSize(), 400);
            }

            function collapseBottomSheet() {
                if (isMobileLayout()) {
                    appShell.classList.remove('sheet-expanded', 'sheet-dive', 'sheet-browse');
                }
                setTimeout(() => map.invalidateSize(), 400);
            }

            function getSheetLevel() {
                if (appShell.classList.contains('sheet-dive') || appShell.classList.contains('sheet-browse')) {
                    return 2;
                }
                if (appShell.classList.contains('sheet-expanded')) return 1;
                return 0;
            }

            function raiseSheetLevel() {
                const level = getSheetLevel();
                if (level <= 0) expandBottomSheet();
                else browseBottomSheet();
            }

            function lowerSheetLevel() {
                const level = getSheetLevel();
                if (level >= 2) {
                    if (State.detailMode === 'dive') {
                        // З dive не скидаємо картку — лише трохи зменшуємо шторку
                        appShell.classList.remove('sheet-dive', 'sheet-browse');
                        appShell.classList.add('sheet-expanded');
                        setTimeout(() => map.invalidateSize(), 400);
                    } else {
                        expandBottomSheet();
                    }
                } else if (level === 1) {
                    collapseBottomSheet();
                }
            }

            function updateNavBackButton() {
                const labelEl = document.getElementById('navBackLabel');
                if (!labelEl) return;
                let label = 'Назад';
                if (State.locationSearchQuery) label = 'До пошуку';
                else if (State.service) label = 'До послуг';
                else if (State.subcategory) label = 'До підкатегорій';
                else if (State.category) label = 'До категорій';
                labelEl.textContent = label;
                navBackBtn.setAttribute('aria-label', label);
            }

            function enterDetailDive() {
                State.detailMode = 'dive';
                const detailView = document.getElementById('sidebar-detail-view');
                detailView.classList.add('show', 'mode-dive');
                detailView.classList.remove('mode-preview');
                appShell.classList.add('showing-location');
                if (isMobileLayout()) {
                    appShell.classList.add('sheet-expanded', 'sheet-dive');
                    appShell.classList.remove('sheet-browse');
                }
                setTimeout(() => {
                    const body = document.getElementById('detailBodyContent');
                    if (body) body.scrollTop = 0;
                    map.invalidateSize();
                }, 80);
                setTimeout(() => map.invalidateSize(), 420);
            }

            window.diveIntoSelectedDetail = function () {
                if (!State.selectedLocation) return;
                trackLocationClick(State.selectedLocation.id, 'dive');
                openMasterDetail(State.selectedLocation.id, { mode: 'dive', forceMode: true });
            };

            const detailViewEl = document.getElementById('sidebar-detail-view');
            detailViewEl.addEventListener('click', (e) => {
                if (State.detailMode !== 'preview' || !State.selectedLocation) return;
                if (e.target.closest('a, button, input, textarea, select, label')) return;
                diveIntoSelectedDetail();
            });

            function pulseSheetContent() {
                sidebarListView.classList.remove('sheet-content-enter');
                void sidebarListView.offsetWidth;
                sidebarListView.classList.add('sheet-content-enter');
            }

            function getCatalogClicks(key) {
                return Number((window.catalogClicks || {})[key]) || 0;
            }

            function catClickKey(catKey) {
                return 'cat:' + catKey;
            }

            function subClickKey(catKey, subKey) {
                return 'sub:' + catKey + ':' + subKey;
            }

            function svcClickKey(catKey, subKey, serviceName) {
                return (
                    'svc:' +
                    catKey +
                    ':' +
                    subKey +
                    ':' +
                    String(serviceName || '')
                      .trim()
                      .toLowerCase()
                );
            }

            function sortByClicksThenName(entries, getKey, getName) {
                return [...entries].sort((a, b) => {
                    const ca = getCatalogClicks(getKey(a));
                    const cb = getCatalogClicks(getKey(b));
                    if (cb !== ca) return cb - ca;
                    return String(getName(a) || '').localeCompare(String(getName(b) || ''), 'uk');
                });
            }

            function trackCatalogClick(payload) {
                let key = '';
                if (payload.type === 'category') key = catClickKey(payload.categoryKey);
                else if (payload.type === 'subcategory') {
                    key = subClickKey(payload.categoryKey, payload.subcategoryKey);
                } else if (payload.type === 'service') {
                    key = svcClickKey(payload.categoryKey, payload.subcategoryKey, payload.serviceName);
                }
                if (key) {
                    window.catalogClicks = window.catalogClicks || {};
                    window.catalogClicks[key] = getCatalogClicks(key) + 1;
                }
                fetch('/api/catalog/click', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }).catch(() => {});
            }

            function mfSid() {
                try {
                    return window.MapfixAnalytics?.sid || localStorage.getItem('mf_sid') || undefined;
                } catch (_) {
                    return undefined;
                }
            }

            function trackLocationClick(locationId, type) {
                const id = String(locationId || '').trim();
                const t = String(type || '').trim();
                if (!id || !t) return;
                fetch('/api/locations/' + encodeURIComponent(id) + '/click', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: t, sid: mfSid() }),
                    keepalive: true,
                }).catch(() => {});
            }
            window.trackLocationClick = trackLocationClick;

            const QUICK_CHIP_DEFS = [
                { label: 'Сантехнік', cat: 'home', sub: 'plumber' },
                { label: 'Електрик', cat: 'home', sub: 'electrician' },
                { label: 'СТО', cat: 'auto', sub: 'auto_repair' },
                { label: 'Шиномонтаж', cat: 'auto', sub: 'tyres' },
                { label: 'Краса', cat: 'beauty' },
                { label: 'Ремонт техніки', cat: 'repair', sub: 'appliances' },
                { label: 'Майстер', cat: 'home', sub: 'handyman' },
                { label: 'Автомийка', cat: 'auto', sub: 'wash' },
            ];
            const CATEGORY_CHIP_LABELS = {
                beauty: 'Краса',
                auto: 'Авто',
                repair: 'Ремонт',
                pets: 'Тварини',
                home: 'Дім',
                education: 'Освіта',
                sport: 'Спорт',
                rental: 'Оренда',
                medical: 'Медицина',
                food: 'Їжа',
                furniture: 'Меблі',
            };

            function chipHref(catKey, subKey) {
                const area = State.area ? encodeURIComponent(State.area) + '/' : '';
                if (subKey) return '/kyiv/' + area + encodeURIComponent(catKey) + '/' + encodeURIComponent(subKey);
                return categoryHref(catKey);
            }

            function quickChips() {
                const catalog = window.masterCatalog || {};
                const chips = [];
                const covered = new Set();
                QUICK_CHIP_DEFS.forEach((def) => {
                    const cat = catalog[def.cat];
                    if (!cat) return;
                    if (def.sub && !cat.subcats?.[def.sub]) return;
                    chips.push(def);
                    covered.add(def.cat);
                });
                Object.keys(catalog).forEach((catKey) => {
                    if (covered.has(catKey)) return;
                    chips.push({
                        label: CATEGORY_CHIP_LABELS[catKey] || categoryLabel(catalog[catKey]?.name || catKey),
                        cat: catKey,
                    });
                });
                return chips;
            }

            function handleQuickChip(catKey, subKey) {
                const same =
                    State.category === catKey &&
                    (State.subcategory || null) === (subKey || null) &&
                    !State.service &&
                    !State.locationSearchQuery;
                if (same) {
                    resetToHome();
                    return;
                }
                trackCatalogClick(
                    subKey
                        ? { type: 'subcategory', categoryKey: catKey, subcategoryKey: subKey }
                        : { type: 'category', categoryKey: catKey }
                );
                State.locationSearchQuery = '';
                const searchField = document.getElementById('searchInput');
                if (searchField) searchField.value = '';
                hideSearchSuggest();
                State.aiSuggestions = [];
                State.category = catKey;
                State.subcategory = subKey || null;
                State.service = null;
                State.selectedLocation = null;
                State.detailMode = null;
                closeMasterDetail();
                browseBottomSheet();
                syncUI();
            }

            function renderCategoryStrip() {
                categoryStrip.innerHTML = '';
                const chips = quickChips();
                if (!chips.length) {
                    categoryStrip.innerHTML = '<p class="nav-hint" style="padding:8px 16px">Каталог порожній</p>';
                    return;
                }

                chips.forEach((chip) => {
                    const active =
                        State.category === chip.cat &&
                        (chip.sub ? State.subcategory === chip.sub : !State.subcategory);
                    const link = document.createElement('a');
                    link.href = chipHref(chip.cat, chip.sub);
                    link.className = 'category-chip' + (active ? ' active' : '');
                    link.textContent = chip.label;
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        handleQuickChip(chip.cat, chip.sub || null);
                    });
                    categoryStrip.appendChild(link);
                });

                const activeChip = categoryStrip.querySelector('.category-chip.active');
                if (activeChip) {
                    activeChip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                }
            }

            document.getElementById('sortSelect').addEventListener('change', (e) => { State.sortType = e.target.value; renderLocationList(); });
            document.getElementById('onlyOpenCheckbox').addEventListener('change', (e) => { State.onlyOpen = e.target.checked; syncUI(); });
            document.getElementById('onlyPhoneCheckbox')?.addEventListener('change', (e) => { State.onlyPhone = e.target.checked; syncUI(); });
            document.getElementById('onlyPriceCheckbox')?.addEventListener('change', (e) => { State.onlyPrice = e.target.checked; syncUI(); });
            document.getElementById('onlyRatedCheckbox')?.addEventListener('change', (e) => { State.onlyRated = e.target.checked; syncUI(); });
            navBackBtn.addEventListener('click', handleNavBack);

            function createNavItem(label, meta, onClick) {
                const el = document.createElement('div');
                el.className = 'nav-item';
                el.innerHTML = `
                    <div>
                        <h2 class="nav-item-title">${label}</h2>
                        ${meta ? `<div class="nav-item-meta">${meta}</div>` : ''}
                    </div>
                    <span class="nav-item-arrow"><i class="fa-solid fa-chevron-right"></i></span>`;
                el.addEventListener('click', onClick);
                return el;
            }

            function locationOffersService(loc, serviceName) {
                return loc.prices && Object.prototype.hasOwnProperty.call(loc.prices, serviceName);
            }

            function getLocSubcats(loc) {
                return Array.isArray(loc?.subcats) ? loc.subcats : [];
            }

            function locationInSubcategory(loc, categoryKey, subcategoryKey) {
                if (!categoryKey || !subcategoryKey) return true;
                if (getLocSubcats(loc).includes(subcategoryKey)) return true;
                const items =
                    window.masterCatalog?.[categoryKey]?.subcats?.[subcategoryKey]?.items || [];
                return items.some((srv) => srv?.name && locationOffersService(loc, srv.name));
            }

            /** Exact price match, or same subcategory (imported masters often lack filled prices). */
            function locationMatchesSelectedService(loc) {
                if (!State.service) return true;
                if (locationOffersService(loc, State.service.name)) return true;
                if (State.subcategory && getLocSubcats(loc).includes(State.subcategory)) return true;
                return false;
            }

            function locationMatchesArea(loc, areaKey) {
                const selected = resolveMapArea(areaKey);
                if (!selected) return true;
                const address = String(loc?.address || '');
                const named = [];
                const inRadius = [];
                for (const key of AREA_KEYS) {
                    const area = MAPFIX_AREAS[key];
                    if (AREA_ADDRESS_RE[key].test(address)) named.push(key);
                    const lat = Number(loc?.lat);
                    const lng = Number(loc?.lng);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
                    const distance = calculateDistance(area.lat, area.lng, lat, lng);
                    if (distance <= area.radiusKm) inRadius.push({ key, distance });
                }
                inRadius.sort((a, b) => a.distance - b.distance);
                const hits = new Set(named);
                if (inRadius.length) hits.add(inRadius[0].key);
                return hits.has(selected.key);
            }

            function locationMatchesMapFilter(loc) {
                if (State.area && !locationMatchesArea(loc, State.area)) return false;
                if (State.locationSearchQuery && !locationMatchesSearch(loc)) return false;
                if (State.category && loc.cat !== State.category) return false;
                if (State.subcategory && !locationInSubcategory(loc, State.category, State.subcategory)) {
                    return false;
                }
                if (State.service && !locationMatchesSelectedService(loc)) return false;
                if (State.onlyOpen && loc.openStatus !== 'open') return false;
                if (State.onlyPhone && !String(loc.phone || '').trim()) return false;
                if (State.onlyPrice && !Object.keys(loc.prices || {}).length) return false;
                if (State.onlyRated && !(Number(loc.reviewsCount) > 0)) return false;
                if (State.nearMe && State.geoReady) {
                    const lat = Number(loc.lat);
                    const lng = Number(loc.lng);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
                    if (calculateDistance(State.userCoords.lat, State.userCoords.lng, lat, lng) > NEAR_ME_RADIUS_KM) {
                        return false;
                    }
                }
                return true;
            }

            function renderCatalogNav() {
                renderCategoryStrip();

                catalogNav.innerHTML = '';
                catalogNav.style.display = 'flex';
                sidebarContent.style.display = 'none';
                sortPanelWrap.style.display = 'none';

                if (State.locationSearchQuery) {
                    browseBottomSheet();
                    navBackBtn.style.display = 'flex';
                    updateNavBackButton();
                    navTitle.textContent = `Результати: ${State.locationSearchQuery}`;
                    catalogNav.style.display = 'none';
                    sidebarContent.style.display = 'flex';
                    renderLocationSearchResults();
                    renderAiSuggestionsInto(sidebarContent);
                    syncMapMarkers();
                    return;
                }

                if (State.service) {
                    browseBottomSheet();
                    navBackBtn.style.display = 'flex';
                    updateNavBackButton();
                    navTitle.textContent = State.service.name;
                    catalogNav.style.display = 'none';
                    sidebarContent.style.display = 'flex';
                    sortPanelWrap.style.display = 'flex';
                    sortPanelWrap.style.flexDirection = 'column';
                    sortPanelWrap.style.gap = '10px';
                    renderLocationList();
                    renderAiSuggestionsInto(sidebarContent);
                    syncMapMarkers();
                    return;
                }

                if (!State.category) {
                    collapseBottomSheet();
                    navBackBtn.style.display = 'none';
                    updateNavBackButton();
                    navTitle.textContent = 'Майстри та ремонт' + cityScopeTitle();
                    const dirLinks = Object.entries(window.masterCatalog || {})
                        .map(([key, cat]) => `<li><a href="${categoryHref(key)}">${escapeHtml(categoryLabel(cat.name))}</a></li>`)
                        .join('');
                    const intentLinks = [
                        ['/kyiv/home/plumber', 'Сантехнік'],
                        ['/kyiv/home/electrician', 'Електрик'],
                        ['/kyiv/home/handyman', 'Майстер на годину'],
                        ['/kyiv/auto/tyres', 'Шиномонтаж'],
                        ['/kyiv/borshchahivka/home', 'Борщагівка'],
                        ['/kyiv/sviatoshyn', 'Святошин'],
                        ['/kyiv/kotsiubynske', 'Коцюбинське'],
                    ].map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('');
                    catalogNav.innerHTML = `
                        <button type="button" class="masters-home-cta" id="homeAddBusinessCta" onclick="window.startAddBusinessFlow && window.startAddBusinessFlow()">
                            <strong>Додати свій бізнес безкоштовно</strong>
                            <span>Без комісій${areaPlaceName() ? ' · ' + areaPlaceName() : ''}. Якщо заклад уже на карті — введіть телефон на картці.</span>
                        </button>
                        <ul class="seo-dir">${intentLinks}${dirLinks}</ul>`;
                    catalogNav.querySelectorAll('.seo-dir a').forEach((a) => {
                        a.addEventListener('click', (e) => {
                            const href = a.getAttribute('href') || '';
                            const catKey = href.split('/').filter(Boolean).pop();
                            if (catKey && window.masterCatalog[catKey]) {
                                e.preventDefault();
                                handleL1Click(catKey);
                            }
                        });
                    });
                    renderAiSuggestionsInto(catalogNav);
                    syncMapMarkers();
                    return;
                }

                browseBottomSheet();
                navBackBtn.style.display = 'flex';
                updateNavBackButton();
                const catData = window.masterCatalog[State.category];

                if (!State.subcategory) {
                    navTitle.textContent = categoryLabel(catData.name) + cityScopeTitle();
                    const subs = sortByClicksThenName(
                        Object.entries(catData.subcats || {}),
                        ([subKey]) => subClickKey(State.category, subKey),
                        ([, subData]) => subData?.name || ''
                    );
                    if (subs.length === 0) {
                        catalogNav.innerHTML = '<p class="nav-hint">Немає підкатегорій</p>';
                    } else {
                        subs.forEach(([subKey, subData]) => {
                            const itemCount = (subData.items || []).length;
                            catalogNav.appendChild(
                                createNavItem(
                                    subData.name,
                                    `${itemCount} послуг`,
                                    () => handleL2Click(subKey)
                                )
                            );
                        });
                    }
                    renderAiSuggestionsInto(catalogNav);
                    pulseSheetContent();
                    syncMapMarkers();
                    return;
                }

                const subData = catData.subcats[State.subcategory];
                navTitle.textContent = subData.name;
                const items = sortByClicksThenName(
                    subData.items || [],
                    (srv) => svcClickKey(State.category, State.subcategory, srv.name),
                    (srv) => srv?.name || ''
                );
                if (items.length === 0) {
                    catalogNav.innerHTML = '<p class="nav-hint">Немає послуг у цій підкатегорії</p>';
                } else {
                    items.forEach((srv) => {
                        const providersCount = window.mockLocations.filter(
                            (loc) =>
                                loc.cat === State.category &&
                                locationInSubcategory(loc, State.category, State.subcategory)
                        ).length;
                        const withExactPrice = window.mockLocations.filter(
                            (loc) =>
                                loc.cat === State.category &&
                                locationOffersService(loc, srv.name)
                        ).length;
                        const el = document.createElement('div');
                        el.className = 'nav-item';
                        const metaBits = [`${providersCount} місць`];
                        if (withExactPrice) metaBits.push(`${withExactPrice} з ціною`);
                        if (srv.price) metaBits.push(formatDisplayPrice(srv.price) || `від ${srv.price}`);
                        el.innerHTML = `
                            <div>
                                <div>${srv.name}</div>
                                <div class="nav-item-meta">${metaBits.join(' · ')}</div>
                            </div>
                            <span class="nav-item-arrow"><i class="fa-solid fa-chevron-right"></i></span>`;
                        el.addEventListener('click', () => handleL3Click(srv));
                        catalogNav.appendChild(el);
                    });
                }
                renderAiSuggestionsInto(catalogNav);
                pulseSheetContent();
                syncMapMarkers();
            }

            function handleNavBack() {
                if (State.locationSearchQuery) {
                    State.locationSearchQuery = '';
                    searchInput.value = '';
                    State.aiSuggestions = [];
                } else if (State.service) {
                    State.service = null;
                } else if (State.subcategory) {
                    State.subcategory = null;
                } else if (State.category) {
                    State.category = null;
                    State.aiSuggestions = [];
                    collapseBottomSheet();
                }
                closeMasterDetail();
                syncUI();
            }

            function highlightSelectedMarker(locId) {
                window.mockLocations.forEach((loc) => {
                    const iconEl = loc.markerInstance && loc.markerInstance._icon;
                    if (!iconEl) return;
                    const inner = iconEl.querySelector('.mapfix-marker-category, .mapfix-marker-price');
                    if (inner) inner.classList.toggle('is-selected', loc.id === locId);
                    if (loc.markerInstance.setZIndexOffset) {
                        loc.markerInstance.setZIndexOffset(loc.id === locId ? 1200 : 0);
                    }
                });
            }

            function renderLocationHero(loc) {
                const heroBox = document.getElementById('detailHeroContent');
                if (!heroBox) return;
                heroBox.innerHTML = '';
                heroBox.hidden = true;
            }

            function locationAvatarHtml(loc) {
                const photos = Array.isArray(loc.photos) ? loc.photos.filter((p) => p && p.url) : [];
                const iconClass = categoryIconClass(loc.cat);
                if (photos[0]?.url) {
                    return `<img src="${escapeHtml(photos[0].url)}" alt="">`;
                }
                return `<i class="fa-solid ${iconClass}" aria-hidden="true"></i>`;
            }

            // Тап по маркеру / картці одразу відкриває профіль локації
            window.openMasterDetail = function(locId, opts = {}) {
                const loc = window.mockLocations.find(l => l.id === locId);
                if (!loc) return;

                const sameSelected = State.selectedLocation?.id === locId;
                const mode = opts.mode || 'dive';
                if (!opts.forceMode && sameSelected && State.detailMode === 'dive' && opts.fromMarker) {
                    enterDetailDive();
                    map.panTo([loc.lat, loc.lng]);
                    highlightSelectedMarker(locId);
                    return;
                }

                fetch('/api/locations/' + encodeURIComponent(locId) + '/view', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sid: mfSid() }),
                }).then(async (r) => {
                    if (!r.ok) return;
                    const j = await r.json().catch(() => ({}));
                    if (typeof j.views === 'number') loc.views = j.views;
                }).catch(() => {});

                State.selectedLocation = loc;
                State.detailMode = mode;
                State.formRatingScore = 5;

                const catName = categoryLabel(
                    window.masterCatalog?.[loc.cat]?.name || loc.cat || ''
                );
                const canOfferClaim = !loc.providerId;
                const locPhoneDigits = String(loc.phone || '').replace(/\D/g, '');
                const locHasClaimPhone = locPhoneDigits.length >= 10;
                const locIdEsc = escapeHtml(loc.id);
                const claimBannerHtml = canOfferClaim
                    ? `<div class="claim-owner-banner" id="claimOwnerBanner" onclick="event.stopPropagation()">
                        <strong>Це ваш заклад?</strong>
                        <p>${
                          locHasClaimPhone
                            ? 'Введіть телефон з картки. Якщо збігається — заклад одразу ваш.'
                            : 'У точки немає телефону для підтвердження. Напишіть нам через «Повідомити про помилку» — призначимо вручну.'
                        }</p>
                        ${
                          locHasClaimPhone
                            ? `<form class="claim-phone-form" id="claimByPhoneForm" onsubmit="event.preventDefault(); event.stopPropagation(); submitClaimByPhone(event, '${locIdEsc}')">
                                <input type="tel" id="claimPhoneInput" inputmode="tel" autocomplete="tel" placeholder="+380XXXXXXXXX" required>
                                <p class="claim-phone-error" id="claimPhoneError" hidden></p>
                                <button type="submit" class="action-btn btn-claim" id="claimLocBtn">Забрати заклад</button>
                                <p class="claim-phone-login">Уже є акаунт? <a href="${escapeHtml(claimLoginUrl(loc.id))}">Увійти</a></p>
                               </form>`
                            : `<button type="button" class="action-btn btn-claim" id="claimLocBtn" onclick="event.stopPropagation(); submitClaimByPhone(event, '${locIdEsc}')">Повідомити, що це мій заклад</button>`
                        }
                       </div>`
                    : '';

                renderLocationHero(loc);

                const providerName = typeof getProviderName === 'function' ? getProviderName(loc) : '';
                const displayName =
                    providerName && providerName !== loc.title
                        ? `${loc.title} / ${providerName}`
                        : loc.title;
                const tgUser = getTelegramUsername(loc);
                const chatHref = getChatHref(loc);
                const specialty = State.service?.name || catName;
                const reviewsN = Number(loc.reviewsCount) || 0;
                const ratingRowHtml = reviewsN > 0
                    ? `<div class="profile-rating-row"><span>${Number(loc.rating || 0).toFixed(1)}</span>${ratingStarsHtml(loc.rating)}<span class="reviews-count">(${reviewsN} відгуків)</span></div>`
                    : `<div class="profile-rating-row"><span class="profile-new-badge">Новий на MapFix</span></div>`;
                const phoneHref = loc.phone ? `tel:${escapeHtml(loc.phone)}` : '';
                const hasCoords = Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng));
                const hasAddress = Boolean(String(loc.address || '').trim());
                const locIdAttr = escapeHtml(loc.id);
                const disabledQuick = (icon, label) =>
                    `<button type="button" class="profile-quick-btn" aria-disabled="true" disabled><i class="fa-solid ${icon}"></i> ${label}</button>`;

                const callBtn = phoneHref
                    ? `<a href="${phoneHref}" class="profile-quick-btn" title="Подзвонити" aria-label="Подзвонити" onclick="event.stopPropagation(); trackLocationClick('${locIdAttr}','call')"><i class="fa-solid fa-phone"></i> Подзвонити</a>`
                    : disabledQuick('fa-phone', 'Подзвонити');
                const chatBtn = chatHref
                    ? `<a href="${escapeHtml(chatHref)}" target="_blank" rel="noopener" class="profile-quick-btn" title="Написати" aria-label="Написати" onclick="event.stopPropagation(); trackLocationClick('${locIdAttr}','chat')"><i class="fa-solid fa-comment"></i> Написати</a>`
                    : disabledQuick('fa-comment', 'Написати');
                const orderBtn = `<button type="button" class="profile-quick-btn" title="Замовити" aria-label="Замовити" onclick="event.stopPropagation(); orderSelectedService('${locIdAttr}')"><i class="fa-solid fa-clipboard-check"></i> Замовити</button>`;
                const routeBtn = hasCoords || hasAddress
                    ? `<button type="button" class="profile-quick-btn" title="Маршрут" aria-label="Маршрут" onclick="event.stopPropagation(); openGoogleMapsDirections('${locIdAttr}')"><i class="fa-solid fa-route"></i> Маршрут</button>`
                    : disabledQuick('fa-route', 'Маршрут');
                const shareBtn = `<button type="button" class="profile-quick-btn" title="Поділитись" aria-label="Поділитись" onclick="event.stopPropagation(); shareLocation('${locIdAttr}')"><i class="fa-solid fa-share-nodes"></i> Поділитись</button><button type="button" class="profile-quick-btn" title="QR-код" aria-label="QR-код" onclick="event.stopPropagation(); showLocationQr('${locIdAttr}')"><i class="fa-solid fa-qrcode"></i> QR</button>`;
                const quickActionsHtml = `<div class="profile-quick-actions">
                        <div class="profile-quick-row row-3">${callBtn}${chatBtn}${orderBtn}</div>
                        <div class="profile-quick-row row-3">${routeBtn}${shareBtn}</div>
                    </div>`;
                const trustPills = [];
                if (loc.providerId) trustPills.push('Гарантія на роботу');
                if (loc.openStatus === 'open') trustPills.push('Зараз працює');
                const trustHtml = trustPills.length
                    ? trustPills.map((t) => `<span class="profile-trust-pill">${escapeHtml(t)}</span>`).join('')
                    : '';

                const headerBox = document.getElementById('detailHeaderContent');
                headerBox.innerHTML = `
                    <button class="back-btn" onclick="event.stopPropagation(); closeMasterDetail()">⬅️ Назад</button>
                    <div class="profile-identity">
                        <div class="profile-avatar-wrap">
                            <div class="profile-avatar">${locationAvatarHtml(loc)}</div>
                            ${loc.providerId ? '<span class="profile-verified-dot" title="Перевірено"><i class="fa-solid fa-check"></i></span>' : ''}
                        </div>
                        <div class="profile-copy">
                            <div class="profile-name-row">
                                <h2 class="profile-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</h2>
                                ${loc.providerId ? '<span class="profile-verified-pill"><i class="fa-solid fa-shield-halved"></i> Verified</span>' : ''}
                            </div>
                            ${tgUser ? `<p class="profile-handle">@${escapeHtml(tgUser)}</p>` : ''}
                            ${ratingRowHtml}
                            ${trustHtml ? `<div class="profile-rating-row">${trustHtml}</div>` : ''}
                            ${specialty ? `<p class="profile-specialty">${escapeHtml(specialty)}</p>` : ''}
                        </div>
                    </div>
                    ${quickActionsHtml}
                `;

                renderDetailBody(loc, { claimBannerHtml, mode });

                const detailView = document.getElementById('sidebar-detail-view');
                detailView.classList.add('show', 'mode-dive');
                detailView.classList.remove('mode-preview');
                enterDetailDive();
                highlightSelectedMarker(loc.id);

                map.panTo([loc.lat, loc.lng]);
                if (!opts.fromMarker && loc.markerInstance && typeof markersLayer.zoomToShowLayer === 'function') {
                    markersLayer.zoomToShowLayer(loc.markerInstance, () => {
                        highlightSelectedMarker(loc.id);
                    });
                }
                refreshClaimButton(loc);
                applyPageSeoFromState();
            };

            function refreshClaimButton(loc) {
                const banner = document.getElementById('claimOwnerBanner');
                if (!banner) return;
                banner.style.display = loc.providerId ? 'none' : '';
            }

            function claimReturnUrl(locationId) {
                return '/p/' + encodeURIComponent(locationId) + '?claim=1';
            }

            function claimLoginUrl(locationId) {
                return '/login.html?next=' + encodeURIComponent(claimReturnUrl(locationId));
            }

            function locationHasClaimPhone(locationId) {
                const loc = (window.mockLocations || []).find((l) => l.id === locationId);
                return String(loc?.phone || '').replace(/\D/g, '').length >= 10;
            }

            function setClaimPhoneError(message) {
                const errEl = document.getElementById('claimPhoneError');
                if (!errEl) {
                    if (message) alert(message);
                    return;
                }
                if (!message) {
                    errEl.hidden = true;
                    errEl.textContent = '';
                    return;
                }
                errEl.hidden = false;
                errEl.textContent = message;
            }

            window.submitClaimByPhone = async function(event, locationId) {
                if (event) {
                    event.preventDefault?.();
                    event.stopPropagation?.();
                }
                trackLocationClick(locationId, 'claim');
                if (!locationHasClaimPhone(locationId)) {
                    if (confirm('У цього закладу немає телефону для підтвердження.\n\nВідкрити форму «Повідомити про помилку», щоб ми призначили вас власником?')) {
                        openSiteFeedbackModal();
                    }
                    return;
                }
                const u = State.currentUser;
                if (u?.role === 'admin') {
                    if (confirm('Ви в акаунті адміна. Відкрити картку в адмінці, щоб призначити власника?')) {
                        location.href = '/admin?pane=locations&loc=' + encodeURIComponent(locationId);
                    }
                    return;
                }
                const phone = String(document.getElementById('claimPhoneInput')?.value || '').trim();
                if (!phone) {
                    setClaimPhoneError('Введіть телефон з картки');
                    document.getElementById('claimPhoneInput')?.focus();
                    return;
                }
                const btn = document.getElementById('claimLocBtn');
                if (btn) btn.disabled = true;
                setClaimPhoneError('');
                try {
                    const res = await fetch(
                        '/api/locations/' + encodeURIComponent(locationId) + '/claim-by-phone',
                        {
                            method: 'POST',
                            credentials: 'same-origin',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone, claimAll: true }),
                        }
                    );
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || 'Не вдалося забрати заклад');
                    if (data.needsRegister && data.registerUrl) {
                        location.href = data.registerUrl;
                        return;
                    }
                    await loadSession();
                    updateHeaderAuthUI();
                    try {
                        const clean = new URL(window.location.href);
                        clean.searchParams.delete('claim');
                        window.history.replaceState({}, '', clean.pathname + clean.search);
                    } catch (_) {}
                    await refreshMapData();
                    openMasterDetail(locationId, { mode: 'dive', forceMode: true });
                    const n = Number(data.claimedCount) || 0;
                    if (data.alreadyOwned) {
                        alert('Цей заклад уже ваш.');
                    } else {
                        alert(n > 1 ? `Готово. Закладів на ваше імʼя: ${n}.` : 'Заклад ваш.');
                    }
                } catch (err) {
                    setClaimPhoneError(err.message || 'Помилка');
                } finally {
                    if (btn) btn.disabled = false;
                }
            };

            window.claimLocationFromMap = function(locationId) {
                return window.submitClaimByPhone(null, locationId);
            };

            function manageLocationBtnHtml(loc) {
                const u = State.currentUser;
                if (!u) return '';
                if (u.role === 'admin') {
                    return `<a class="action-btn btn-route" href="/admin?pane=locations&loc=${encodeURIComponent(loc.id)}" onclick="event.stopPropagation()">⚙️ В адмінці</a>`;
                }
                if (u.role === 'provider' && loc.providerId === u.id) {
                    return `<a class="action-btn btn-route" href="/admin?editLoc=${encodeURIComponent(loc.id)}" onclick="event.stopPropagation()">✏️ Редагувати</a>`;
                }
                return '';
            }

            function openLocationInCabinet(locId) {
                const u = State.currentUser;
                const loc = window.mockLocations.find((l) => l.id === locId);
                if (!u || !loc) return;
                if (u.role === 'admin') {
                    window.location.href = '/admin?pane=locations&loc=' + encodeURIComponent(locId);
                    return;
                }
                if (u.role === 'provider' && loc.providerId === u.id) {
                    window.location.href = '/admin?editLoc=' + encodeURIComponent(locId);
                }
            }

            function renderDetailBody(loc, opts = {}) {
                const bodyBox = document.getElementById('detailBodyContent');
                const orderBar = document.getElementById('detailOrderBar');
                const priceEntries = Object.entries(loc.prices || {});
                const claimBannerHtml = opts.claimBannerHtml || '';
                const selectedService = defaultOrderServiceName(loc);

                let scheduleRowsHtml = '';
                for (const [days, hours] of Object.entries(loc.schedule || {})) {
                    scheduleRowsHtml += `<div class="schedule-row"><span>${escapeHtml(days)}</span><b>${escapeHtml(hours)}</b></div>`;
                }
                if (!scheduleRowsHtml && loc.workingHours) {
                    scheduleRowsHtml = `<div class="schedule-row"><span>Графік</span><b>${escapeHtml(loc.workingHours)}</b></div>`;
                }
                if (!scheduleRowsHtml) {
                    scheduleRowsHtml = '<div style="font-size:12px;color:#94a3b8;">Графік не вказано</div>';
                }

                let reviewsHtml = '';
                if (loc.reviews && loc.reviews.length > 0) {
                    loc.reviews.forEach(rev => {
                        const rating = Math.max(0, Math.min(5, Number(rev.rating) || 0));
                        reviewsHtml += `
                            <div class="review-item">
                                <div class="review-top-line">
                                    <span class="review-stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span>
                                    <span>${escapeHtml(rev.date || '')}</span>
                                </div>
                                <div class="review-text">"${escapeHtml(rev.text || '')}"</div>
                            </div>`;
                    });
                } else if (Number(loc.reviewsCount) > 0) {
                    reviewsHtml = `<div style="font-size:12px; color:#64748b; padding:5px 0;">У Google ${Number(loc.reviewsCount)} відгуків, тексти ще не підтягнуті на карту.</div>`;
                } else {
                    reviewsHtml = '<div style="font-size:12px; color:#94a3b8; padding:5px 0;">Відгуків ще немає. Будьте першим!</div>';
                }

                const aboutText = String(loc.text || '').trim();
                const providerName = typeof getProviderName === 'function' ? getProviderName(loc) : '';
                const fullTitle =
                    providerName && providerName !== loc.title ? `${loc.title} / ${providerName}` : String(loc.title || '');
                const fullTitleHtml =
                    fullTitle.trim().length > 72 && fullTitle.trim() !== aboutText
                        ? `<div class="info-item" style="font-weight:700">${escapeHtml(fullTitle.trim())}</div>`
                        : '';
                const isFav = State.favoriteIds.has(loc.id);
                const distKm = Number.isFinite(loc.currentDistance)
                    ? loc.currentDistance
                    : calculateDistance(State.userCoords.lat, State.userCoords.lng, loc.lat, loc.lng);
                const distLabel = Number.isFinite(distKm) ? `${distKm.toFixed(1)} км` : '';

                const aboutHtml = `<div class="detail-about-inline">
                        <span class="detail-about-i" aria-hidden="true">i</span>
                        <div class="detail-about-copy">
                            ${fullTitleHtml}
                            ${aboutText ? `<div class="info-item" style="font-weight:500">${escapeHtml(aboutText)}</div>` : ''}
                            ${providerName ? `<div class="info-item">👤 ${escapeHtml(providerName)}</div>` : ''}
                            <div class="info-item">🏢 ${escapeHtml(loc.address || 'Адресу не вказано')}</div>
                            <div class="info-item">📞 ${escapeHtml(loc.phone || 'Телефон не вказано')}</div>
                            ${distLabel ? `<div class="info-item">📍 ${escapeHtml(distLabel)}</div>` : ''}
                            ${Number(loc.views) ? `<div class="info-item">👁 Переглядів: ${Number(loc.views)}</div>` : ''}
                        </div>
                    </div>`;

                let priceRowsHtml = '';
                if (!priceEntries.length) {
                    priceRowsHtml = '<div style="font-size:13px;color:#94a3b8;padding:12px 14px;">Прайс ще не додано</div>';
                } else {
                    priceRowsHtml = priceEntries
                        .map(([srvName, srvPrice]) => {
                            const free = isFreePrice(srvPrice);
                            const selected = srvName === selectedService ? ' is-selected' : '';
                            const amt = formatDisplayPrice(srvPrice) || srvPrice;
                            return `<button type="button" class="price-row${free ? ' is-free' : ''}${selected}" data-service="${escapeHtml(srvName)}">
                                <span class="price-row-name"></span>
                                <span class="price-row-amt"></span>
                            </button>`;
                        })
                        .join('');
                }

                const priceCollapsed = !priceEntries.length;
                bodyBox.innerHTML = `
                    <div class="profile-more">
                        <div class="profile-more-head">Адреса, графік і відгуки</div>
                        <div class="profile-more-body">
                            ${aboutHtml}
                            <div class="detail-section">
                                <h4 class="section-title">🕒 Графік роботи</h4>
                                <div class="schedule-table">${scheduleRowsHtml}</div>
                            </div>
                            <div class="detail-section">
                                <h4 class="section-title">⭐ Відгуки (${Number(loc.reviewsCount) || 0})</h4>
                                <div style="display:flex; flex-direction:column; gap:6px;">${reviewsHtml}</div>
                            </div>
                            <div class="detail-section" style="background:#fdfdfd; border-color:#cbd5e1">
                                <h4 class="section-title" style="color: var(--dark);">✍️ Залишити відгук</h4>
                                <div class="review-form">
                                    <div class="rating-stars-input" id="formStarsContainer">
                                        <span data-score="1" class="active">★</span>
                                        <span data-score="2" class="active">★</span>
                                        <span data-score="3" class="active">★</span>
                                        <span data-score="4" class="active">★</span>
                                        <span data-score="5" class="active">★</span>
                                    </div>
                                    <textarea class="review-textarea" id="reviewTextarea" placeholder="Поділіться враженнями від послуги..."></textarea>
                                    <button class="submit-review-btn" onclick="addNewReviewClick('${escapeHtml(loc.id)}')">Надіслати відгук</button>
                                </div>
                            </div>
                            <div class="detail-secondary-row">
                                <button type="button" class="action-btn btn-fav-header ${isFav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${escapeHtml(loc.id)}')">${isFav ? '★ Обране' : '☆ В обране'}</button>
                                <button type="button" class="action-btn btn-report" onclick="event.stopPropagation(); reportLocation('${escapeHtml(loc.id)}')">⚑ Скарга</button>
                                ${manageLocationBtnHtml(loc)}
                            </div>
                            ${claimBannerHtml}
                        </div>
                        <div class="profile-scroll-hint">Гортайте нижче ↓</div>
                    </div>
                    <div class="price-accordion${priceCollapsed ? ' is-collapsed' : ''}" id="detailPriceAccordion">
                        <button type="button" class="price-accordion-head" onclick="event.stopPropagation(); togglePriceAccordion(this)">
                            <span>Детальний прайс-лист</span>
                            <i class="fa-solid fa-chevron-up price-acc-chevron" aria-hidden="true"></i>
                        </button>
                        <div class="price-accordion-body" id="detailPriceList">${priceRowsHtml}</div>
                    </div>
                `;

                const priceList = document.getElementById('detailPriceList');
                if (priceList && priceEntries.length) {
                    priceList.querySelectorAll('.price-row').forEach((row, idx) => {
                        const [srvName, srvPrice] = priceEntries[idx];
                        row.querySelector('.price-row-name').textContent = srvName;
                        row.querySelector('.price-row-amt').textContent = formatDisplayPrice(srvPrice) || srvPrice;
                        row.addEventListener('click', (e) => {
                            e.stopPropagation();
                            selectPriceRow(row, loc.id, srvName);
                        });
                    });
                }

                if (orderBar) {
                    orderBar.hidden = true;
                    orderBar.innerHTML = '';
                }

                setupFormStars();
            }

            window.togglePriceAccordion = function (btn) {
                const acc = btn && btn.closest('.price-accordion');
                if (acc) acc.classList.toggle('is-collapsed');
                if (typeof map !== 'undefined' && map && map.invalidateSize) {
                    setTimeout(() => map.invalidateSize(), 40);
                }
            };

            window.selectPriceRow = function (row, locId, serviceName) {
                document.querySelectorAll('#detailPriceList .price-row').forEach((el) => {
                    el.classList.toggle('is-selected', el === row);
                });
                const loc = window.mockLocations.find((l) => l.id === locId);
                if (loc && serviceName) {
                    loc._selectedService = serviceName;
                }
            };

            window.orderSelectedService = function (locId) {
                const loc = window.mockLocations.find((l) => l.id === locId);
                if (!loc) return;
                const selectedRow = document.querySelector('#detailPriceList .price-row.is-selected');
                const name =
                    (selectedRow && selectedRow.getAttribute('data-service')) ||
                    loc._selectedService ||
                    defaultOrderServiceName(loc);
                placeOrder(locId, name);
            };

            function setupFormStars() {
                const stars = document.querySelectorAll('#formStarsContainer span');
                stars.forEach(star => {
                    star.onclick = () => {
                        const score = parseInt(star.getAttribute('data-score'));
                        State.formRatingScore = score;
                        stars.forEach(s => {
                            const sScore = parseInt(s.getAttribute('data-score'));
                            s.classList.toggle('active', sScore <= score);
                        });
                    };
                });
            }

            window.addNewReviewClick = async function(locId) {
                const text = document.getElementById('reviewTextarea').value.trim();
                if (!text) { alert('Будь ласка, введіть текст вашого відгуку.'); return; }
                if (!State.currentUser || State.currentUser.role !== 'client') {
                    if (confirm('Відгуки можуть залишати клієнти. Увійти?')) {
                        location.href = '/login.html?next=' + encodeURIComponent('/p/' + encodeURIComponent(locId));
                    }
                    return;
                }
                try {
                    const res = await fetch(`/api/locations/${encodeURIComponent(locId)}/reviews`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'same-origin',
                        body: JSON.stringify({ text, rating: State.formRatingScore }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Помилка');
                    trackLocationClick(locId, 'review');
                    const loc = window.mockLocations.find((l) => l.id === locId);
                    if (loc) {
                        loc.reviews = data.reviews || loc.reviews;
                        loc.rating = data.rating;
                        loc.reviewsCount = data.reviewsCount;
                    }
                    openMasterDetail(locId, { mode: 'dive', forceMode: true });
                } catch (err) {
                    alert(err.message);
                }
            };

            window.closeMasterDetail = function() {
                const detailView = document.getElementById('sidebar-detail-view');
                detailView.classList.remove('show', 'mode-preview', 'mode-dive');
                appShell.classList.remove('sheet-dive', 'showing-location');
                const heroBox = document.getElementById('detailHeroContent');
                if (heroBox) heroBox.innerHTML = '';
                const orderBar = document.getElementById('detailOrderBar');
                if (orderBar) {
                    orderBar.hidden = true;
                    orderBar.innerHTML = '';
                }
                State.selectedLocation = null;
                State.detailMode = null;
                highlightSelectedMarker(null);
                if (State.service || State.subcategory || State.category || State.locationSearchQuery) {
                    if (isMobileLayout()) browseBottomSheet();
                }
                if (State.service) {
                    renderLocationList();
                    syncMapMarkers();
                }
                applyPageSeoFromState();
            };

            window.panToMaster = function(lat, lng) {
                map.setView([lat, lng], 15);
                if (isMobileLayout()) {
                    appShell.classList.remove('sheet-dive', 'sheet-browse');
                    appShell.classList.add('sheet-expanded');
                    setTimeout(() => map.invalidateSize(), 400);
                }
            };

            window.openGoogleMapsDirections = function(locId) {
                const loc = window.mockLocations.find((l) => l.id === locId);
                if (!loc) return;

                const lat = Number(loc.lat);
                const lng = Number(loc.lng);
                const address = String(loc.address || '').trim();
                let url;

                if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
                } else if (address) {
                    url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
                } else {
                    return;
                }

                trackLocationClick(locId, 'directions');
                window.open(url, '_blank', 'noopener,noreferrer');
            };

            function renderLocationList() {
                const contentContainer = sidebarContent;
                contentContainer.innerHTML = '';

                if (!State.service && !State.subcategory && !State.category) return;

                let filtered = window.mockLocations.filter((loc) => locationMatchesMapFilter(loc));

                filtered.forEach(loc => { loc.currentDistance = calculateDistance(State.userCoords.lat, State.userCoords.lng, loc.lat, loc.lng); });

                if (State.sortType === 'distance') filtered.sort((a, b) => a.currentDistance - b.currentDistance);
                else if (State.sortType === 'rating') filtered.sort((a, b) => b.rating - a.rating);
                else if (State.sortType === 'alphabet') filtered.sort((a, b) => a.title.localeCompare(b.title, 'uk'));
                else if (State.sortType === 'price' && State.service) {
                    const parsePrice = (pStr) => pStr ? parseInt(String(pStr).replace(/[^0-9]/g, ''), 10) || Infinity : Infinity;
                    filtered.sort((a, b) =>
                        parsePrice(findServicePrice(a, State.service.name)) - parsePrice(findServicePrice(b, State.service.name))
                    );
                }

                if (filtered.length === 0) {
                    contentContainer.innerHTML = '<div style="color:#64748b; font-size:12px; text-align:center; padding:20px;">Нічого не знайдено.</div>';
                    return;
                }

                filtered.forEach(loc => {
                    const card = document.createElement('div');
                    card.className = `provider-card ${State.selectedLocation?.id === loc.id ? 'active' : ''}`;
                    const priceCount = Object.keys(loc.prices || {}).length;
                    let priceText = State.service
                        ? (formatDisplayPrice(findServicePrice(loc, State.service.name)) || 'ціну уточнюйте')
                        : (priceCount ? 'Прайс-лист' : 'Без прайсу');

                    card.innerHTML = `
                        <div class="provider-top">
                            <h2 class="provider-title">${loc.title}</h2>
                            <div class="rating-block"><span class="star-icon">★</span><span>${loc.rating.toFixed(1)}</span><span class="reviews-count">(${loc.reviewsCount})</span></div>
                        </div>
                        <div class="provider-desc">${loc.text}</div>
                        <div class="provider-meta">
                            <span class="status-badge ${loc.openStatus}">${loc.openStatus === 'open' ? 'Відкрито' : 'Зачинено'}</span>
                            <span class="distance-badge">📍 ${loc.currentDistance.toFixed(1)} км</span>
                        </div>
                        <div class="provider-price-row">
                            <span class="provider-badge">${State.service ? 'Послуга' : 'Послуг: ' + priceCount}</span>
                            <span class="provider-card-price">${priceText}</span>
                        </div>`;

                    card.onclick = () => openMasterDetail(loc.id);
                    contentContainer.appendChild(card);
                });
            }

            function normalizeLocationSearch(value) {
                return String(value || '')
                    .toLocaleLowerCase('uk-UA')
                    .replace(/[’'`]/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            function getProviderName(loc) {
                return loc.providerId
                    ? window.providerProfiles?.[loc.providerId]?.companyName || ''
                    : '';
            }

            function locationMatchesSearch(loc, query = State.locationSearchQuery) {
                const words = normalizeLocationSearch(query).split(' ').filter(Boolean);
                if (!words.length) return false;
                const searchable = normalizeLocationSearch([
                    loc.title,
                    loc.address,
                    getProviderName(loc)
                ].filter(Boolean).join(' '));
                return words.every((word) => searchable.includes(word));
            }

            function getLocationSearchResults(query = State.locationSearchQuery) {
                return window.mockLocations.filter((loc) =>
                    locationMatchesSearch(loc, query) &&
                    (!State.onlyOpen || loc.openStatus === 'open')
                );
            }

            function renderLocationSearchResults() {
                sidebarContent.innerHTML = '';
                const results = getLocationSearchResults();
                if (!results.length) {
                    sidebarContent.innerHTML = '<div style="color:#64748b;font-size:12px;text-align:center;padding:20px">Салонів, майстрів або адрес не знайдено.</div>';
                    return;
                }

                results.forEach((loc) => {
                    loc.currentDistance = calculateDistance(
                        State.userCoords.lat,
                        State.userCoords.lng,
                        loc.lat,
                        loc.lng
                    );
                });
                results.sort((a, b) => a.currentDistance - b.currentDistance);

                results.forEach((loc) => {
                    const providerName = getProviderName(loc);
                    const card = document.createElement('div');
                    card.className = `provider-card ${State.selectedLocation?.id === loc.id ? 'active' : ''}`;
                    card.innerHTML = `
                        <div class="provider-top">
                            <h2 class="provider-title">${escapeHtml(loc.title)}</h2>
                            <div class="rating-block"><span class="star-icon">★</span><span>${Number(loc.rating || 0).toFixed(1)}</span></div>
                        </div>
                        ${providerName ? `<div class="provider-desc">Майстер: ${escapeHtml(providerName)}</div>` : ''}
                        ${loc.address ? `<div class="provider-desc">📍 ${escapeHtml(loc.address)}</div>` : ''}
                        <div class="provider-meta">
                            <span class="status-badge ${loc.openStatus}">${loc.openStatus === 'open' ? 'Відкрито' : 'Зачинено'}</span>
                            <span class="distance-badge">${loc.currentDistance.toFixed(1)} км</span>
                        </div>`;
                    card.onclick = () => openMasterDetail(loc.id);
                    sidebarContent.appendChild(card);
                });
            }

            function setSeoMeta(attr, key, content) {
                let el = document.head.querySelector(`meta[${attr}="${key}"]`);
                if (!el) {
                    el = document.createElement('meta');
                    el.setAttribute(attr, key);
                    document.head.appendChild(el);
                }
                el.setAttribute('content', content);
            }
            function applyPageSeo({ title, description, keywords, url }) {
                document.title = title;
                setSeoMeta('name', 'description', description);
                setSeoMeta('name', 'keywords', keywords);
                setSeoMeta('property', 'og:title', title);
                setSeoMeta('property', 'og:description', description);
                setSeoMeta('property', 'og:url', url);
                setSeoMeta('name', 'twitter:title', title);
                setSeoMeta('name', 'twitter:description', description);
                let canon = document.querySelector('link[rel="canonical"]');
                if (!canon) {
                    canon = document.createElement('link');
                    canon.rel = 'canonical';
                    document.head.appendChild(canon);
                }
                // Канонічна адреса — завжди www-хост і шлях без query (як у серверному HTML)
                try {
                    canon.href = 'https://www.mapfix.com.ua' + new URL(url, window.location.origin).pathname;
                } catch (_) {
                    canon.href = url;
                }
            }
            function shareUrlFromState() {
                const origin = window.location.origin;
                const cur = new URLSearchParams(window.location.search);
                const next = new URLSearchParams();
                if (State.selectedLocation && cur.get('claim') === '1') next.set('claim', '1');
                ['add', 'feedback', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach((k) => {
                    const v = cur.get(k);
                    if (v) next.set(k, v);
                });
                const qs = next.toString();
                return origin + sharePathFromState() + (qs ? '?' + qs : '');
            }
            function applyPageSeoFromState() {
                const origin = window.location.origin;
                const url = shareUrlFromState();
                const place = areaPlaceName();
                const placeBit = cityScopeTitle();
                if (State.selectedLocation) {
                    const loc = State.selectedLocation;
                    const catName = categoryLabel(
                        window.masterCatalog?.[loc.cat]?.name || loc.cat || 'майстер'
                    );
                    const shortTitle = String(loc.title || 'Майстер').replace(/\s+/g, ' ').trim().slice(0, 58);
                    applyPageSeo({
                        title: `${shortTitle} — ${catName} | Mapfix`,
                        description: `${shortTitle}: ${loc.address || 'Київ'}. Телефон, маршрут і відгуки на карті Mapfix.`,
                        keywords: `${shortTitle}, ${catName}, майстер додому, Київ, Mapfix`,
                        url,
                    });
                } else if (State.category) {
                    const cat = window.masterCatalog?.[State.category];
                    const name = categoryLabel(cat?.name || State.category);
                    const subKey = State.subcategory;
                    const subCopy = {
                        'home/plumber': {
                            title: `Сантехнік${placeBit} — виклик майстра | Mapfix`,
                            description: `Сантехнік${placeBit}: засмічення, змішувач, унітаз. Телефонуйте майстру з карти Mapfix без комісії.`,
                        },
                        'home/electrician': {
                            title: `Електрик${placeBit} — розетка, щиток, люстра | Mapfix`,
                            description: `Електрик${placeBit}: розетка, люстра, проводка. Порівняйте майстрів на карті Mapfix.`,
                        },
                        'home/handyman': {
                            title: `Майстер на годину${placeBit} — дрібний ремонт | Mapfix`,
                            description: `Чоловік на годину${placeBit}: полиця, телевізор, дрібний ремонт. Без комісій на Mapfix.`,
                        },
                        'auto/tyres': {
                            title: `Шиномонтаж${placeBit} — заміна шин | Mapfix`,
                            description: `Шиномонтаж${placeBit}: сезонна заміна і балансування. Оберіть сервіс на карті Mapfix.`,
                        },
                    }[State.category + '/' + subKey];
                    const homeNiche = State.category === 'home' && !subKey;
                    applyPageSeo({
                        title: subCopy
                            ? subCopy.title
                            : homeNiche
                            ? `Сантехнік і майстер додому${placeBit} | Mapfix`
                            : `${name}${placeBit} — майстри поруч | Mapfix`,
                        description: subCopy
                            ? subCopy.description
                            : homeNiche
                            ? `Сантехнік, електрик і майстер додому${placeBit}. Без комісій — оберіть виконавця на карті Mapfix.`
                            : `${name}${placeBit}. Майстер додому, ремонт — оберіть виконавця на карті Mapfix.`,
                        keywords: `${name}, ${place || 'Київ'}, майстер додому, сантехнік Київ, ремонт, Mapfix`,
                        url,
                    });
                } else {
                    applyPageSeo({
                        title: place
                            ? `Майстри${placeBit} — карта послуг Mapfix`
                            : 'Mapfix — майстер додому, сантехнік Київ, ремонт поруч',
                        description: place
                            ? `Карта майстрів${placeBit}: сантехнік, ремонт, авто. Телефонуйте напряму, без комісій.`
                            : 'Карта майстрів у Києві: сантехнік, ремонт квартири, майстер додому. Знайдіть виконавця поруч, порівняйте ціни й замовте послугу на Mapfix.',
                        keywords: place
                            ? `майстер ${place}, сантехнік ${place}, ремонт, Mapfix`
                            : 'майстер додому, сантехнік Київ, ремонт, майстер Київ, карта послуг, сантехнік, електрик, ремонт квартири, Mapfix',
                        url,
                    });
                }
                try {
                    const cur = new URLSearchParams(window.location.search);
                    if (cur.get('claim') === '1') return;
                    const parsed = new URL(url, origin);
                    history.replaceState(null, '', parsed.pathname + parsed.search);
                } catch (_) {}
            }

            function syncUI() {
                renderCatalogNav();
                applyPageSeoFromState();
            }

            function buildLocationIcon(loc) {
                const selected = State.selectedLocation?.id === loc.id;
                const selectedClass = selected ? ' is-selected' : '';
                if (State.service) {
                    const raw = findServicePrice(loc, State.service.name);
                    const price = formatDisplayPrice(raw) || 'уточн.';
                    const width = Math.min(120, Math.max(52, price.length * 7 + 16));
                    return L.divIcon({
                        className: 'mapfix-marker-wrap',
                        html: `<div class="mapfix-marker-price${selectedClass}">${escapeHtml(price)}</div>`,
                        iconSize: [width, 32],
                        iconAnchor: [width / 2, 32],
                    });
                }
                const iconClass = categoryIconClass(loc.cat);
                return L.divIcon({
                    className: 'mapfix-marker-wrap',
                    html: `<div class="mapfix-marker-category${selectedClass}"><i class="fa-solid ${iconClass}"></i></div>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11],
                });
            }

            function syncMapMarkers() {
                markersLayer.clearLayers();
                window.mockLocations.forEach((loc) => {
                    loc.markerInstance = null;
                });

                const visible = [];
                const batch = [];
                window.mockLocations.forEach((loc) => {
                    if (!locationMatchesMapFilter(loc)) return;
                    if (!Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) return;

                    loc.markerInstance = L.marker([loc.lat, loc.lng], {
                        icon: buildLocationIcon(loc),
                    });
                    loc.markerInstance.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        openMasterDetail(loc.id, { fromMarker: true });
                    });
                    loc.markerInstance.on('dblclick', (e) => {
                        L.DomEvent.stopPropagation(e);
                        L.DomEvent.preventDefault(e);
                        openMasterDetail(loc.id, { mode: 'dive', forceMode: true, fromMarker: true });
                    });
                    batch.push(loc.markerInstance);
                    visible.push(loc);
                });

                if (batch.length) markersLayer.addLayers(batch);
                highlightSelectedMarker(State.selectedLocation?.id);

                const shouldFit =
                    !State.nearMe &&
                    (State.service ||
                    State.subcategory ||
                    State.category ||
                    State.locationSearchQuery);
                if (shouldFit && visible.length > 0) {
                    const bounds = L.latLngBounds(visible.map((l) => [l.lat, l.lng]));
                    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 13 });
                }
            }

            function openPopupForLocation(loc) {
                if (!loc?.markerInstance) return;
                const dist = Number.isFinite(loc.currentDistance)
                    ? loc.currentDistance.toFixed(1)
                    : calculateDistance(
                          State.userCoords.lat,
                          State.userCoords.lng,
                          loc.lat,
                          loc.lng
                      ).toFixed(1);
                const content = `<div style="font-family: sans-serif; width: 160px;"><div style="font-weight:800; font-size:12px;">${escapeHtml(loc.title)}</div><div style="font-size:11px; color:var(--primary); font-weight:700; margin-top:2px;">📍 Відстань: ${dist} км</div></div>`;
                loc.markerInstance.bindPopup(content);
                markersLayer.zoomToShowLayer(loc.markerInstance, () => {
                    loc.markerInstance.openPopup();
                });
            }

            function resetToHome(opts = {}) {
                const keepSearch = Boolean(opts.keepSearch);
                const searchField = document.getElementById('searchInput');
                if (!keepSearch) {
                    State.locationSearchQuery = '';
                    if (searchField) searchField.value = '';
                }
                State.category = null;
                State.subcategory = null;
                State.service = null;
                State.selectedLocation = null;
                State.detailMode = null;
                State.area = null;
                State.aiSuggestions = [];
                State.onlyOpen = false;
                State.onlyPhone = false;
                State.onlyPrice = false;
                State.onlyRated = false;
                setNearMeMode(false);
                const onlyOpenCheckbox = document.getElementById('onlyOpenCheckbox');
                if (onlyOpenCheckbox) onlyOpenCheckbox.checked = false;
                ['onlyPhoneCheckbox', 'onlyPriceCheckbox', 'onlyRatedCheckbox'].forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.checked = false;
                });
                closeMasterDetail();
                collapseBottomSheet();
                syncUI();
            }

            function handleL1Click(catId) {
                // Повторний тап по активній категорії — зняти вибір і показати всі на карті
                if (State.category === catId) {
                    resetToHome();
                    return;
                }
                trackCatalogClick({ type: 'category', categoryKey: catId });
                State.locationSearchQuery = '';
                const searchField = document.getElementById('searchInput');
                if (searchField) searchField.value = '';
                State.aiSuggestions = [];
                State.category = catId;
                State.subcategory = null;
                State.service = null;
                State.selectedLocation = null;
                State.detailMode = null;
                closeMasterDetail();
                browseBottomSheet();
                syncUI();
            }

            function handleL2Click(subId) {
                trackCatalogClick({
                    type: 'subcategory',
                    categoryKey: State.category,
                    subcategoryKey: subId,
                });
                State.subcategory = subId;
                State.service = null;
                State.selectedLocation = null;
                expandBottomSheet();
                syncUI();
            }

            function handleL3Click(srv) {
                trackCatalogClick({
                    type: 'service',
                    categoryKey: State.category,
                    subcategoryKey: State.subcategory,
                    serviceName: srv.name,
                });
                State.service = { name: srv.name, price: srv.price };
                State.selectedLocation = null;
                expandBottomSheet();
                syncUI();
            }

            function isActiveSuggestion(s) {
                if (!s?.category || State.category !== s.category) return false;
                if ((s.subcategory || null) !== (State.subcategory || null)) return false;
                const srv = State.service?.name || null;
                return (s.service || null) === srv;
            }

            function renderAiSuggestionsInto(container) {
                if (!container || !State.aiSuggestions?.length) return;
                const wrap = document.createElement('div');
                wrap.className = 'ai-suggestions';
                const title = document.createElement('div');
                title.className = 'ai-suggestions-title';
                title.textContent = 'Gemini: релевантні варіанти';
                wrap.appendChild(title);

                State.aiSuggestions.forEach((s) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'ai-suggestion-chip' + (isActiveSuggestion(s) ? ' active' : '');
                    const typeLabel =
                        s.type === 'service' ? 'Послуга' : s.type === 'subcategory' ? 'Підкатегорія' : 'Категорія';
                    btn.innerHTML = `
                        <span class="ai-suggestion-type">${typeLabel}</span>
                        <span class="ai-suggestion-label">${escapeHtml(s.label || s.service || s.subcategory || s.category || '')}</span>`;
                    btn.addEventListener('click', () => applyCatalogSearchFilter(s, { keepSuggestions: true }));
                    wrap.appendChild(btn);
                });
                container.prepend(wrap);
            }

            function applyCatalogSearchFilter(result, opts = {}) {
                const { category, subcategory, service } = result || {};
                if (!category || !window.masterCatalog[category]) {
                    throw new Error('Категорію не знайдено в каталозі');
                }

                if (!opts.keepSuggestions) {
                    // keep existing suggestions unless explicitly replaced by caller
                }

                State.locationSearchQuery = '';
                State.category = category;
                State.subcategory = subcategory || null;
                State.service = null;
                State.selectedLocation = null;
                State.detailMode = null;

                if (service && State.subcategory) {
                    const items = window.masterCatalog[category]?.subcats?.[State.subcategory]?.items || [];
                    const srv = items.find((i) => i.name === service);
                    if (srv) State.service = { name: srv.name, price: srv.price };
                }

                closeMasterDetail();
                browseBottomSheet();
                syncUI();
            }

            function applyVoiceSearchFilter(result) {
                applyCatalogSearchFilter(result);
            }

            /* ---- Голосовий пошук (Web Speech API + /api/search-ai) ---- */
            const voiceSearchBtn = document.getElementById('voiceSearchBtn');
            const voiceStatus = document.getElementById('voiceStatus');
            const voiceStatusText = document.getElementById('voiceStatusText');
            const searchInput = document.getElementById('searchInput');
            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            let voiceRecognition = null;
            let voiceBusy = false;

            function setVoiceUI(mode, text) {
                voiceSearchBtn.classList.remove('listening', 'processing');
                if (mode === 'listening') {
                    voiceSearchBtn.classList.add('listening');
                    voiceStatus.classList.remove('hidden');
                    voiceStatusText.textContent = text || 'Слухаю...';
                } else if (mode === 'processing') {
                    voiceSearchBtn.classList.add('processing');
                    voiceStatus.classList.remove('hidden');
                    voiceStatusText.textContent = text || 'Аналізую запит...';
                } else {
                    voiceStatus.classList.add('hidden');
                }
            }

            async function runAiSearch(transcript) {
                setVoiceUI('processing', 'Gemini аналізує запит...');
                searchInput.value = transcript;

                const res = await fetch('/api/search-ai', {
                    method: 'POST',
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: transcript }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Помилка AI-пошуку');

                State.aiSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];

                if (data.category) {
                    applyCatalogSearchFilter(data, { keepSuggestions: true });
                    const top = State.aiSuggestions[0];
                    const label = top?.label || data.service || data.subcategory || data.category;
                    const src = data.source === 'gemini' ? 'Gemini' : 'каталог';
                    setVoiceUI('listening', `${src}: ${label}`);
                    setTimeout(() => setVoiceUI('idle'), 2200);
                    return;
                }

                // Якщо каталог не визначено — показуємо текстові збіги локацій
                const directMatches = getLocationSearchResults(transcript);
                State.locationSearchQuery = transcript;
                State.category = null;
                State.subcategory = null;
                State.service = null;
                State.selectedLocation = null;
                closeMasterDetail();
                syncUI();
                setVoiceUI(
                    'listening',
                    directMatches.length ? `Знайдено місць: ${directMatches.length}` : 'Нічого не знайдено'
                );
                setTimeout(() => setVoiceUI('idle'), 1800);
            }

            function startVoiceSearch() {
                if (voiceBusy) return;
                if (!SpeechRecognition) {
                    alert('Голосовий пошук не підтримується у цьому браузері. Спробуйте Chrome.');
                    return;
                }

                voiceRecognition = new SpeechRecognition();
                voiceRecognition.lang = 'uk-UA';
                voiceRecognition.interimResults = false;
                voiceRecognition.maxAlternatives = 1;
                voiceRecognition.continuous = false;

                voiceBusy = true;
                let gotVoiceResult = false;
                setVoiceUI('listening', 'Слухаю...');

                voiceRecognition.onresult = async (event) => {
                    gotVoiceResult = true;
                    const transcript = event.results[0][0].transcript.trim();
                    if (!transcript) {
                        setVoiceUI('idle');
                        voiceBusy = false;
                        return;
                    }
                    try {
                        await runAiSearch(transcript);
                    } catch (err) {
                        alert(err.message);
                        setVoiceUI('idle');
                    } finally {
                        voiceBusy = false;
                    }
                };

                voiceRecognition.onerror = (event) => {
                    voiceBusy = false;
                    setVoiceUI('idle');
                    if (event.error !== 'aborted' && event.error !== 'no-speech') {
                        alert('Помилка розпізнавання: ' + event.error);
                    }
                };

                voiceRecognition.onend = () => {
                    if (!gotVoiceResult && voiceBusy) {
                        voiceBusy = false;
                        setVoiceUI('idle');
                    }
                };

                try {
                    voiceRecognition.start();
                } catch (err) {
                    voiceBusy = false;
                    setVoiceUI('idle');
                    alert('Не вдалося запустити мікрофон');
                }
            }

            voiceSearchBtn.addEventListener('click', startVoiceSearch);

            searchInput.addEventListener('keydown', async (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const text = searchInput.value.trim();
                if (!text || voiceBusy) return;
                voiceBusy = true;
                try {
                    await runAiSearch(text);
                } catch (err) {
                    alert(err.message);
                    setVoiceUI('idle');
                } finally {
                    voiceBusy = false;
                }
            });

            let searchSuggestTimer = null;

            function hideSearchSuggest() {
                const box = document.getElementById('searchSuggest');
                if (!box) return;
                box.hidden = true;
                box.innerHTML = '';
                searchInput.setAttribute('aria-expanded', 'false');
            }

            function collectSearchSuggestions(query) {
                const q = normalizeLocationSearch(query);
                if (q.length < 2) return [];
                const catalog = window.masterCatalog || {};
                const cats = [];
                const subs = [];
                const locs = [];
                Object.entries(catalog).forEach(([catKey, cat]) => {
                    const name = categoryLabel(cat?.name || catKey);
                    if (normalizeLocationSearch(name).includes(q)) {
                        cats.push({ kind: 'category', label: name, cat: catKey });
                    }
                    Object.entries(cat?.subcats || {}).forEach(([subKey, sub]) => {
                        const subName = categoryLabel(sub?.name || subKey);
                        const hay = normalizeLocationSearch([subName, subKey, ...(sub?.tags || [])].join(' '));
                        if (hay.includes(q)) {
                            subs.push({
                                kind: 'subcategory',
                                label: subName,
                                cat: catKey,
                                sub: subKey,
                                meta: name,
                            });
                        }
                    });
                });
                (window.mockLocations || []).forEach((loc) => {
                    const title = String(loc.title || '').trim();
                    if (!title) return;
                    if (normalizeLocationSearch(title).includes(q)) {
                        locs.push({
                            kind: 'location',
                            label: title,
                            id: loc.id,
                            meta: String(loc.address || '').trim(),
                        });
                    }
                });
                const rank = (label) => {
                    const n = normalizeLocationSearch(label);
                    if (n.startsWith(q)) return 0;
                    if (n.split(' ').some((word) => word.startsWith(q))) return 1;
                    return 2;
                };
                const byRank = (a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label, 'uk');
                cats.sort(byRank);
                subs.sort(byRank);
                locs.sort(byRank);
                return [...cats.slice(0, 3), ...subs.slice(0, 3), ...locs.slice(0, 4)].slice(0, 8);
            }

            function applySearchSuggest(item) {
                hideSearchSuggest();
                if (!item) return;
                if (item.kind === 'map') {
                    State.locationSearchQuery = item.query;
                    State.category = null;
                    State.subcategory = null;
                    State.service = null;
                    State.aiSuggestions = [];
                    State.selectedLocation = null;
                    closeMasterDetail();
                    browseBottomSheet();
                    syncUI();
                    return;
                }
                if (item.kind === 'location') {
                    searchInput.value = item.label;
                    openMasterDetail(item.id, { mode: 'dive', forceMode: true });
                    return;
                }
                searchInput.value = item.label;
                applyCatalogSearchFilter(
                    { category: item.cat, subcategory: item.sub || null },
                    { keepSuggestions: false }
                );
                State.aiSuggestions = [];
            }

            function renderSearchSuggest(items, query) {
                const box = document.getElementById('searchSuggest');
                if (!box) return;
                const kindLabel = {
                    category: 'Категорія',
                    subcategory: 'Підкатегорія',
                    location: 'Заклад',
                };
                box.innerHTML = '';
                items.forEach((item) => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'search-suggest-item';
                    btn.setAttribute('role', 'option');
                    btn.title = item.label;
                    btn.innerHTML = `
                        <span class="search-suggest-kind">${kindLabel[item.kind] || ''}</span>
                        <span class="search-suggest-label"></span>
                        ${item.meta ? '<span class="search-suggest-meta"></span>' : ''}`;
                    btn.querySelector('.search-suggest-label').textContent = item.label;
                    if (item.meta) btn.querySelector('.search-suggest-meta').textContent = item.meta;
                    btn.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        applySearchSuggest(item);
                    });
                    box.appendChild(btn);
                });
                if (query) {
                    const show = document.createElement('button');
                    show.type = 'button';
                    show.className = 'search-suggest-item is-map';
                    show.setAttribute('role', 'option');
                    show.innerHTML = `
                        <span class="search-suggest-kind">На мапі</span>
                        <span class="search-suggest-label"></span>`;
                    show.querySelector('.search-suggest-label').textContent = `Показати «${query}» на мапі`;
                    show.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        applySearchSuggest({ kind: 'map', query });
                    });
                    box.appendChild(show);
                }
                box.hidden = false;
                searchInput.setAttribute('aria-expanded', 'true');
            }

            searchInput.addEventListener('input', () => {
                const text = searchInput.value.trim();
                if (!text && State.locationSearchQuery) {
                    State.locationSearchQuery = '';
                    syncUI();
                }
                clearTimeout(searchSuggestTimer);
                if (text.length < 2) {
                    hideSearchSuggest();
                    return;
                }
                searchSuggestTimer = setTimeout(() => {
                    if (searchInput.value.trim() !== text) return;
                    renderSearchSuggest(collectSearchSuggestions(text), text);
                }, 200);
            });

            searchInput.addEventListener('blur', () => {
                setTimeout(hideSearchSuggest, 180);
            });

            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') hideSearchSuggest();
            });

            const sheetHandle = document.getElementById('sheetHandle');
            let sheetDragStartY = 0;
            let sheetDragging = false;

            sheetHandle.addEventListener('click', () => {
                if (!isMobileLayout() || sheetDragging) return;
                raiseSheetLevel();
            });

            sheetHandle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    raiseSheetLevel();
                }
            });

            sheetHandle.addEventListener('touchstart', (e) => {
                if (!isMobileLayout()) return;
                sheetDragging = false;
                sheetDragStartY = e.touches[0].clientY;
            }, { passive: true });

            sheetHandle.addEventListener('touchmove', (e) => {
                if (!isMobileLayout()) return;
                const dy = e.touches[0].clientY - sheetDragStartY;
                if (Math.abs(dy) > 12) sheetDragging = true;
            }, { passive: true });

            sheetHandle.addEventListener('touchend', (e) => {
                if (!isMobileLayout()) return;
                const diff = e.changedTouches[0].clientY - sheetDragStartY;
                if (Math.abs(diff) < 36) return;
                if (diff < 0) raiseSheetLevel();
                else lowerSheetLevel();
            }, { passive: true });

            window.addEventListener('resize', () => {
                syncMobileViewport();
                if (!isMobileLayout()) {
                    appShell.classList.remove('sheet-expanded', 'sheet-browse', 'sheet-dive');
                }
                map.invalidateSize();
            });

            (function applyCatalogFromUrl() {
                const landing = parseClientLanding();
                if (landing.area) {
                    const area = resolveMapArea(landing.area);
                    if (area) applyMapArea(area);
                }
                if (!landing.loc && landing.cat && window.masterCatalog?.[landing.cat]) {
                    State.category = landing.cat;
                    if (landing.sub && window.masterCatalog[landing.cat]?.subcats?.[landing.sub]) {
                        State.subcategory = landing.sub;
                    }
                    browseBottomSheet();
                }
            })();

            window.addEventListener('popstate', () => {
                const landing = parseClientLanding();
                State.area = landing.area || null;
                State.category = landing.cat && window.masterCatalog?.[landing.cat] ? landing.cat : null;
                State.subcategory = State.category && landing.sub && window.masterCatalog[State.category]?.subcats?.[landing.sub]
                    ? landing.sub
                    : null;
                State.service = null;
                if (landing.area) {
                    const area = resolveMapArea(landing.area);
                    if (area) applyMapArea(area);
                }
                if (landing.loc) {
                    openMasterDetail(landing.loc, { mode: 'dive', forceMode: true });
                    return;
                }
                closeMasterDetail();
                if (State.category) browseBottomSheet();
                syncUI();
            });

            syncUI();
            setTimeout(() => map.invalidateSize(), 300);

            window.__mapfixRefreshMap = refreshMapData;

            if (window.MapfixDataSync) {
                MapfixDataSync.subscribe(() => {
                    refreshMapData().catch((err) => console.warn('refreshMapData:', err));
                });
            }

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
            }

            (function initPwaInstall() {
                const DISMISS_KEY = 'mapfix_pwa_banner_dismissed_v1';
                const banner = document.getElementById('pwaInstallBanner');
                const modal = document.getElementById('pwaInstallModal');
                const stepsEl = document.getElementById('pwaInstallSteps');
                const leadEl = document.getElementById('pwaInstallLead');
                const confirmBtn = document.getElementById('pwaInstallConfirm');
                let deferredPrompt = null;

                function isStandalone() {
                    return (
                        window.matchMedia('(display-mode: standalone)').matches ||
                        window.navigator.standalone === true
                    );
                }

                function isIos() {
                    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                }

                function isAndroid() {
                    return /android/i.test(navigator.userAgent);
                }

                function canShowBanner() {
                    if (isStandalone()) return false;
                    try {
                        if (localStorage.getItem(DISMISS_KEY) === '1') return false;
                    } catch (_) {}
                    return true;
                }

                function hideBanner() {
                    banner?.classList.remove('show');
                }

                function showBanner() {
                    if (!canShowBanner() || !banner) return;
                    banner.classList.add('show');
                }

                function closeModal() {
                    if (!modal) return;
                    modal.classList.remove('show');
                    modal.setAttribute('aria-hidden', 'true');
                }

                function openModal(mode) {
                    if (!modal || !stepsEl || !leadEl || !confirmBtn) return;
                    if (mode === 'native' && deferredPrompt) {
                        leadEl.textContent = 'Натисніть «Встановити» — з’явиться системне вікно Android/Chrome.';
                        stepsEl.innerHTML = '<li>Підтвердіть встановлення Mapfix на телефон</li><li>Іконка з’явиться на головному екрані</li>';
                        confirmBtn.style.display = '';
                        confirmBtn.textContent = 'Встановити';
                    } else if (isIos()) {
                        leadEl.textContent = 'На iPhone Safari сам не пропонує встановлення. Зробіть так:';
                        stepsEl.innerHTML = [
                            '<li>Натисніть кнопку <strong>Поділитися</strong> (□↑) внизу Safari</li>',
                            '<li>Прокрутіть меню й оберіть <strong>«На екран «Додому»»</strong></li>',
                            '<li>Натисніть <strong>Додати</strong> — з’явиться іконка Mapfix</li>',
                        ].join('');
                        confirmBtn.style.display = 'none';
                    } else if (isAndroid()) {
                        leadEl.textContent = 'Якщо системне вікно не з’явилось, додайте вручну в Chrome:';
                        stepsEl.innerHTML = [
                            '<li>Відкрийте меню Chrome <strong>⋮</strong> праворуч угорі</li>',
                            '<li>Оберіть <strong>«Встановити додаток»</strong> або <strong>«Додати на головний екран»</strong></li>',
                            '<li>Підтвердіть — іконка Mapfix з’явиться на екрані</li>',
                        ].join('');
                        confirmBtn.style.display = 'none';
                    } else {
                        leadEl.textContent = 'У браузері відкрийте меню і додайте Mapfix на головний екран / як додаток.';
                        stepsEl.innerHTML = '<li>Chrome / Edge: меню → «Встановити Mapfix» або «Додати на головний екран»</li>';
                        confirmBtn.style.display = 'none';
                    }
                    modal.classList.add('show');
                    modal.setAttribute('aria-hidden', 'false');
                }

                async function promptInstall() {
                    if (isStandalone()) return;
                    if (deferredPrompt) {
                        openModal('native');
                        return;
                    }
                    openModal('manual');
                }

                function syncInstallUi() {
                    const headerBtn = document.getElementById('installAppHeaderBtn');
                    if (headerBtn) headerBtn.classList.toggle('hidden', isStandalone());
                    if (typeof updateHeaderAuthUI === 'function') updateHeaderAuthUI();
                }

                window.MapfixPwa = {
                    isStandalone,
                    promptInstall,
                    refreshMenu: syncInstallUi,
                };

                window.addEventListener('beforeinstallprompt', (e) => {
                    e.preventDefault();
                    deferredPrompt = e;
                    showBanner();
                    syncInstallUi();
                });

                window.addEventListener('appinstalled', () => {
                    deferredPrompt = null;
                    hideBanner();
                    closeModal();
                    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
                    syncInstallUi();
                });

                document.getElementById('pwaInstallDismiss')?.addEventListener('click', () => {
                    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
                    hideBanner();
                });

                document.getElementById('pwaInstallBannerBtn')?.addEventListener('click', () => {
                    promptInstall();
                });
                document.getElementById('installAppHeaderBtn')?.addEventListener('click', () => {
                    promptInstall();
                });

                document.getElementById('pwaInstallClose')?.addEventListener('click', closeModal);
                modal?.addEventListener('click', (e) => {
                    if (e.target === modal) closeModal();
                });

                confirmBtn?.addEventListener('click', async () => {
                    if (!deferredPrompt) {
                        closeModal();
                        return;
                    }
                    deferredPrompt.prompt();
                    try { await deferredPrompt.userChoice; } catch (_) {}
                    deferredPrompt = null;
                    hideBanner();
                    closeModal();
                    syncInstallUi();
                });

                syncInstallUi();

                // iOS / browsers without beforeinstallprompt: soft hint after short use
                if (!isStandalone() && canShowBanner() && (isIos() || isAndroid())) {
                    setTimeout(() => {
                        if (!deferredPrompt) showBanner();
                    }, 8000);
                }
            })();
        });
