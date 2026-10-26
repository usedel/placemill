(function () {
    'use strict';

// R-12: the script can reach the same document twice (webview init script plus
// a manual eval). A second run would wrap its fetch/XHR hooks around the first
// run's, stacking one clone+parse layer per response and double-inserting
// rows. One document, one injection.
if (window.__placemillInjected) {
    return;
}
window.__placemillInjected = true;

// ============================================================
// 0.0 Entry points driven by Rust (R-31)
//
// This code runs inside a third-party document. Anything the app puts on
// `window` is writable by Google's own scripts (and by any extension or
// injected snippet), so a page script could swap `__placemillGoto` for a version
// that navigates anywhere, or call `__placemillTest` to push fabricated rows
// into SQLite. The entry points are therefore defined as non-writable,
// non-enumerable and non-configurable, and the debug helpers only exist when
// Rust injected `__PLACE_MILL_DEBUG__` (debug builds).
// ============================================================
var DEBUG_BUILD = window.__PLACE_MILL_DEBUG__ === true;

function defineEntryPoint(name, value) {
    try {
        Object.defineProperty(window, name, {
            value: value,
            writable: false,
            enumerable: false,
            configurable: false,
        });
    } catch (e) {
        console.error('[Placemill] could not define ' + name + ':', e && e.message);
    }
}

// The runner only ever navigates inside Google Maps; anything else — an
// injected `javascript:`, a redirect to another host — is refused here instead
// of being left to whatever the caller passed.
function isAllowedMapsUrl(url) {
    try {
        var parsed = new URL(url, location.href);
        if (parsed.protocol !== 'https:') return false;
        var host = parsed.hostname.toLowerCase();
        return host === 'google.com' || host.endsWith('.google.com');
    } catch (e) {
        return false;
    }
}

// Tile identity is attribution data written by the runner. Keep the two known
// string fields and drop anything else, so a page script cannot stuff the row
// with arbitrary payload.
function sanitizeTileContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    var out = {};
    var keys = ['jobId', 'tileId'];
    for (var index = 0; index < keys.length; index += 1) {
        var value = ctx[keys[index]];
        if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
            out[keys[index]] = value;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

function setTileContext(ctx) {
    try {
        var clean = sanitizeTileContext(ctx);
        if (clean) {
            sessionStorage.setItem(TILE_CONTEXT_KEY, JSON.stringify(clean));
        } else {
            sessionStorage.removeItem(TILE_CONTEXT_KEY);
        }
    } catch (e) {
        console.warn('[Placemill] tile context unavailable:', e && e.message);
    }
}

var VERSION = 'v2.21';
var PENDING = [];
var counters = { fetch: 0, xhr: 0, matched: 0, parsed: 0, sent: 0, skipped: 0 };
// Epoch ms of the last `/search?tbm=map` response, whatever it contained.
// UI-01b's health probe reads it: "no response for 20 s and no result feed"
// is the signature of a search that silently produced nothing.
var lastMapResponseAt = 0;

// Global switch: owned by Rust, off by default (no sending, no scrolling).
//
// Rust re-asserts it on every document (`collector_settings_script`), so the
// localStorage mirror below is only this document's value for the few
// milliseconds before that eval lands. It is still read — a tile navigation
// must start collecting immediately, not after a round trip — but it is no
// longer the authority, and a stale '1' can no longer start a scroll loop by
// itself: there is no boot-time auto-resume any more (see section 6).
window.__placemillEnabled = (function () {
    try {
        return window.localStorage.getItem('__placemillEnabled') === '1';
    } catch (e) {
        return false;
    }
})();

// Only log URLs related to Google Maps business search data, stay silent otherwise
function isTargetUrl(url) {
    if (!url) return false;
    return /search\?tbm=map/i.test(url);
}

// R-08: a target response larger than this is logged and skipped, not parsed.
// Real search payloads stay far below it (the biggest observed are a few MB);
// the cap exists so a runaway or hostile response cannot pin the page inside
// JSON.parse for seconds.
var MAX_BODY_BYTES = 8 * 1024 * 1024;

// ============================================================
// 0.1 Batch metadata + event plumbing
//
// Declared before the network hooks and the auto-scroll module: `autoScroll`
// lives in its own IIFE (section 6) and would otherwise have no way to reach
// `emitEvent`, while `flushData` needs `queryFromUrl` at parse time.
// ============================================================

// The tile context is persisted in sessionStorage because every grid cell in a
// job starts with a full page load. Written by `__placemillSetTileContext`
// (M2's `__placemillGoto` will call it right before navigating) and read again
// when a batch is sent, so the row can be attributed to its cell.
var TILE_CONTEXT_KEY = 'placemill.tileContext';

function readTileContext() {
    try {
        var raw = sessionStorage.getItem(TILE_CONTEXT_KEY);
        if (!raw) return null;
        var ctx = JSON.parse(raw);
        return (ctx && typeof ctx === 'object') ? ctx : null;
    } catch (e) {
        return null;
    }
}

defineEntryPoint('__placemillSetTileContext', setTileContext);

function currentTileField(name) {
    var ctx = readTileContext();
    return (ctx && typeof ctx[name] === 'string') ? ctx[name] : '';
}

// Single navigation entry point for the grid runner. The cell identity is
// written before the jump and survives the load in sessionStorage, so the new
// document can attribute its batches without another IPC round trip.
defineEntryPoint('__placemillGoto', function (url, ctx) {
    if (typeof url !== 'string' || url.length === 0) return false;
    if (!isAllowedMapsUrl(url)) {
        console.error('[Placemill] goto refused a non-Google URL:', url);
        return false;
    }
    setTileContext(ctx || null);
    try {
        location.href = url;
        return true;
    } catch (e) {
        console.error('[Placemill] goto failed:', e);
        return false;
    }
});

// Google keeps the camera in the URL: `.../@34.052200,-118.243700,16z`. Parsing
// it is the only camera source available to an injected script.
function parseMapView() {
    var match = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/.exec(location.href);
    if (!match) return null;
    var lat = parseFloat(match[1]);
    var lng = parseFloat(match[2]);
    var zoom = parseFloat(match[3]);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(zoom)) return null;
    return { lat: lat, lng: lng, zoom: zoom, url: location.href };
}

// Great-circle distance in kilometres. Needed by the drift check below, which
// compares the live camera with the cell centre Rust handed over. Spelled out
// here instead of trusting the page: Google's own helpers are not part of any
// contract and are minified beyond recognition.
function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371.0088;
    var toRad = Math.PI / 180;
    var dPhi = (lat2 - lat1) * toRad;
    var dLambda = (lng2 - lng1) * toRad;
    var a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
        Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// `eval` cannot return a value, so the page pushes its camera instead of
// answering a query. Rust keeps the last report; the grid dialog reads it.
defineEntryPoint('__placemillReportView', function () {
    var view = parseMapView();
    if (view) {
        emitEvent('maps:view', view);
        vlog('[Placemill] maps:view lat=' + view.lat + ' lng=' + view.lng + ' zoom=' + view.zoom);
    }
    return view;
});

// The data request carries the term as `q=`, while a navigation URL carries it
// as `/maps/search/<term>/@lat,lng,zoom`. Accept both, otherwise a batch that
// arrives right after a hard navigation would lose its attribution.
function queryFromUrl(url) {
    if (!url || typeof url !== 'string') return '';
    var match = /[?&]q=([^&#]*)/i.exec(url);
    if (!match) match = /\/maps\/search\/([^/@?]+)/i.exec(url);
    if (!match) return '';
    try {
        return decodeURIComponent(match[1].replace(/\+/g, ' '));
    } catch (e) {
        return match[1];
    }
}

// Emitted per batch so the row can be traced back to the search that produced it.
function batchMeta(url) {
    var query = queryFromUrl(url);
    // A hard navigation produces no response URL we can read; the page URL still
    // names the search, so fall back to it rather than sending an empty value.
    if (!query) query = queryFromUrl(location.href);
    return { sourceQuery: query };
}

// Generic emitter for lifecycle events. `doSend` keeps its own copy: it also
// owns the "only with phone" filter and its log wording is part of the debug
// workflow. If the IPC API ever moves, both paths must be updated together.
function emitEvent(name, payload) {
    var body = payload || {};
    try {
        if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.emit === 'function') {
            var p = window.__TAURI__.event.emit(name, body);
            if (p && typeof p.then === 'function') {
                p.catch(function (e) { console.error('[Placemill] event emit failed:', name, e); });
            }
            return true;
        }
        if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
            var p2 = window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: name, payload: body });
            if (p2 && typeof p2.then === 'function') {
                p2.catch(function (e) { console.error('[Placemill] event emit failed:', name, e); });
            }
            return true;
        }
    } catch (e) {
        console.error('[Placemill] event emit threw:', name, e);
    }
    return false;
}

console.log('[Placemill] ' + VERSION + ' injecting...');
console.log('[Placemill] __TAURI_INTERNALS__ available:', !!window.__TAURI_INTERNALS__);
console.log('[Placemill] __TAURI__ available:', !!window.__TAURI__);

// ============================================================
// 0.0 Field map (M5 / G-05: remote parser hot update)
//
// Every positional index into Google's payload lives in ONE object. A
// validated remote map (pushed by Rust together with the collector settings)
// overrides the built-in one; the localStorage mirror bridges page loads.
// Remote maps are pure data — numeric indices validated against a fixed
// shape — so a hostile config cannot execute anything (D4 boundary).
// ============================================================
var BUILTIN_FIELD_MAP = {
    resultsIndex: 64, name: 11, address: [39], phone: 178, website: 7,
    types: 13, coords: 9, placeId: [78, 10], rating: [4, 7], reviews: [4, 8],
    // M8 / J-08a: fields added from now on. A remote config may leave them
    // out — the built-in value applies then.
    // Both indices were checked against a real search payload by the index
    // probe (J-08b):
    //   timezone   filled in 5/5 sampled rows -> the index is right.
    //   priceRange filled in 0/5 -> either the search payload does not carry
    //             the price level at all, or dentists simply have none. The
    //             evidence cannot tell the two apart, so the mapping stays
    //             (it costs one empty string per row) and the question is
    //             left open for the detail page (Tier-2). A remote config
    //             can move it without a release.
    //
    // `address` and `types` were re-mapped from the same probe run: in the
    // search payload `detail[39]` is the plain address while `detail[18]`
    // carries the same address with the business name glued to the front
    // ("Ojan D Ghalchi Inc, 281 Columbia Ave, ...") — the "商家名," prefix
    // gosom strips — so it is not a usable fallback. The category is a flat
    // string array at `detail[13]` ("Dentist", "Cosmetic dentist", ...)
    // while `detail[76]` is null.
    priceRange: 4, timezone: 30,
    // M8 / J-08c: the fields the index probe confirmed as filled in the
    // search payload (`docs/parser.md`). The value is the
    // *container* index; the deeper path inside it is a constant of the
    // format and lives in the extractor.
    completeAddress: 183, dataId: 10, reviewsLink: 4, thumbnail: 72,
    about: 100, owner: 57, openHours: 203
};
var FIELD_MAP_STORAGE_KEY = 'placemill.fieldMap';
var FIELD_MAP_MAX_INDEX = 2048;
// The nine original keys stay required — their absence means the layout
// really changed and the map must be rejected so the app falls back to the
// built-in one. Every other key in BUILTIN_FIELD_MAP is optional: a config
// published before that field existed stays valid, and the built-in value
// applies. The optional list is *derived* so that adding a field is a
// one-line change in BUILTIN_FIELD_MAP — a hand-kept second list would let a
// new key be silently ignored by every remote config that sets it.
var REQUIRED_FIELD_KEYS = [
    'resultsIndex', 'name', 'address', 'phone', 'website',
    'types', 'coords', 'placeId', 'rating', 'reviews'
];
var OPTIONAL_FIELD_KEYS = Object.keys(BUILTIN_FIELD_MAP).filter(function (key) {
    return REQUIRED_FIELD_KEYS.indexOf(key) === -1;
});

function validIndexList(value, minLength, maxLength) {
    if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) return null;
    var copy = [];
    for (var i = 0; i < value.length; i++) {
        var entry = value[i];
        if (typeof entry !== 'number' || !isFinite(entry) || entry < 0 ||
            entry > FIELD_MAP_MAX_INDEX || Math.floor(entry) !== entry) return null;
        copy.push(entry);
    }
    return copy;
}
function validSingleIndex(value) {
    return (typeof value === 'number' && isFinite(value) && value >= 0 &&
        value <= FIELD_MAP_MAX_INDEX && Math.floor(value) === value) ? value : null;
}
function validFieldMap(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var map = {};
    map.resultsIndex = validSingleIndex(raw.resultsIndex);
    if (map.resultsIndex === null) return null;
    map.name = validSingleIndex(raw.name);
    if (map.name === null) return null;
    map.phone = validSingleIndex(raw.phone);
    if (map.phone === null) return null;
    map.website = validSingleIndex(raw.website);
    if (map.website === null) return null;
    map.types = validSingleIndex(raw.types);
    if (map.types === null) return null;
    map.coords = validSingleIndex(raw.coords);
    if (map.coords === null) return null;
    map.address = validIndexList(raw.address, 1, 2);
    if (!map.address) return null;
    map.placeId = validIndexList(raw.placeId, 1, 2);
    if (!map.placeId) return null;
    map.rating = validIndexList(raw.rating, 2, 2);
    if (!map.rating) return null;
    map.reviews = validIndexList(raw.reviews, 2, 2);
    if (!map.reviews) return null;
    // Optional keys (M8 / J-08a). A missing key (or an explicit null) means
    // "not configured" and leaves the built-in value in place — it never
    // invalidates the map, so publishing a new index cannot break the config
    // that is already in the field. A key that is present but malformed is
    // dropped on its own: one bad new key must not cost us the whole hot
    // update, which is exactly what a strict check would do.
    for (var i = 0; i < OPTIONAL_FIELD_KEYS.length; i++) {
        var key = OPTIONAL_FIELD_KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        var value = raw[key];
        if (value === null || value === undefined) continue;
        var index = validSingleIndex(value);
        if (index === null) {
            warn('[Placemill] field map: optional key ' + key +
                ' is not a valid index, dropped');
            continue;
        }
        map[key] = index;
    }
    return map;
}
function cloneFieldMap(map) {
    return JSON.parse(JSON.stringify(map));
}
// The index actually in force for one key: the remote map's value when it
// has one, the built-in value otherwise. Only the optional keys can fall
// back — the required ones are always present in an accepted map. The rule
// lives here so the parser and the status hook cannot drift apart.
function resolveIndex(map, key) {
    var value = map ? map[key] : undefined;
    return (value === undefined || value === null) ? BUILTIN_FIELD_MAP[key] : value;
}
function mapIndex(key) {
    return resolveIndex(__fieldMapState.map, key);
}
// The full map the parser works with, built-in values included. Exposed
// through the status hook so the fallback is observable from outside.
function effectiveFieldMap() {
    var effective = {};
    var keys = Object.keys(BUILTIN_FIELD_MAP);
    for (var i = 0; i < keys.length; i++) {
        effective[keys[i]] = resolveIndex(__fieldMapState.map, keys[i]);
    }
    return effective;
}

// ============================================================
// 0.1 Index probe (M8 / J-08b)
//
// The candidate paths below are the ones `docs/parser.md`
// lists. The probe reports the shape that actually sits at each of
// them *in this payload*, so choosing an index becomes a reading
// task instead of guesswork — and it is the only way to settle the
// open questions in §2.4 (the "商家名," prefix on the address, the
// `types` vs `category` pair, the `open_hours` double structure, NUL
// bytes).
//
// It only reads. The snapshot never enters the `business-data`
// event, so it cannot pollute the ingress guard's rate window or
// the database. Debug builds only (R-31): the entry point is defined
// alongside the other debug helpers.
// ============================================================
var PROBE_PATHS = [
    // --- 第一批：结构化地址与分类 ---
    { want: 'complete_address', path: [183, 1], note: '[0]=borough [1]=street [3]=city [4]=postal [5]=state [6]=country' },
    { want: 'complete_address_borough', path: [183, 1, 0] },
    { want: 'complete_address_street', path: [183, 1, 1] },
    { want: 'complete_address_city', path: [183, 1, 3] },
    { want: 'complete_address_postal', path: [183, 1, 4] },
    { want: 'complete_address_state', path: [183, 1, 5] },
    { want: 'complete_address_country', path: [183, 1, 6] },
    { want: 'plus_code', path: [183, 2, 2, 0] },
    { want: 'category', path: [13, 0], note: '主类目单值；与 types 76 并排看' },
    { want: 'category_list', path: [13], note: '类目列表容器：搜索载荷是扁平字符串数组' },
    { want: 'price_range', path: [4, 2], note: '与 rating/reviews 同容器' },
    { want: 'reviews_link', path: [4, 3, 0] },
    { want: 'business_status', path: [34, 4, 4] },
    { want: 'business_status_fallback', path: [88, 0] },
    { want: 'timezone', path: [30] },
    { want: 'data_id', path: [10] },
    { want: 'maps_link', path: [27] },
    // --- 第二批：内容型字段 ---
    { want: 'open_hours', path: [203, 0] },
    { want: 'open_hours_weekday', path: [203, 0, 0], note: '项[0]=星期名' },
    { want: 'open_hours_slots', path: [203, 0, 3], note: '项[3]=时段数组，slot[0]="9 AM–5 PM"' },
    { want: 'open_hours_day0_name', path: [203, 0, 0, 0], note: '第 0 项的更深一层：星期名在哪' },
    { want: 'open_hours_day0_slots', path: [203, 0, 0, 3], note: '第 0 项的时段数组' },
    { want: 'open_hours_day0_slot0', path: [203, 0, 0, 3, 0], note: '时段数组第 0 项："9 AM–5 PM"' },
    { want: 'open_hours_legacy', path: [34, 1] },
    { want: 'description', path: [32, 1, 1] },
    { want: 'reviews_per_rating', path: [175, 3] },
    { want: 'reviews_per_rating_1star', path: [175, 3, 0] },
    { want: 'user_reviews', path: [175, 9, 0] },
    { want: 'thumbnail', path: [72, 0, 1, 6, 0] },
    { want: 'images', path: [171, 0] },
    { want: 'images_title', path: [171, 0, 2] },
    { want: 'images_url', path: [171, 0, 3, 0, 6, 0] },
    { want: 'reservations', path: [46] },
    { want: 'reservations_link', path: [46, 0] },
    { want: 'order_online', path: [75, 0, 1, 2] },
    { want: 'menu_link', path: [38, 0] },
    { want: 'owner_name', path: [57, 1] },
    { want: 'about', path: [100, 1] },
    { want: 'about_item0', path: [100, 1, 0], note: 'about 数组第 0 项：payments / credit_cards 从哪取' },
    { want: 'about_item0_0', path: [100, 1, 0, 0], note: 'about 第 0 项的第 0 个元素：标签？' },
    { want: 'about_item0_1', path: [100, 1, 0, 1], note: 'about 第 0 项的第 1 个元素：值？' },
    { want: 'about_item1', path: [100, 1, 1], note: 'about 第 1 项' },
    // --- 第三批：详情页专有 ---
    { want: 'popular_times', path: [84, 0] },
    { want: 'popular_times_weekday', path: [84, 0, 0] },
    { want: 'popular_times_hour', path: [84, 0, 1, 0] },
    { want: 'popular_times_crowd', path: [84, 0, 1, 1] },
    // --- 已在用的基线键（对照用）---
    { want: 'name', path: [11] },
    { want: 'address_fallback', path: [18], note: '疑点：可能带 "商家名," 前缀' },
    { want: 'address_primary', path: [39] },
    { want: 'website', path: [7] },
    { want: 'website_link', path: [7, 0] },
    { want: 'types', path: [76], note: '嵌套数组，与 category 13 对照' },
    { want: 'types_first', path: [76, 0, 0] },
    { want: 'place_id', path: [78] },
    { want: 'phone', path: [178] },
    { want: 'phone_first', path: [178, 0, 0] },
    { want: 'coords', path: [9] },
    { want: 'coords_lat', path: [9, 2] },
    { want: 'coords_lng', path: [9, 3] },
    { want: 'rating', path: [4, 7] },
    { want: 'reviews_total', path: [4, 8] }
];

// A short printable description of one value. `depth` keeps a nested
// array from exploding into the log.
function probeShape(value, depth) {
    depth = depth || 0;
    if (value === undefined) return { kind: 'missing' };
    if (value === null) return { kind: 'null' };
    if (Array.isArray(value)) {
        var arrayShape = { kind: 'array', len: value.length };
        if (depth < 2 && value.length > 0) arrayShape.first = probeShape(value[0], depth + 1);
        return arrayShape;
    }
    if (typeof value === 'object') {
        var objectKeys = Object.keys(value);
        var objectShape = { kind: 'object', keys: objectKeys.length };
        if (depth < 2 && objectKeys.length > 0) {
            objectShape.first = probeShape(value[objectKeys[0]], depth + 1);
        }
        return objectShape;
    }
    if (typeof value === 'string') {
        var stringShape = { kind: 'string', len: value.length, sample: value.slice(0, 48) };
        // §2.4: Google occasionally puts a NUL byte inside a field.
        if (value.indexOf('\u0000') >= 0) stringShape.nul = true;
        return stringShape;
    }
    if (typeof value === 'number') return { kind: 'number', value: value };
    if (typeof value === 'boolean') return { kind: 'boolean', value: value };
    return { kind: typeof value };
}

// Walk one path and describe every level, so the reader sees the
// container as well as the value inside it. A path that runs into a
// hole ends with a 'missing' step — that is the answer too.
function probeWalk(detail, path) {
    var steps = [];
    var current = detail;
    for (var i = 0; i < path.length; i++) {
        var shape = probeShape(current, 0);
        steps.push({
            at: path.slice(0, i),
            kind: shape.kind,
            len: shape.len,
            keys: shape.keys,
            sample: shape.sample,
            first: shape.first,
            nul: shape.nul
        });
        if (current === undefined || current === null) break;
        current = current[path[i]];
    }
    var finalShape = probeShape(current, 0);
    steps.push({
        at: path.slice(),
        kind: finalShape.kind,
        len: finalShape.len,
        keys: finalShape.keys,
        sample: finalShape.sample,
        first: finalShape.first,
        nul: finalShape.nul
    });
    return steps;
}

function probeDetail(rows) {
    var records = [];
    for (var i = 0; i < PROBE_PATHS.length; i++) {
        var candidate = PROBE_PATHS[i];
        var steps = null;
        // Two counts, because they answer different questions:
        //   inRange = the path resolves to an existing slot (not beyond an
        //             array's length) -> is the index plausible at all?
        //   filled  = that slot holds a non-null value -> is the field
        //             actually populated in this payload?
        // `filled > 0` means the index works. `inRange > 0, filled = 0` means
        // the index is plausible but the field is empty here (a detail-only
        // field, or businesses that have no such value). `inRange = 0` means
        // the index is out of range and therefore wrong.
        var inRange = 0;
        var filled = 0;
        var filledSteps = null;
        var anySteps = null;
        for (var r = 0; r < rows.length; r++) {
            var rowSteps = probeWalk(rows[r], candidate.path);
            var last = rowSteps[rowSteps.length - 1];
            if (last.kind !== 'missing') inRange += 1;
            if (last.kind !== 'missing' && last.kind !== 'null') filled += 1;
            // Keep the shape of a row that actually holds a value: showing
            // the shape of an empty slot would hide what the field looks
            // like when it is populated.
            if (last.kind !== 'missing') {
                if (anySteps === null) anySteps = rowSteps;
                if (last.kind !== 'null' && filledSteps === null) filledSteps = rowSteps;
            }
        }
        steps = filledSteps || anySteps || probeWalk(rows[0], candidate.path);
        records.push({
            want: candidate.want,
            path: candidate.path,
            note: candidate.note || '',
            rows: rows.length,
            inRange: inRange,
            filled: filled,
            steps: steps
        });
    }
    return records;
}

var __probeSnapshot = null;
var __probeLastAt = 0;
// Refreshing the snapshot is cheap but not free; one refresh every ten
// seconds is plenty for a layout change to show up.
var PROBE_INTERVAL_MS = 10000;
// How many rows of a batch to sample. One row cannot tell "wrong index"
// apart from "this business has no such value"; a handful can.
var PROBE_ROWS = 5;

function captureProbeSnapshot(rows) {
    var now = Date.now();
    if (now - __probeLastAt < PROBE_INTERVAL_MS) return;
    __probeLastAt = now;
    try {
        __probeSnapshot = { at: now, rows: rows.length, records: probeDetail(rows) };
    } catch (e) {
        // A diagnostic tool must never break collection: if the payload has
        // a shape the probe cannot walk, drop the snapshot and carry on.
        warn('[Placemill] index probe failed:', e && e.message ? e.message : e);
        return;
    }
    // console.debug only — the snapshot must not reach `business-data`.
    if (window.console && console.debug) {
        console.debug('[Placemill] index probe', __probeSnapshot);
    }
}

// Debug-only entry points. Without an argument the probe returns the
// newest snapshot; with a `detail` array it probes that one instead, and
// `rows` probes several of them at once (so the fill rate is meaningful).
function placemillIndexProbe(detail) {
    if (Array.isArray(detail)) {
        try {
            __probeSnapshot = { at: Date.now(), rows: 1, records: probeDetail([detail]) };
        } catch (e) {
            return {
                ready: false,
                error: e && e.message ? e.message : String(e)
            };
        }
    }
    if (!__probeSnapshot) {
        return {
            ready: false,
            hint: 'no batch parsed yet — run a search first, or pass a detail array'
        };
    }
    if (window.console && console.debug) {
        console.debug('[Placemill] index probe', __probeSnapshot);
    }
    return {
        ready: true,
        at: __probeSnapshot.at,
        candidates: PROBE_PATHS.length,
        rows: __probeSnapshot.rows,
        records: __probeSnapshot.records
    };
}

function placemillIndexProbeRows(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return { ready: false, error: 'expected a non-empty array of detail arrays' };
    }
    try {
        __probeSnapshot = { at: Date.now(), rows: rows.length, records: probeDetail(rows) };
    } catch (e) {
        return { ready: false, error: e && e.message ? e.message : String(e) };
    }
    if (window.console && console.debug) {
        console.debug('[Placemill] index probe', __probeSnapshot);
    }
    return {
        ready: true,
        at: __probeSnapshot.at,
        candidates: PROBE_PATHS.length,
        rows: __probeSnapshot.rows,
        records: __probeSnapshot.records
    };
}
function loadFieldMapState() {
    var state = { map: cloneFieldMap(BUILTIN_FIELD_MAP), version: '', source: 'builtin' };
    try {
        var raw = localStorage.getItem(FIELD_MAP_STORAGE_KEY);
        if (raw) {
            var parsed = JSON.parse(raw);
            var candidate = validFieldMap(parsed && parsed.map);
            if (candidate) {
                state.map = candidate;
                state.version = typeof parsed.version === 'string' ? parsed.version : '';
                state.source = state.version ? 'remote-mirror:' + state.version : 'remote-mirror';
            }
        }
    } catch (e) {
        /* broken mirror -> built-in; Rust pushes the real one after load */
    }
    return state;
}
var __fieldMapState = loadFieldMapState();
var __degradedBatches = 0;
// R-10: set when the degraded state was announced to the panel, so recovery
// can be announced exactly once too — the health channel is state-based, and
// announcing every good batch would drown the log.
var __degradedAnnounced = false;

// Called from `__placemillApplySettings` when the payload carries a field map.
function applyFieldMap(rawMap, version) {
    var candidate = validFieldMap(rawMap);
    if (!candidate) {
        warn('[Placemill] field map rejected (invalid shape)');
        return false;
    }
    __fieldMapState = {
        map: candidate,
        version: typeof version === 'string' ? version : '',
        source: (typeof version === 'string' && version) ? 'remote:' + version : 'remote'
    };
    __degradedBatches = 0;
    try {
        localStorage.setItem(FIELD_MAP_STORAGE_KEY,
            JSON.stringify({ map: __fieldMapState.map, version: __fieldMapState.version }));
    } catch (e) { /* storage unavailable; in-memory copy still active */ }
    log('[Placemill] field map applied: ' + __fieldMapState.source +
        ' (name=' + __fieldMapState.map.name + ')');
    return true;
}
// Three consecutive empty parses of a real search body mean the active remote
// map no longer matches the response (J-05d). Reset to built-in and tell Rust,
// which drops its copy, clears the cache and refetches.
function resetFieldMapToBuiltin(reason) {
    if (__fieldMapState.source === 'builtin') return false;
    __fieldMapState = { map: cloneFieldMap(BUILTIN_FIELD_MAP), version: '', source: 'builtin' };
    __degradedBatches = 0;
    try {
        localStorage.removeItem(FIELD_MAP_STORAGE_KEY);
    } catch (e) { /* ignore */ }
    warn('[Placemill] field map reset to built-in (' + reason + ')');
    return true;
}
function noteParsedBatch(count, bodyLength, url, via) {
    if (count > 0) {
        if (__degradedAnnounced) {
            // R-10: parsing works again — clear the panel's red alert.
            __degradedAnnounced = false;
            emitEvent('maps:health', { state: 'ok', at: Date.now() });
        }
        __degradedBatches = 0;
        return;
    }
    if (!isTargetUrl(url) || bodyLength < 500) return;  // not a real search body
    __degradedBatches += 1;
    warn('[Placemill] empty parse streak ' + __degradedBatches + '/3 (map ' + __fieldMapState.source + ')');
    if (__degradedBatches !== 3) return;
    // R-10: three real search bodies in a row with zero parses — the active
    // map (remote or built-in) no longer matches the response. This used to be
    // silent for the built-in map, which is exactly the "scrolling forever,
    // zero rows" failure mode. Announce it on the health channel so the panel
    // shows the degraded alert, and on the degradation channel so Rust drops
    // its remote map copy and refetches a corrected one (throttled there).
    __degradedAnnounced = true;
    emitEvent('maps:health', { state: 'parse-degraded', at: Date.now() });
    if (resetFieldMapToBuiltin('three empty parses')) {
        emitEvent('collector:parse-degraded', { version: '', via: via });
    } else {
        emitEvent('collector:parse-degraded', {
            version: __fieldMapState.version,
            via: via,
            builtin: true
        });
    }
}
defineEntryPoint('__placemillFieldMapStatus', function () {
    return {
        source: __fieldMapState.source,
        version: __fieldMapState.version,
        degradedBatches: __degradedBatches,
        map: cloneFieldMap(__fieldMapState.map),
        // M8 / J-08a: the indices the parser really uses. An optional key the
        // remote config did not set resolves to the built-in value, so this
        // is the map in force, while `map` is what the config actually said.
        effective: effectiveFieldMap()
    };
});
// R-10: test/diagnostic hook, same spirit as `__placemillDiag` / `__placemillTest`.
// The e2e suite drives the degraded → alert → recovery path with it instead of
// waiting for a real Google format change. Read-only binding (R-31), but callable
// in release builds too: it only feeds the parser's own counters.
defineEntryPoint('__placemillNoteParsedBatch', noteParsedBatch);

    // ============================================================
    // 0. Settings + log gate
    //
    // MUST stay at the top, before every other section: `autoScroll` and
    // `doSend` read `window.__placemillSettings` while this IIFE initialises, so
    // assigning it later would leave them on `undefined`.
    // ============================================================
    function readSettings() {
        var defaults = {
            scrollMinMs: 1000, scrollMaxMs: 3000, maxScrolls: 80,
            stopAfterIdle: 4, jitter: true, onlyWithPhone: false, logLevel: 'normal'
        };
        try {
            var raw = localStorage.getItem('placemill.settings');
            if (!raw) return defaults;
            var parsed = JSON.parse(raw);
            for (var key in defaults) {
                if (!(key in parsed)) parsed[key] = defaults[key];
            }
            return parsed;
        } catch (e) {
            return defaults;
        }
    }

    // Rust mirrors the collector settings here on every load (see on_page_load),
    // so a full navigation keeps them even though the JS context is new.
    window.__placemillSettings = readSettings();

    // Log gate: "silent" keeps errors only, "verbose" re-enables the per-request
    // trace. Declared here so the network hooks below can use them.
    var LOG_LEVEL = window.__placemillSettings.logLevel || 'normal';
    function setLogLevel(level) { LOG_LEVEL = level || 'normal'; }
    function log() { if (LOG_LEVEL !== 'silent') console.log.apply(console, arguments); }
    function warn() { if (LOG_LEVEL !== 'silent') console.warn.apply(console, arguments); }
    function vlog() { if (LOG_LEVEL === 'verbose') console.log.apply(console, arguments); }

    log('[Placemill] settings loaded: logLevel=' + LOG_LEVEL + ' ' + JSON.stringify(window.__placemillSettings));

    // ============================================================
    // 0. Diagnostics
    // ============================================================
    var placemillDiag = function () {
        console.log('[Placemill] ===== DIAGNOSTICS =====');
        console.log('[Placemill] Version:', VERSION);
        console.log('[Placemill] __TAURI_INTERNALS__:', window.__TAURI_INTERNALS__);
        console.log('[Placemill] __TAURI__:', window.__TAURI__);
        if (window.__TAURI__) {
            console.log('[Placemill] __TAURI__.event:', window.__TAURI__.event);
            console.log('[Placemill] __TAURI__.event.emit:', typeof window.__TAURI__.event.emit);
        }
        console.log('[Placemill] Counters:', JSON.stringify(counters));
        console.log('[Placemill] Pending queue:', PENDING.length);
        console.log('[Placemill] Settings:', JSON.stringify(window.__placemillSettings));
        console.log('[Placemill] Field map:', JSON.stringify(
            window.__placemillFieldMapStatus ? window.__placemillFieldMapStatus() : 'n/a'));
        console.log('[Placemill] Log level:', LOG_LEVEL);
        console.log('[Placemill] ===== END DIAGNOSTICS =====');

        if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) {
            window.__TAURI__.event.emit('business-data', {
                businesses: [{
                    name: 'DIAG_TEST',
                    address: 'Test Address',
                    phone: '1234567890',
                    rating: 5.0,
                    reviews_total: 100,
                    lat: 37.7749,
                    lng: -122.4194,
                    place_id: 'DIAG_' + Date.now(),
                    website: '',
                    types: ['test']
                }]
            }).then(function () { console.log('[Placemill] IPC diag emit OK'); })
              .catch(function (e) { console.error('[Placemill] IPC diag emit FAIL:', e); });
        } else if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
            window.__TAURI_INTERNALS__.invoke('ping', { msg: 'test from maps webview' })
                .then(function (r) { console.log('[Placemill] IPC ping OK:', r); })
                .catch(function (e) { console.error('[Placemill] IPC ping FAIL:', e); });
        } else {
            console.error('[Placemill] No IPC method available!');
        }
    };

    var placemillTest = function () {
        var testData = [{ name: 'TEST_BUSINESS', address: 'Test Address', phone: '1234567890', rating: 5.0, reviews_total: 100, lat: 37.7749, lng: -122.4194, place_id: 'TEST_' + Date.now(), website: '', types: ['test'] }];
        console.log('[Placemill] Sending test data:', testData);
        doSend(testData);
    };

    // R-31: both helpers write rows into SQLite and probe IPC, so a release
    // build does not expose them at all — a page script must not be able to
    // fabricate data. Debug builds keep them for the developer console.
    if (DEBUG_BUILD) {
        defineEntryPoint('__placemillDiag', placemillDiag);
        defineEntryPoint('__placemillTest', placemillTest);
        // M8 / J-08b: the index probe only reads the payload and answers
        // with shapes, so it is safe to expose — but it is a development
        // tool, hence the debug-only gate.
        defineEntryPoint('__placemillIndexProbe', placemillIndexProbe);
        defineEntryPoint('__placemillIndexProbeRows', placemillIndexProbeRows);
        // M9 / J-09a: parse a captured reviews answer. The parser is pure,
        // so the e2e pins it with a real captured fixture.
        defineEntryPoint('__placemillParseReviews', function (text) {
            try {
                return parseReviewsPayload(typeof text === 'string' ? text : String(text || ''));
            } catch (e) {
                return {
                    reviews: [],
                    nextToken: null,
                    error: String(e && e.message ? e.message : e),
                };
            }
        });
        // Tier-2: parse a captured place-detail payload text (debug-only, for
        // the fixture e2e — the production entry reads the live state). The
        // fixtures store jd[6] (the detail array) directly; a full jd works
        // too.
        defineEntryPoint('__placemillParsePlacePayload', function (text) {
            try {
                var parsed = JSON.parse(sanitizeJsonText(
                    String(text || '').replace(/^\)\]\}'\n?/, ''),
                ));
                var jd =
                    Array.isArray(parsed) && Array.isArray(parsed[6]) && typeof parsed[6][11] === 'string'
                        ? parsed
                        : [null, null, null, null, null, null, parsed];
                return parsePlaceStatePayload(jd);
            } catch (e) {
                return {
                    ok: false,
                    error: String(e && e.message ? e.message : e),
                    name: '',
                    placeId: '',
                    dataId: '',
                    plusCode: '',
                    description: '',
                    reviewsPerRating: [],
                    photos: [],
                };
            }
        });
        // M9 / J-09a: parse the reviews_link payload (one featured review).
        defineEntryPoint('__placemillParseReviewsLink', function (text) {
            try {
                return parseReviewsLinkPayload(typeof text === 'string' ? text : String(text || ''));
            } catch (e) {
                return {
                    reviews: [],
                    nextToken: null,
                    error: String(e && e.message ? e.message : e),
                };
            }
        });
        // M9 / J-09a: what the page's own traffic taught us about its session.
        defineEntryPoint('__placemillReviewsSession', function () {
            return {
                token: __reviewsSession.token,
                bgkey: __reviewsSession.bgkey,
                tokenAt: __reviewsSession.tokenAt,
                bgkeyAt: __reviewsSession.bgkeyAt,
                seen: __reviewsSession.seen,
                shapes: __reviewsSession.shapes,
                lastBatchBody: __reviewsSession.lastBatchBody,
                lastQv9Response: __reviewsSession.lastQv9Response,
                lastQv9FullLen: (__reviewsSession.lastQv9Full || '').length,
                qv9Calls: __reviewsSession.qv9Calls,
                messages: __reviewsSession.messages,
            };
        });
        // M9 / J-09a: build a reviews request for a place, using the session
        // we learned from the page. `overrides` (token/bgkey) exists for the
        // e2e to tell a stale capture from a wrong request shape.
        defineEntryPoint('__placemillBuildReviewsRequest', function (placeId, overrides) {
            try {
                var over = overrides && typeof overrides === 'object' ? overrides : {};
                // No `reviewsTokenFromState()` fallback here: the page state
                // holds many token-shaped strings (a ChIJ place id matches the
                // same regex) and a wrong pick lands in the TOKEN slot of the
                // request body — measured to produce an empty answer.
                var token = over.token || __reviewsSession.token;
                var bgkey = over.bgkey || __reviewsSession.bgkey;
                var request = buildReviewsRequest(String(placeId || ''), token, null, bgkey);
                return {
                    ok: Boolean(request.body && request.url),
                    url: request.url,
                    body: request.body,
                    headers: request.headers,
                    hasToken: Boolean(token),
                    hasBgkey: Boolean(bgkey),
                };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        });
        // M8 / J-08f: parse a payload the caller hands over, so the e2e can
        // prove that a response carrying a raw control byte still yields
        // rows. It only reads the string it is given and writes nothing.
        defineEntryPoint('__placemillParse', function (text) {
            try {
                var rows = parseBusiness(typeof text === 'string' ? text : String(text || ''));
                return { ok: true, count: rows.length, rows: rows };
            } catch (e) {
                return { ok: false, error: String(e && e.message ? e.message : e) };
            }
        });
    }

    // R-31 boundary: the two entry points below are PRODUCTION, not debug
    // helpers. Rust evals them in every build — `fetch_reviews` calls
    // `__placemillFetchReviews` and the Tier-2 runner calls
    // `__placemillParsePlaceState` — so gating them on DEBUG_BUILD made
    // reviews and enrichment fail in release builds while working under
    // `tauri dev`. Only the developer console helpers stay behind the gate.

    // M9 / J-09a: the reviews fetch, three sources in one call. Preferred:
    // the bootstrap state — Google server-renders the place's reviews-link
    // payload into APP_INITIALIZATION_STATE, so the featured review is
    // already in the page and needs no fetch at all (a direct fetch of
    // search.google.com is CORS-blocked). Then the direct GET ladder (kept
    // for when the endpoint gains CORS or another origin serves it). Last:
    // the qv9Egd rpc with the captured session, which serves the full list
    // when the endpoint answers (it currently returns an empty frame to
    // everyone; the fallback must report that, not crash).
    defineEntryPoint('__placemillFetchReviews', function (placeId, reviewsLink, options) {
        var opts = options && typeof options === 'object' ? options : {};

        // Source A: the server-rendered cache. Returns whatever reviews
        // the state holds (any place); the caller matches by place_id.
        var readStateCache = function () {
            var out = [];
            try {
                var state = window.APP_INITIALIZATION_STATE;
                var bucket = state && state[3] ? state[3].Dg : null;
                if (bucket) {
                    var scan = function (node, depth) {
                        if (depth > 8 || out.length > 20) return;
                        if (typeof node === 'string') {
                            if (node.slice(0, 4) === ")]}'") {
                                var parsed = parseReviewsLinkPayload(node);
                                for (var i = 0; i < parsed.reviews.length; i++) out.push(parsed.reviews[i]);
                            }
                            return;
                        }
                        if (Array.isArray(node)) {
                            node.forEach(function (v) { scan(v, depth + 1); });
                            return;
                        }
                        if (node && typeof node === 'object') {
                            for (var k in node) scan(node[k], depth + 1);
                        }
                    };
                    scan(bucket, 0);
                }
            } catch (e) {
                /* the state is the page's own; never let it break us */
            }
            return out;
        };

        var viaQv9 = function () {
            var token = opts.token || __reviewsSession.token;
            var bgkey = opts.bgkey || __reviewsSession.bgkey;
            if (!token || !bgkey) {
                return Promise.resolve({
                    channel: 'qv9Egd',
                    reviews: [],
                    nextToken: null,
                    error: 'no session (token=' + Boolean(token) + ', bgkey=' + Boolean(bgkey) + ')',
                });
            }
            // The rpc body carries the HEX place id (the `data_id` form),
            // not the ChIJ one — the page's own request puts the hex in
            // both the place slot and nothing else; a ChIJ here answers an
            // empty frame (measured against a live 25 KB answer).
            var hexId = String(opts.dataId || placeId || '');
            var request = null;
            try {
                request = buildReviewsRequest(hexId, token, null, bgkey);
            } catch (e) {
                return Promise.resolve({
                    channel: 'qv9Egd',
                    reviews: [],
                    nextToken: null,
                    error: 'build: ' + String(e && e.message ? e.message : e),
                });
            }
            // window.fetch here is our own hook; batchexecute is not a
            // target url, so it passes through untouched.
            return window.fetch(request.url, {
                method: 'POST',
                credentials: 'include',
                headers: request.headers,
                body: request.body,
            }).then(function (response) {
                return response.text().then(function (text) {
                    var parsed = parseReviewsPayload(text);
                    return {
                        channel: 'qv9Egd',
                        status: response.status,
                        reviews: parsed.reviews,
                        nextToken: parsed.nextToken,
                        error: parsed.error,
                    };
                });
            }, function (e) {
                return {
                    channel: 'qv9Egd',
                    reviews: [],
                    nextToken: null,
                    error: 'fetch: ' + String(e && e.message ? e.message : e),
                };
            });
        };

        // Source 0 (preferred): the page's OWN qv9Egd answer. Opening the
        // reviews tab makes the page fetch the full list; the clone hook
        // captured it. Parsing that needs no request of our own — a direct
        // replay of the same shape still answers an empty frame (measured).
        // The capture belongs to the place the tab was opened on; the
        // command tells us which place it navigated to (the hex tail
        // matches the payload's `0x0:0x…` place form).
        var captured = null;
        try {
            if (__reviewsSession.lastQv9Full) {
                captured = parseReviewsPayload(__reviewsSession.lastQv9Full);
            }
        } catch (eCaptured) {
            captured = null;
        }
        var matchesPlace = function (reviews) {
            var dataId = String(opts.dataId || '');
            var tail = dataId.indexOf(':') !== -1 ? dataId.split(':').pop() : dataId;
            if (!tail) return true;
            return reviews.some(function (r) {
                return String(r.place_id || '').indexOf(tail) !== -1;
            });
        };
        if (captured && captured.reviews.length && matchesPlace(captured.reviews)) {
            return Promise.resolve({
                channel: 'qv9Egd_captured',
                reviews: captured.reviews,
                nextToken: captured.nextToken,
                error: null,
            });
        }

        var cachedReviews = readStateCache();
        if (cachedReviews.length) {
            return Promise.resolve({
                channel: 'state_cache',
                reviews: cachedReviews,
                nextToken: null,
                error: null,
            });
        }

        if (typeof reviewsLink === 'string' && reviewsLink.indexOf('http') === 0) {
            // The endpoint lives on search.google.com while the page runs
            // on www.google.com — cross-origin. Credentialed requests
            // require an exact ACAO match, so try omitting credentials
            // first, then the same-origin www variant, then give up to
            // the rpc channel.
            var attempts = [
                { url: reviewsLink, credentials: 'omit' },
                { url: reviewsLink.replace('//search.google.com/', '//www.google.com/'), credentials: 'omit' },
            ];
            var notes = [];
            var tryLink = function (index) {
                if (index >= attempts.length) {
                    return viaQv9().then(function (result) {
                        result.linkNote = notes.join(' | ') || 'no attempt';
                        return result;
                    });
                }
                var attempt = attempts[index];
                return window.fetch(attempt.url, { credentials: attempt.credentials }).then(function (response) {
                    return response.text().then(function (text) {
                        var parsed = parseReviewsLinkPayload(text);
                        if (parsed.reviews.length) {
                            return {
                                channel: 'reviews_link',
                                status: response.status,
                                reviews: parsed.reviews,
                                nextToken: parsed.nextToken,
                                error: null,
                                linkNote: notes.join(' | ') || 'first attempt',
                            };
                        }
                        notes.push('attempt' + index + ': status=' + response.status + ' bytes=' + text.length +
                            (parsed.error ? ' parse=' + parsed.error : ''));
                        return tryLink(index + 1);
                    });
                }, function (e) {
                    notes.push('attempt' + index + ': ' + String(e && e.message ? e.message : e));
                    return tryLink(index + 1);
                });
            };
            return tryLink(0);
        }
        return viaQv9();
    });

    // Tier-2: the enrichment runner's one eval — read the current place
    // payload out of the bootstrap state (see placemillParsePlaceState).
    // Production path, like __placemillFetchReviews: a pure read of the
    // page's own state, no writes.
    defineEntryPoint('__placemillParsePlaceState', function () {
        return placemillParsePlaceState();
    });

    // ============================================================
    // 1. fetch interception (Object.defineProperty keeps it from being overwritten by Google Maps)
    // ============================================================
    (function () {
        // Keep a reference to the native fetch
        var __realFetch = window.fetch;
        var __ourFetch = null;

        function makeInterceptor(currentRealFetch) {
            return function () {
                var args = arguments;
                var url = '';
                if (typeof args[0] === 'string') {
                    url = args[0];
                } else if (args[0] && args[0].url) {
                    url = args[0].url;
                }

                counters.fetch++;
                if (isTargetUrl(url)) {
                    vlog('[Placemill] fetch #' + counters.fetch + ' URL:', url.substring(0, 250));
                }

                // M9: learn the page's session (token + x-maps-bgkey) from the
                // page's own calls. This has to happen for every request, not
                // just the ones we parse — the reviews request is ours, but
                // the credentials are the page's.
                try {
                    var _init = args[1];
                    // Both places can hold the header: a Request object and the
                    // init can each carry it. An empty Headers object is still
                    // truthy, so they must be read separately — reading one
                    // and falling back with `||` would silently skip the other.
                    var _bgkey = reviewsBgkeyFromHeaders(args[0] && args[0].headers)
                        || reviewsBgkeyFromHeaders(_init && _init.headers);
                    var _reqBody = _init ? reviewsBodyText(_init.body) : '';
                    rememberReviewsSession({
                        bgkey: _bgkey,
                        token: reviewsTokenFromBody(_reqBody, url),
                    });
                    rememberRequestShape({
                        via: 'fetch',
                        url: String(url).slice(0, 120),
                        arg0: args[0] && args[0].constructor ? args[0].constructor.name : typeof args[0],
                        initKeys: _init ? Object.keys(_init).join(',') : '',
                        headerNames: reviewsHeaderNames(args[0] && args[0].headers, _init && _init.headers),
                        bodyLen: _reqBody.length,
                    });
                    // When the page passes a Request object, the body lives in
                    // it, not in the init. Reading it costs a clone.
                    var _req = args[0];
                    if (_req && typeof _req.clone === 'function') {
                        try {
                            _req.clone().text().then(
                                function (text) {
                                    rememberReviewsSession({
                                        token: reviewsTokenFromBody(text, url),
                                    });
                                    rememberBatchBody(text, url);
                                },
                                function () {
                                    /* unreadable body */
                                },
                            );
                        } catch (e) {
                            /* ignore */
                        }
                    }
                } catch (e) {
                    /* ignore */
                }

                return currentRealFetch.apply(this, args).then(function (response) {
                    // M9: keep the page's own reviews answer — the FULL text.
                    // When the user opens the reviews tab, the page itself
                    // fetches the list; parsing this capture needs no request
                    // of our own (the direct replay of the same shape still
                    // answers an empty frame — measured). The head stays for
                    // the diagnostics; the full body feeds the parser.
                    if (url.indexOf('qv9Egd') !== -1) {
                        try {
                            response.clone().text().then(function (text) {
                                var full = String(text);
                                __reviewsSession.lastQv9Response = full.slice(0, 4000);
                                __reviewsSession.lastQv9Full = full.slice(0, 300_000);
                            }, function () { /* ignore */ });
                        } catch (e) {
                            /* ignore */
                        }
                    }

                    // R-08: a non-target URL is returned untouched — no clone,
                    // no body read, no parse. The old code cloned and parsed
                    // every text-ish response on the page because the
                    // content-type gate passed almost everything; the URL test
                    // is the real gate and now runs first.
                    if (!isTargetUrl(url)) {
                        return response;
                    }

                    var contentType = response.headers.get('content-type') || '';
                    vlog('[Placemill] fetch #' + counters.fetch + ' content-type:', contentType, '| status:', response.status);

                    // R-08: collecting off means parsing off. The switch used
                    // to be checked only in doSend, so a disabled collector
                    // still burned CPU on every response.
                    if (!window.__placemillEnabled) {
                        counters.skipped++;
                        return response;
                    }

                    if (contentType.indexOf('text/') === -1 &&
                        contentType.indexOf('javascript') === -1 &&
                        contentType.indexOf('json') === -1 &&
                        contentType !== '') {
                        counters.skipped++;
                        warn('[Placemill] fetch #' + counters.fetch + ' SKIPPED by content-type:', contentType);
                        return response;
                    }

                    counters.matched++;
                    try {
                        var cloned = response.clone();
                        cloned.text().then(function (text) {
                            // R-10: any target response feeds the health probe,
                            // whatever it contained.
                            lastMapResponseAt = Date.now();
                            if (text.length > MAX_BODY_BYTES) {
                                counters.skipped++;
                                warn('[Placemill] fetch #' + counters.fetch + ' body too large to parse:', text.length);
                                return;
                            }
                            if (text.length < 500) {
                                warn('[Placemill] fetch #' + counters.fetch + ' body too short:', text.length);
                                return;
                            }
                            var parsed = parseBusiness(text);
                            noteParsedBatch(parsed.length, text.length, url, 'fetch');
                            if (parsed.length > 0) {
                                log('[Placemill] ★ fetch #' + counters.fetch + ' parsed ' + parsed.length + ' businesses');
                                counters.parsed += parsed.length;
                                flushData(parsed, batchMeta(url));
                            } else {
                                warn('[Placemill] fetch #' + counters.fetch + ' parseBusiness returned 0');
                            }
                        }).catch(function (e) {
                            console.error('[Placemill] fetch #' + counters.fetch + ' clone/parse error:', e.message || e);
                        });
                    } catch (e) {
                        console.error('[Placemill] fetch clone error:', e.message || e);
                    }

                    return response;
                }).catch(function (e) {
                    console.error('[Placemill] fetch network error:', e.message || e);
                    throw e;
                });
            };
        }

        __ourFetch = makeInterceptor(__realFetch);

        // Lock window.fetch with Object.defineProperty:
        // - the getter always returns our interceptor
        // - the setter captures the fetch installed by Google Maps as the new realFetch
        Object.defineProperty(window, 'fetch', {
            get: function () { return __ourFetch; },
            set: function (newVal) {
                // R-12: a page that saves and restores window.fetch
                // (`fetch = fetch`, the polyfill dance) must not make us wrap
                // our own interceptor — that stacked one clone+parse layer per
                // round trip, growing with every save/restore cycle.
                if (newVal === __ourFetch) {
                    return;
                }
                log('[Placemill] fetch overwritten by page, updating realFetch');
                __realFetch = newVal;
                __ourFetch = makeInterceptor(__realFetch);
            },
            configurable: false,
            enumerable: true
        });
    })();

    // ============================================================
    // 2. XHR interception (no URL filter, tries to parse every response)
    // ============================================================
    window.__placemillOriginalOpen = XMLHttpRequest.prototype.open;
    window.__placemillOriginalSend = XMLHttpRequest.prototype.send;
    window.__placemillOriginalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    // M9: the page sets x-maps-bgkey through setRequestHeader, so that is
    // where we read it from. We only look at the one header we care about.
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
            if (String(name).toLowerCase() === 'x-maps-bgkey') {
                rememberReviewsSession({ bgkey: String(value || '') });
            }
        } catch (e) {
            /* ignore */
        }
        return window.__placemillOriginalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.open = function (method, url) {
        var xhrId = ++counters.xhr;
        this.__placemillUrl = url;
        this.__placemillMethod = method;
        this.__placemillId = xhrId;
        if (isTargetUrl(url)) {
            vlog('[Placemill] XHR open #' + xhrId + ':', method, url.substring(0, 200));
        }
        return window.__placemillOriginalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
        var self = this;
        var _xhrId = self.__placemillId || 0;
        var _xhrUrl = self.__placemillUrl || '';
        var _isTarget = isTargetUrl(_xhrUrl);

        // M9: the session token travels in the request body of the page's
        // own batchexecute calls.
        try {
            rememberReviewsSession({
                token: reviewsTokenFromBody(typeof body === 'string' ? body : '', _xhrUrl),
            });
            rememberRequestShape({
                via: 'xhr',
                url: String(_xhrUrl).slice(0, 120),
                method: String(self.__placemillMethod || ''),
                bodyLen: typeof body === 'string' ? body.length : 0,
            });
        } catch (e) {
            /* ignore */
        }

        // R-09: wrap `onreadystatechange` on every send — not once per object.
        //
        // Two findings from 2026-10-24 (both measured, not theorised):
        // 1. A listener registered through `addEventListener` on the page's
        //    XHRs holds every pagination request at LOADING (readyState 3)
        //    forever in this WebView2 — the result list never completes and a
        //    dense search collects 20 rows instead of 120. The property
        //    wrapper keeps the page's own flow intact, so it stays.
        // 2. A once-per-object hook (`__placemillHooked`) loses every request
        //    after the first on a reused object: the page resets
        //    `onreadystatechange` between requests, and the guard then blocks
        //    the re-wrap — the hook is silently gone (59 rows instead of 120).
        //    So the wrap happens per send, and each wrapper serves exactly one
        //    response (`_mine`), which also keeps the chained wrappers of a
        //    reused object from parsing the same response twice.
        if (_isTarget) {
            vlog('[Placemill] XHR send #' + _xhrId + ' | responseType:', self.responseType, '| readyState:', self.readyState);

            var _origHandler = self.onreadystatechange;
            var _mine = true;
            self.onreadystatechange = function () {
                var newState = self.readyState;
                if (newState === 4 && _mine) {
                    _mine = false;
                    // R-09: our whole hook is wrapped — the page must keep
                    // working even when this hook fails.
                    try {
                        // R-10: the XHR path is where search data actually
                        // arrives, so it — not only fetch — feeds the health
                        // probe. The old code left `lastMapResponseAt`
                        // untouched here, which made the no-results probe
                        // unreachable from this path.
                        lastMapResponseAt = Date.now();

                        // R-08: collecting off means parsing off.
                        if (!window.__placemillEnabled) return;

                        // R-09: `responseText` throws InvalidStateError unless
                        // responseType is '' or 'text' — the old code read it
                        // unconditionally. 'json' already holds a parsed object;
                        // binary types have nothing for this parser.
                        var responseType = self.responseType;
                        var text = '';
                        if (responseType === '' || responseType === 'text') {
                            text = self.responseText || '';
                        } else if (responseType === 'json' && self.response) {
                            try {
                                text = JSON.stringify(self.response);
                            } catch (stringifyError) {
                                return;
                            }
                        } else {
                            return;
                        }

                        vlog('[Placemill] XHR DONE #' + _xhrId + ' | status:', self.status, '| len:', text.length);

                        // R-08: the size cap applies to XHR too.
                        if (text.length > MAX_BODY_BYTES) {
                            counters.skipped++;
                            warn('[Placemill] XHR #' + _xhrId + ' body too large to parse:', text.length);
                            return;
                        }
                        if (text.length < 500) return;

                        counters.matched++;
                        var parsed = parseBusiness(text);
                        noteParsedBatch(parsed.length, text.length, _xhrUrl, 'xhr');
                        if (parsed.length > 0) {
                            log('[Placemill] ★ XHR parsed ' + parsed.length + ' businesses');
                            counters.parsed += parsed.length;
                            flushData(parsed, batchMeta(_xhrUrl));
                        } else {
                            warn('[Placemill] XHR #' + _xhrId + ' parseBusiness returned 0');
                        }
                    } catch (e) {
                        console.error('[Placemill] XHR hook error:', e.message || e);
                    }
                }
                // The page's callback runs after our hook, outside its
                // try/catch: whatever our parse did (or threw), the page sees
                // the event exactly as it would without us.
                if (_origHandler) {
                    _origHandler.call(self);
                }
            };
        }

        // R-11: the per-XHR 200 ms polling interval and its 30 s sweeper are
        // gone. They only logged readyState changes — no parsing, no data —
        // and an aborted request kept its interval alive for the full 30 s.

        return window.__placemillOriginalSend.apply(this, arguments);
    };

    // M8 / J-08f: strip the raw control bytes before parsing.
    //
    // Google occasionally puts a raw control byte (a NUL in particular)
    // inside a field. A raw control character is invalid inside a JSON
    // string, so `JSON.parse` throws and the *whole* response is lost: one
    // byte, and the batch is gone — exactly the "scrolling forever, zero
    // rows" failure the R-10 card is about. gosom hit the same and wrote
    // `internal/jsonbsanitize` for it.
    //
    // The bytes are removed before parsing. The value they sat in could not
    // be parsed anyway, so nothing reachable is lost — and a lost batch is
    // much worse than a lost byte. The escaped form (`\u0000`) survives
    // `JSON.parse` as a real NUL inside the value; those are cleaned on the
    // Rust side, where the rows are stored.
    function sanitizeJsonText(text) {
        if (typeof text !== 'string') return '';
        // Fast path: almost no response carries a control byte, and this
        // runs on every response.
        if (!/[\u0000-\u001f]/.test(text)) return text;
        var cleaned = text.replace(/[\u0000-\u001f]/g, '');
        warn('[Placemill] stripped ' + (text.length - cleaned.length) +
            ' control byte(s) out of a response');
        return cleaned;
    }

    // ============================================================
    // 3. Data parsing
    // Three formats are supported:
    //   - Raw format: )]}'\n[["search",...],...] (what Google Maps actually returns)
    //   - Wrapper format: {"c":0,"d":"escaped_json","e":"...","p":true,"u":"..."}
    //   - Legacy regex format: last resort fallback
    // ============================================================

    function parseBusiness(text) {
        var results = [];
        if (!text || typeof text !== 'string') {
            warn('[Placemill] parseBusiness: text is empty or not string');
            return results;
        }

        // M8 / J-08f: one raw control byte anywhere in the body would make
        // the whole response unparseable.
        text = sanitizeJsonText(text);

        var firstChar = text.charAt(0);
        vlog('[Placemill] parseBusiness: first char =', JSON.stringify(firstChar), 'len =', text.length);

        if (firstChar === '{') {
            vlog('[Placemill] trying WRAPPER format');
            results = parseWrapperFormat(text);
            if (results.length === 0) {
                vlog('[Placemill] wrapper produced 0, trying RAW fallback');
                results = parseRawFormat(text);
            }
        } else if (firstChar === ')') {
            vlog('[Placemill] trying RAW format');
            results = parseRawFormat(text);
        } else {
            vlog('[Placemill] trying REGEX fallback');
            results = parseV1Regex(text);
        }

        vlog('[Placemill] parseBusiness: total', results.length, 'businesses');
        return results;
    }

    // ---------- Raw format: )]}'\n[["search",...],...] ----------
    function parseRawFormat(text) {
        var results = [];
        try {
            var jsonText = text.replace(/^\)\]\}'\n?/, '');
            vlog('[Placemill] parseRaw: stripped, first 100:', jsonText.substring(0, 100));
            var data = JSON.parse(jsonText);
            vlog('[Placemill] parseRaw: data len =', data.length);
            results = extractBusinesses(data);
        } catch (e) {
            console.error('[Placemill] parseRaw error:', e.message || e);
        }
        return results;
    }

    // ---------- Wrapper format: {"c":0,"d":"escaped_json","e":"...","p":true,"u":"..."} ----------
    function parseWrapperFormat(text) {
        var results = [];
        try {
            // Diagnostics: log the tail of the response
            vlog('[Placemill] parseWrapper: response last 100:', JSON.stringify(text.substring(text.length - 100)));

            // Clean trailing garbage: /*...*/ comments, whitespace, etc. after the closing }
            var cleanedText = text;
            // Find the last } and truncate everything after it
            var lastBrace = cleanedText.lastIndexOf('}');
            if (lastBrace >= 0 && lastBrace < cleanedText.length - 1) {
                var afterBrace = cleanedText.substring(lastBrace + 1);
                // Truncate only if what follows } is whitespace, comments, quotes or other non-JSON content
                if (/^[\s*\/"']*$/.test(afterBrace)) {
                    cleanedText = cleanedText.substring(0, lastBrace + 1);
                    vlog('[Placemill] parseWrapper: trimmed trailing garbage, new len =', cleanedText.length);
                }
            }
            cleanedText = cleanedText.trim();

            var wrapper = JSON.parse(cleanedText);
            var d = wrapper.d;
            if (!d || typeof d !== 'string') {
                warn('[Placemill] parseWrapper: no "d" field');
                // Try other fields
                if (wrapper[0] && typeof wrapper[0] === 'string') {
                    d = wrapper[0];
                } else {
                    return results;
                }
            }
            vlog('[Placemill] parseWrapper: d len =', d.length, 'first 100:', JSON.stringify(d.substring(0, 100)));
            // d is already decoded into a string by JSON.parse, strip the XSSI prefix )]}'\n
            d = d.replace(/^\)\]\}'\n?/, '');
            // M8 / J-08f: the inner payload is a JSON string that was escaped
            // once, so an escaped control byte comes back as a real one here.
            d = sanitizeJsonText(d);
            var data = JSON.parse(d);
            vlog('[Placemill] parseWrapper: data len =', data.length);
            results = extractBusinesses(data);
        } catch (e) {
            console.error('[Placemill] parseWrapper error:', e.message || e);
            // Fallback: try the raw format
            if (text.charAt(0) === '{') {
                vlog('[Placemill] parseWrapper: falling back to raw format');
                // Check whether the response actually starts with )]}'
                var maybeRaw = text.replace(/^\)\]\}'\n?/, '');
                if (maybeRaw !== text) {
                    try {
                        var arr = JSON.parse(maybeRaw);
                        if (Array.isArray(arr)) {
                            vlog('[Placemill] parseWrapper: raw fallback succeeded, data len =', arr.length);
                            results = extractBusinesses(arr);
                        }
                    } catch (e2) {
                        console.error('[Placemill] parseWrapper: raw fallback also failed:', e2.message || e2);
                    }
                }
            }
        }
        return results;
    }

    // ---------- Extract businesses from the data array ----------
    function extractBusinesses(data) {
        var results = [];
        // M8 / J-08b: the probe samples a few rows of the batch. Debug
        // builds only, and it never touches the rows below.
        var probeRows = [];
        if (!data || !Array.isArray(data)) {
            warn('[Placemill] extract: data is not array');
            return results;
        }

        // The detailed business list lives at the mapped results index.
        var detailList = data[__fieldMapState.map.resultsIndex];
        if (!detailList || !Array.isArray(detailList)) {
            // Scan to find it
            warn('[Placemill] extract: results list missing at index ' +
                __fieldMapState.map.resultsIndex + ', scanning...');
            for (var k = 0; k < data.length; k++) {
                if (Array.isArray(data[k]) && data[k].length > 5) {
                    var first = data[k][0];
                    if (first && Array.isArray(first) && first.length >= 2 &&
                        first[0] === null && Array.isArray(first[1]) && first[1].length > 10) {
                        detailList = data[k];
                        vlog('[Placemill] extract: found at data[' + k + '], len =', detailList.length);
                        break;
                    }
                }
            }
            if (!detailList) {
                warn('[Placemill] extract: could not find detail list');
                return results;
            }
        }
        vlog('[Placemill] extract: detailList len =', detailList.length);

        // Fallback coordinates
        var basicList = [];
        try {
            basicList = (data[16] && data[16][3] && data[16][3][0] && data[16][3][0][4]) || [];
        } catch (e) { /* ignore */ }

        for (var i = 0; i < detailList.length; i++) {
            var entry = detailList[i];
            if (!entry || !Array.isArray(entry) || entry.length < 2 || !entry[1]) continue;
            var detail = entry[1];

            // M8 / J-08b: collect this row for the index probe. Read-only:
            // the snapshot never enters `business-data`.
            if (DEBUG_BUILD && probeRows.length < PROBE_ROWS) probeRows.push(detail);

            var biz = {
                name:          hStr(detail, __fieldMapState.map.name),
                address:       hStrAny(detail, __fieldMapState.map.address),
                phone:         hPhone(detail, __fieldMapState.map.phone),
                rating:        hNum(detail[__fieldMapState.map.rating[0]], __fieldMapState.map.rating[1]),
                reviews_total: hInt(detail[__fieldMapState.map.reviews[0]], __fieldMapState.map.reviews[1]),
                lat:           hNum(detail[__fieldMapState.map.coords], 2),
                lng:           hNum(detail[__fieldMapState.map.coords], 3),
                place_id:      hStrAny(detail, __fieldMapState.map.placeId),
                website:       hWebsite(detail, __fieldMapState.map.website),
                types:         hTypes(detail, __fieldMapState.map.types),
                // M8 / J-08a: the new fields ride the same map, and the
                // optional-key rule applies (no remote value -> built-in).
                // The indices are hypotheses until the index probe (J-08b)
                // confirms them; a slot holding the wrong type yields ''
                // rather than a wrong value. Rust ignores these keys for now
                // — the columns arrive with J-08c.
                price_range:   hStr(detail[mapIndex('priceRange')], 2),
                timezone:      hStr(detail, mapIndex('timezone')),
                // M8 / J-08c: the fields the index probe confirmed as filled
                // in the search payload. Every container index comes from the
                // field map; the deeper path inside it is a constant of the
                // format (like `coords` -> 2/3).
                street:       hPathStr(detail, [mapIndex('completeAddress'), 1, 1]),
                city:         hPathStr(detail, [mapIndex('completeAddress'), 1, 3]),
                state:        hPathStr(detail, [mapIndex('completeAddress'), 1, 5]),
                postal_code:  hPathStr(detail, [mapIndex('completeAddress'), 1, 4]),
                country:      hPathStr(detail, [mapIndex('completeAddress'), 1, 6]),
                borough:      hPathStr(detail, [mapIndex('completeAddress'), 1, 0]),
                data_id:      hPathStr(detail, [mapIndex('dataId')]),
                reviews_link: hPathStr(detail, [mapIndex('reviewsLink'), 3, 0]),
                thumbnail:    hPathStr(detail, [mapIndex('thumbnail'), 0, 1, 6, 0]),
                owner_name:   stripOwnerRole(hPathStr(detail, [mapIndex('owner'), 1])),
                about:        extractAbout(hPathArr(detail, [mapIndex('about'), 1])),
                open_hours:   extractOpenHours(hPathArr(detail, [mapIndex('openHours'), 0])),
            };

            // Fallback coordinates (microdegrees)
            if ((!biz.lat || !biz.lng) && i < basicList.length) {
                var basic = basicList[i];
                if (basic && Array.isArray(basic[3]) && basic[3].length >= 2) {
                    biz.lat = biz.lat || (basic[3][0] / 1e6);
                    biz.lng = biz.lng || (basic[3][1] / 1e6);
                }
            }

            if (biz.name) {
                if (results.length < 3) {
                    vlog('[Placemill] biz[' + results.length + ']:', biz.name, '|', biz.address);
                }
                results.push(biz);
            }
        }
        // M8 / J-08b: the snapshot is taken once the batch is read, so the
        // fill rates are computed over several rows instead of one.
        if (DEBUG_BUILD && probeRows.length > 0) captureProbeSnapshot(probeRows);
        return results;
    }

    // ---------- Legacy regex fallback ----------
    function parseV1Regex(text) {
        var results = [];
        var match = text.match(/\\n(.*?)","e"/);
        if (!match || !match[1]) {
            warn('[Placemill] parseV1Regex: regex not matched');
            return results;
        }
        vlog('[Placemill] parseV1Regex: matched, len =', match[1].length);
        var cleaned = match[1].replace(/\\"/g, '"').replace(/\\\\"/g, '');
        try {
            var parsed = JSON.parse(cleaned);
            if (!parsed || !parsed[0] || !Array.isArray(parsed[0][1])) return results;
            var items = parsed[0][1].slice(1);
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (!item || !item[14]) continue;
                var biz = {
                    name:          hStr(item[14], 11),
                    address:       hStr(item[14], 18),
                    phone:         hStr(item[14][178] && item[14][178][0], 0),
                    rating:        hNum(item[14][4], 7),
                    reviews_total: hInt(item[14][4], 8),
                    lat:           hNum(item[14][9], 2),
                    lng:           hNum(item[14][9], 3),
                    place_id:      hStr(item[14], 78),
                    website:       hStr(item[14][7], 0),
                    types:         Array.isArray(item[14][76]) ? item[14][76] : [],
                };
                if (biz.name) results.push(biz);
            }
        } catch (e) {
            console.error('[Placemill] parseV1Regex error:', e);
        }
        return results;
    }

    // ============================================================
    // 3b. Reviews (M9 / J-09a)
    //
    // The comments live behind the same RPC the page itself uses:
    //   POST /maps/_/MapsWizUi/data/batchexecute?rpcids=qv9Egd
    //   body: f.req=[[["qv9Egd","<inner json>","null","generic"]]]
    // The answer is a length-prefixed chunk stream ("<byte length>\n<json>"
    // repeated); the frame carries a nested JSON string whose `inner[2]`
    // holds the reviews (each review is `inner[2][i][0]`).
    //
    // The relative field paths are the ones gosom uses — only the root
    // changed (`docs/parser.md`). Measured, not guessed:
    //   text            r[2][15][0][0]
    //   stars           r[2][0][0]
    //   author          r[1][4][5][0]
    //   created/updated r[1][2] / r[1][3]   (microseconds)
    //   owner reply     r[3] (body r[3][14][0][0])
    // ============================================================

    // The page's session state. The reviews request needs three things
    // (see `docs/parser.md`): the session token, the session header
    // x-maps-bgkey, and the target place's hex id. The first two live in the
    // page's own requests, so we learn them from the traffic instead of
    // asking the page for them.
    var __reviewsSession = {
        token: '',
        bgkey: '',
        tokenAt: 0,
        bgkeyAt: 0,
        seen: 0,
        shapes: [],
        lastBatchBody: '',
        lastQv9Response: '',
        // Per-call pairs: a replay must use the url AND body of the SAME
        // call — the page issues several qv9Egd requests and later ones come
        // back empty, so mixing the first url with the last body fails.
        qv9Calls: [],
        // The page's own full qv9Egd answer (M9). The primary reviews source:
        // parsing it needs no request of our own.
        lastQv9Full: '',
        // Incoming messages (service worker → page). Since the afternoon
        // change the qv9Egd fetch answers with an empty "handed off" frame
        // and the actual reviews are believed to arrive through this channel.
        messages: [],
    };

    // Record large incoming messages. The reviews payload is tens of KB, so
    // a size gate keeps this cheap while still catching it.
    function rememberIncomingMessage(text, source) {
        try {
            if (typeof text !== 'string' || text.length < 2000) return;
            __reviewsSession.messages.push({
                source: source,
                length: text.length,
                head: text.slice(0, 300),
                hasReviewMarker: text.indexOf('Dawei Wang') !== -1,
            });
            if (__reviewsSession.messages.length > 5) {
                __reviewsSession.messages.shift();
            }
        } catch (e) {
            /* ignore */
        }
    }

    (function hookIncomingMessages() {
        try {
            window.addEventListener('message', function (event) {
                try {
                    var text = typeof event.data === 'string'
                        ? event.data
                        : JSON.stringify(event.data);
                    rememberIncomingMessage(text, 'window.message');
                } catch (e) {
                    /* ignore */
                }
            });
        } catch (e) {
            /* ignore */
        }
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
                navigator.serviceWorker.addEventListener('message', function (event) {
                    try {
                        var text = typeof event.data === 'string'
                            ? event.data
                            : JSON.stringify(event.data);
                        rememberIncomingMessage(text, 'sw.message');
                    } catch (e) {
                        /* ignore */
                    }
                });
            }
        } catch (e) {
            /* ignore */
        }
    })();

    // Keep the page's own reviews body around: comparing it with ours is how
    // a wrong request gets diagnosed. The url and the body are kept as a
    // PAIR — a replay must use both from the same call.
    function rememberBatchBody(text, url) {
        try {
            if (typeof url === 'string' && url.indexOf('qv9Egd') !== -1 && text) {
                var body = String(text).slice(0, 4000);
                __reviewsSession.lastBatchBody = body;
                __reviewsSession.qv9Calls.push({ url: String(url), body: body });
                if (__reviewsSession.qv9Calls.length > 5) {
                    __reviewsSession.qv9Calls.shift();
                }
            }
        } catch (e) {
            /* ignore */
        }
    }

    // A small ring of what the page's requests look like. The session header
    // is added by the page in a way we could not see; this is how we find
    // out where it actually is.
    function rememberRequestShape(shape) {
        try {
            __reviewsSession.shapes.push(shape);
            if (__reviewsSession.shapes.length > 12) {
                __reviewsSession.shapes.shift();
            }
        } catch (e) {
            /* ignore */
        }
    }

    function rememberReviewsSession(details) {
        if (!details) return;
        try {
            if (details.bgkey && details.bgkey !== __reviewsSession.bgkey) {
                __reviewsSession.bgkey = details.bgkey;
                __reviewsSession.bgkeyAt = Date.now();
            }
            if (details.token && details.token !== __reviewsSession.token) {
                __reviewsSession.token = details.token;
                __reviewsSession.tokenAt = Date.now();
            }
            __reviewsSession.seen++;
        } catch (e) {
            /* a request we cannot read is not a reason to break the page */
        }
    }

    // Find a session token in any text, wherever it came from.
    function reviewsTokenAnywhere(text) {
        if (typeof text !== 'string' || !text) return '';
        var match = text.match(/(?:%5C%22|\\")([A-Za-z0-9_-]{18,30})(?:%5C%22|\\")/);
        if (match) return match[1];
        match = text.match(/%22([A-Za-z0-9_-]{18,30})%22/);
        if (match) return match[1];
        return '';
    }

    // The page hands the batchexecute parameters to the service worker with
    // postMessage, and the worker assembles the request from them — that is
    // why the request body never appears in this context. The token travels
    // in that message.
    (function hookPostMessage() {
        var original = window.postMessage;
        if (typeof original !== 'function') return;
        window.__placemillOriginalPostMessage = original.bind(window);
        window.postMessage = function (message, target, transfer) {
            try {
                if (typeof message === 'string') {
                    rememberReviewsSession({ token: reviewsTokenAnywhere(message) });
                } else if (message && typeof message === 'object') {
                    rememberReviewsSession({ token: reviewsTokenAnywhere(JSON.stringify(message)) });
                }
            } catch (e) {
                /* ignore */
            }
            return window.__placemillOriginalPostMessage(message, target, transfer);
        };
    })();

    // The session token is part of the page's own initialization state
    // (APP_INITIALIZATION_STATE, APP_OPTIONS, the inline bootstrap script).
    // The page's fetch call does not carry it where we can read it — the
    // request body is assembled after our hook sees it — so we take it from
    // the state instead.
    function reviewsTokenFromState() {
        var texts = [];
        try {
            var scripts = document.getElementsByTagName('script');
            for (var i = 0; i < scripts.length; i++) {
                var text = scripts[i].textContent || '';
                if (text.indexOf('APP_INITIALIZATION_STATE') !== -1) texts.push(text);
            }
        } catch (e) {
            /* ignore */
        }
        try {
            if (window.APP_OPTIONS) texts.push(JSON.stringify(window.APP_OPTIONS));
        } catch (e2) {
            /* ignore */
        }
        try {
            if (window.APP_INITIALIZATION_STATE) {
                texts.push(JSON.stringify(window.APP_INITIALIZATION_STATE));
            }
        } catch (e3) {
            /* ignore */
        }
        for (var t = 0; t < texts.length; t++) {
            var match = texts[t].match(/"[A-Za-z]*[Tt]oken[A-Za-z]*"\s*:\s*"([A-Za-z0-9_-]{18,30})"/);
            if (match) return match[1];
        }
        return '';
    }

    // The body of a request, as text. The page does not always use a string:
    // a URLSearchParams body has to be stringified before it can be read.
    function reviewsBodyText(body) {
        if (typeof body === 'string') return body;
        if (body && typeof body.toString === 'function') {
            try {
                return String(body);
            } catch (e) {
                return '';
            }
        }
        return '';
    }

    // Pull the session token out of a request body. The page sends
    // `f.req=[[["<rpc>","<json>"]]]`, percent-encoded, and the token sits in
    // that json as \"<token>\".
    //
    // Only qv9Egd bodies count, and for two reasons: other calls (log204 and
    // friends) carry their own session ids in a pb, and — measured — every
    // rpc carries a token of its own, so a token taken from r4skrb is not
    // accepted by the reviews endpoint (it answers 200 with an empty frame).
    function reviewsTokenFromBody(body, url) {
        var text = reviewsBodyText(body);
        if (!text) return '';
        if (typeof url === 'string' && url.indexOf('qv9Egd') === -1) return '';
        var match = text.match(/(?:%5C%22|\\")([A-Za-z0-9_-]{18,30})(?:%5C%22|\\")/);
        if (match) return match[1];
        match = text.match(/%22([A-Za-z0-9_-]{18,30})%22/);
        if (match) return match[1];
        return '';
    }

    // Pull the session header out of a request. The page sets it on its own
    // calls; we only read it.
    function reviewsBgkeyFromHeaders(headers) {
        if (!headers) return '';
        try {
            if (typeof headers.get === 'function') {
                return headers.get('x-maps-bgkey') || '';
            }
            // A plain object or an array of [name, value] pairs.
            if (Array.isArray(headers)) {
                for (var i = 0; i < headers.length; i++) {
                    var pair = headers[i];
                    if (pair && String(pair[0]).toLowerCase() === 'x-maps-bgkey') {
                        return String(pair[1] || '');
                    }
                }
                return '';
            }
            for (var key in headers) {
                if (String(key).toLowerCase() === 'x-maps-bgkey') {
                    return headers[key] || '';
                }
            }
        } catch (e) {
            /* ignore */
        }
        return '';
    }

    // The names of the headers a request carries, whichever form they came
    // in (Headers, plain object, array of pairs).
    function reviewsHeaderNames(a, b) {
        var names = [];
        function collect(headers) {
            if (!headers) return;
            try {
                if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
                    headers.forEach(function (value, key) { names.push(String(key)); });
                    return;
                }
                if (Array.isArray(headers)) {
                    for (var i = 0; i < headers.length; i++) {
                        if (headers[i]) names.push(String(headers[i][0]));
                    }
                    return;
                }
                for (var key in headers) names.push(String(key));
            } catch (e) {
                /* ignore */
            }
        }
        collect(a);
        collect(b);
        return names.join(' ');
    }

    // Walk a path inside the positional arrays. The payload is full of
    // holes, so every step has to tolerate a missing slot.
    function pathAt(root, path) {
        var value = root;
        for (var i = 0; i < path.length; i++) {
            if (value === null || value === undefined) return undefined;
            value = value[path[i]];
        }
        return value;
    }
    function strAt(root, path) {
        var value = pathAt(root, path);
        return typeof value === 'string' ? value : '';
    }
    function numAt(root, path) {
        var value = pathAt(root, path);
        return typeof value === 'number' ? value : 0;
    }

    // Map one review root to our shape. Both channels (qv9Egd and the
    // reviews_link payload) share the same relative field paths — measured,
    // `docs/parser.md`.
    function mapReview(review) {
        return {
            review_id: strAt(review, [0]),
            place_id: strAt(review, [1, 0]),
            created_at_us: numAt(review, [1, 2]),
            updated_at_us: numAt(review, [1, 3]),
            relative_time: strAt(review, [1, 6]),
            author: strAt(review, [1, 4, 5, 0]),
            author_avatar: strAt(review, [1, 4, 5, 1]),
            author_id: strAt(review, [1, 4, 5, 3]),
            author_link: strAt(review, [1, 4, 2, 0]),
            stars: numAt(review, [2, 0, 0]),
            text: strAt(review, [2, 15, 0, 0]),
            owner_reply: strAt(review, [3, 14, 0, 0]),
            owner_reply_at_us: numAt(review, [3, 1]),
            owner_reply_relative: strAt(review, [3, 3]),
            helpful_votes: numAt(review, [4, 2]),
            photo_url: strAt(review, [4, 3, 0]),
            report_url: strAt(review, [4, 4, 0]),
        };
    }

    // Parse the reviews_link payload (`search.google.com/local/reviews?
    // placeid=<ChIJ>`). It carries ONE review (the featured one) under
    // [6][175][9][0][0][0] — the other slots are null — with the same
    // per-review shape as qv9Egd.
    function parseReviewsLinkPayload(text) {
        var out = { reviews: [], nextToken: null, error: null };
        if (typeof text !== 'string' || !text.length) {
            out.error = 'empty payload';
            return out;
        }
        var root = null;
        try {
            root = JSON.parse(text.charCodeAt(0) === 41 ? text.slice(4) : text);
        } catch (e) {
            out.error = 'parse: ' + (e && e.message ? e.message : e);
            return out;
        }
        var list = null;
        try {
            list = root[6][175][9][0][0][0];
        } catch (e2) {
            list = null;
        }
        if (!Array.isArray(list)) {
            out.error = 'no reviews list';
            return out;
        }
        for (var i = 0; i < list.length; i++) {
            var review = list[i];
            if (!review || !Array.isArray(review)) continue;
            var id = review[0];
            // Review ids are Google's own base64url strings whose PREFIX
            // varies (ChZ…, Ci9…, Chd… — measured); only the leading C and
            // the length are stable across shapes. The author structure
            // confirms the row is a review.
            if (typeof id !== 'string' || id.length < 25 || id.charAt(0) !== 'C') continue;
            if (!review[1] || !review[1][4] || !review[1][4][5]) continue;
            out.reviews.push(mapReview(review));
        }
        return out;
    }

    // Parse one reviews answer. Pure: the same text always yields the same
    // reviews, so the e2e can pin it with a captured fixture.
    function parseReviewsPayload(text) {
        var out = { reviews: [], nextToken: null, error: null };
        if (typeof text !== 'string' || !text.length) {
            out.error = 'empty payload';
            return out;
        }
        var body = text.charCodeAt(0) === 41 ? text.slice(4) : text; // )]}'
        // The frame is pulled out by scanning for its marker rather than by
        // the chunk lengths: those are byte counts, so a chunk holding
        // multi-byte characters cannot be sliced reliably.
        var marker = '["wrb.fr","qv9Egd","';
        var at = body.indexOf(marker);
        if (at < 0) {
            out.error = 'no qv9Egd frame';
            return out;
        }
        var start = at + marker.length;
        // The frame's payload is a JSON string: scan to its closing quote,
        // honouring escapes.
        var end = start;
        var escaped = false;
        for (; end < body.length; end++) {
            var ch = body.charAt(end);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') break;
        }
        var inner = null;
        try {
            inner = JSON.parse(JSON.parse('"' + body.slice(start, end) + '"'));
        } catch (e) {
            out.error = 'inner parse: ' + (e && e.message ? e.message : e);
            return out;
        }
        var list = Array.isArray(inner[2]) ? inner[2] : [];
        for (var k = 0; k < list.length; k++) {
            var entry = list[k];
            var review = Array.isArray(entry) && Array.isArray(entry[0]) ? entry[0] : null;
            if (!review) continue;
            out.reviews.push(mapReview(review));
        }
        out.nextToken = typeof inner[1] === 'string' ? inner[1] : null;
        return out;
    }

    // Build the request for one place's reviews. The inner JSON is the shape
    // the page sends (measured); only the place id and the session token are
    // ours. The source path can be anything the page would accept — the
    // place's name in it turned out to be irrelevant (see `docs/parser.md`).
    function buildReviewsRequest(placeId, sessionToken, sourcePath, bgkey) {
        // The inner JSON, element for element as the page sends it. Two
        // earlier mistakes to not repeat: element 0 is [[placeId], ...] (one
        // nesting level less than it looks), and the tail elements after
        // [null,1,1,...] are SIBLINGS of it, not children.
        var inner = [
            [[placeId], null, null, null, null, [null, null, null, [[1], [3]]]],
            [10, ''],
            null,
            null,
            [sessionToken, null, null, null, null, null, 81],
            null,
            null,
            [null, 1, 1, null, 1, null, 1, null, null, null, null, [1, 1, null, [[1]]]],
            null,
            null,
            [3, 1, null, null, null, [2]],
            null,
            [1],
        ];
        var body = 'f.req=' + encodeURIComponent(
            // The third element of the outer array is a JSON null, not the
            // string "null" — with the string the server answers 200 with an
            // empty frame. The page also ends the body with a trailing "&".
            JSON.stringify([[['qv9Egd', JSON.stringify(inner), null, 'generic']]]),
        ) + '&';
        // The path only, never the query: the page's own request carries the
        // clean path, and a source-path with `?entry=ttu&g_ep=...` appended
        // makes the endpoint answer 200 with an empty frame.
        //
        // The `!1s<hex>` segment inside the path must be the TARGET place's
        // id — a path whose hex disagrees with the body's is answered with an
        // empty frame too. The rest of the data section stays as the current
        // page's: it is a well-formed place path, which a hand-built one is
        // not guaranteed to be.
        var path = sourcePath || String(window.location.pathname).replace(
            /!1s0x[^/!]+/,
            '!1s' + placeId,
        );
        var lang = (window.document.documentElement.lang || 'en').slice(0, 8);
        var url = 'https://www.google.com/maps/_/MapsWizUi/data/batchexecute'
            + '?rpcids=qv9Egd'
            + '&source-path=' + encodeURIComponent(path)
            + '&hl=' + encodeURIComponent(lang)
            + '&_reqid=' + (400000 + Math.floor(Math.random() * 90000))
            + '&rt=c';
        var headers = {
            'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
            'x-same-domain': '1',
        };
        if (bgkey) headers['x-maps-bgkey'] = bgkey;
        return { url: url, body: body, headers: headers };
    }

    // ---------- Tier-2 detail enrichment ----------
    // The place-page payload (APP_INITIALIZATION_STATE[3].Dg[6]) carries
    // jd[6] — the SAME positional detail array the search payload carries per
    // element, measured 2/2 on a dealer and a coffeehouse
    // (see `docs/parser.md`). Only four fields are worth reading here; the
    // search payload fills everything else, and price_level/popular_times are
    // NOT in this payload even for pages that render them (measured).

    var PLACE_PHOTOS_MAX = 12;

    /// Photos live in different containers depending on the business type
    /// ([31][1][x] user uploads, [37]/[51][0][x] dealer-style entries) —
    /// gosom's [171] stays null in this payload, so the collector walks all
    /// three measured shapes and deduplicates. Protocol-relative forms are
    /// upgraded to https.
    function collectDetailPhotos(detail) {
        var seen = {};
        var out = [];
        var push = function (url) {
            if (typeof url !== 'string' || url.length < 12) return;
            if (url.slice(0, 2) === '//') url = 'https:' + url;
            if (url.indexOf('googleusercontent.com/') === -1 && url.indexOf('ggpht.com/') === -1) return;
            if (seen[url]) return;
            seen[url] = true;
            out.push(url);
        };
        var walkEntries = function (container, forms) {
            if (!Array.isArray(container)) return;
            container.forEach(function (entry) {
                for (var i = 0; i < forms.length; i++) {
                    push(walkPath(entry, forms[i]));
                    if (out.length >= PLACE_PHOTOS_MAX) return;
                }
            });
        };
        walkEntries(walkPath(detail, [31, 1]), [[6, 1, 3], [0, 2]]);
        walkEntries(walkPath(detail, [37, 0]), [[6, 0]]);
        walkEntries(walkPath(detail, [51, 0]), [[6, 0]]);
        return out;
    }

    /// Pure: the same jd always yields the same detail fields, so the e2e
    /// pins it with the two real captured payloads. `jd[6]` must identify
    /// itself — a name or a place id — or the payload is not a place detail.
    function parsePlaceStatePayload(jd) {
        var out = {
            ok: false,
            error: null,
            name: '',
            placeId: '',
            dataId: '',
            plusCode: '',
            description: '',
            reviewsPerRating: [],
            photos: [],
        };
        if (!Array.isArray(jd) || !Array.isArray(jd[6])) {
            out.error = 'no detail array at jd[6]';
            return out;
        }
        var d = jd[6];
        out.name = hStr(d, 11);
        out.placeId = hStr(d, 78);
        out.dataId = hStr(d, 10);
        if (!out.name && !out.placeId) {
            out.error = 'payload has neither name[11] nor place_id[78]';
            return out;
        }
        out.ok = true;
        var plus = walkPath(d, [183, 2, 2, 0]);
        out.plusCode = typeof plus === 'string' ? plus : '';
        var description = walkPath(d, [32, 1, 1]);
        out.description = typeof description === 'string' ? description : '';
        var perRating = walkPath(d, [175, 3]);
        if (Array.isArray(perRating)) {
            // Index 0 = 1-star … index 4 = 5-star; both fixtures sum exactly
            // to reviews_total, so a shorter list pads with 0.
            for (var i = 0; i < 5; i++) {
                var n = perRating[i];
                out.reviewsPerRating.push(typeof n === 'number' && n >= 0 ? Math.round(n) : 0);
            }
        }
        out.photos = collectDetailPhotos(d);
        return out;
    }

    /// The enrichment runner's one eval: read the current place payload out of
    /// the bootstrap state. Direct `Dg[6]` only — the bounded scan the spike
    /// used is not worth its timeout risk in production; a page whose payload
    /// did not land reports `ok: false` and the runner counts the place
    /// failed. Pure read of the page's own state.
    var placemillParsePlaceState = function () {
        var empty = function (error) {
            return {
                ok: false,
                error: error,
                name: '',
                placeId: '',
                dataId: '',
                plusCode: '',
                description: '',
                reviewsPerRating: [],
                photos: [],
            };
        };
        try {
            var state = window.APP_INITIALIZATION_STATE;
            var bucket = state && state[3];
            var text = bucket && bucket.Dg ? bucket.Dg[6] : null;
            if (typeof text !== 'string' || text.slice(0, 4) !== ")]}'") {
                return empty('no XSSI payload at Dg[6]');
            }
            var jd = JSON.parse(sanitizeJsonText(text.slice(5)));
            return parsePlaceStatePayload(jd);
        } catch (e) {
            return empty(String(e && e.message ? e.message : e));
        }
    };

    // ---------- Shared helpers ----------
    function hStr(arr, idx) {
        return (arr && typeof arr[idx] === 'string') ? arr[idx] : '';
    }
    // First non-empty string among the mapped fallback indices (address and
    // place_id each carry 1-2 candidates).
    function hStrAny(arr, indices) {
        for (var i = 0; i < indices.length; i++) {
            var value = hStr(arr, indices[i]);
            if (value) return value;
        }
        return '';
    }
    function hNum(arr, idx) {
        return (arr && typeof arr[idx] === 'number') ? arr[idx] : 0;
    }
    function hInt(arr, idx) {
        return (arr && typeof arr[idx] === 'number') ? Math.round(arr[idx]) : 0;
    }
    function hPhone(detail, phoneIndex) {
        try {
            if (detail[phoneIndex] && Array.isArray(detail[phoneIndex]) && detail[phoneIndex].length > 0) {
                var pe = detail[phoneIndex][0];
                if (pe && Array.isArray(pe) && pe.length > 0) {
                    return typeof pe[0] === 'string' ? pe[0] : '';
                }
            }
        } catch (e) { /* ignore */ }
        return '';
    }
    function hWebsite(detail, websiteIndex) {
        try {
            if (detail[websiteIndex] && Array.isArray(detail[websiteIndex]) && detail[websiteIndex].length > 0) {
                return typeof detail[websiteIndex][0] === 'string' ? detail[websiteIndex][0] : '';
            }
        } catch (e) { /* ignore */ }
        return '';
    }
    // ---------- M8 / J-08c helpers ----------
    // The new fields sit deeper in the payload than the old ones, so the
    // extractor walks a fixed path of indices. The container index comes
    // from the field map; the rest is a constant of the format.
    function walkPath(root, path) {
        var current = root;
        for (var i = 0; i < path.length; i++) {
            if (current === undefined || current === null) return undefined;
            current = current[path[i]];
        }
        return current;
    }
    function hPathStr(root, path) {
        var value = walkPath(root, path);
        return typeof value === 'string' ? value : '';
    }
    function hPathArr(root, path) {
        var value = walkPath(root, path);
        return Array.isArray(value) ? value : null;
    }
    // The owner entry reads "Lilia Martinez D.D.S (Owner)" — the role tag is
    // Google's, not part of the name. Only that exact tag is stripped, so a
    // name that legitimately ends in parentheses keeps them.
    function stripOwnerRole(value) {
        if (!value) return '';
        return value.replace(/\s*\(Owner\)\s*$/, '').trim();
    }
    // The about block is a list of [key, label] pairs, e.g.
    // ["accessibility", "Accessibility"]. Only the pairs are kept.
    function extractAbout(items) {
        var result = [];
        if (!items) return result;
        for (var i = 0; i < items.length && result.length < 20; i++) {
            var item = items[i];
            if (!item || !Array.isArray(item) || item.length < 2) continue;
            var key = typeof item[0] === 'string' ? item[0] : '';
            var label = typeof item[1] === 'string' ? item[1] : '';
            if (key && label) result.push({ key: key, label: label });
        }
        return result;
    }
    // Opening hours: the list of weekday entries. Each entry is an array
    // whose [0] is the weekday name and whose [3] holds the periods; each
    // period is an array whose [0] is the text ("9 AM – 5 PM"). A day with
    // no periods is kept — "closed" is information.
    function extractOpenHours(days) {
        var result = [];
        if (!days) return result;
        for (var i = 0; i < days.length && result.length < 7; i++) {
            var entry = days[i];
            if (!entry || !Array.isArray(entry)) continue;
            var name = typeof entry[0] === 'string' ? entry[0] : '';
            if (!name) continue;
            var slots = Array.isArray(entry[3]) ? entry[3] : [];
            var periods = [];
            for (var j = 0; j < slots.length && periods.length < 8; j++) {
                var slot = slots[j];
                var text = '';
                if (typeof slot === 'string') text = slot;
                else if (Array.isArray(slot) && typeof slot[0] === 'string') text = slot[0];
                if (text) periods.push(text);
            }
            result.push({ day: name, periods: periods });
        }
        return result;
    }
    function hTypes(detail, typesIndex) {
        try {
            if (detail[typesIndex] && Array.isArray(detail[typesIndex])) {
                var result = [];
                for (var i = 0; i < detail[typesIndex].length; i++) {
                    var t = detail[typesIndex][i];
                    // The category list is a flat array of strings in the
                    // search payload (`detail[13]` -> "Dentist") and an
                    // array of one-element arrays in the detail payload
                    // (`detail[76][i][0]`). Both shapes are accepted.
                    if (typeof t === 'string') {
                        if (t) result.push(t);
                    } else if (t && Array.isArray(t) && t[0]) {
                        result.push(t[0]);
                    }
                }
                return result;
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    // ============================================================
    // 4. Send data to the Rust backend
    // ============================================================
    function flushData(businesses, meta) {
        vlog('[Placemill] flushData called, count:', businesses.length);
        var hasIPC = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) ||
                      (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
        if (hasIPC) {
            doSend(businesses, meta);
        } else {
            warn('[Placemill] IPC not ready, queuing...');
            // Queue whole batches, not flat rows: the metadata belongs to the
            // response that produced those rows, and merging them would attribute
            // a later search's rows to an earlier one.
            PENDING.push({ businesses: businesses, meta: meta || {} });
            if (!window.__placemillTimer) {
                window.__placemillTimer = setInterval(function () {
                    var ready = (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) ||
                                 (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
                    while (ready && PENDING.length > 0) {
                        var entry = PENDING.shift();
                        vlog('[Placemill] Flushing ' + entry.businesses.length + ' pending items');
                        doSend(entry.businesses, entry.meta);
                    }
                }, 200);
            }
        }
    }

    function doSend(businesses, meta) {
        if (!window.__placemillEnabled) {
            vlog('[Placemill] doSend: disabled, skipping ' + businesses.length + ' items');
            return;
        }

        // "Only businesses with a phone number": dropping them here saves the IPC
        // round trip and the SQLite write. Rust applies the same rule as a
        // backstop, because the switch can change while a batch is in flight.
        var onlyWithPhone = window.__placemillSettings && window.__placemillSettings.onlyWithPhone;
        if (onlyWithPhone) {
            businesses = businesses.filter(function (item) { return item.phone; });
            if (businesses.length === 0) {
                vlog('[Placemill] doSend: every item filtered out (no phone)');
                return;
            }
        }

        counters.sent += businesses.length;

        // Attribution travels with the batch, not with each row: `Business` is a
        // shared contract with Rust (and the SQLite schema), while the tile and
        // the source query are properties of the search that produced the rows.
        var payload = {
            businesses: businesses,
            sourceQuery: (meta && typeof meta.sourceQuery === 'string') ? meta.sourceQuery : '',
            jobId: currentTileField('jobId'),
            tileId: currentTileField('tileId')
        };
        vlog('[Placemill] IPC emit: business-data, count:', businesses.length,
            '| query:', payload.sourceQuery, '| tile:', payload.tileId);

        try {
            // Correct Tauri v2 event API: __TAURI__.event.emit()
            if (window.__TAURI__ && window.__TAURI__.event && typeof window.__TAURI__.event.emit === 'function') {
                var p = window.__TAURI__.event.emit('business-data', payload);
                // emit returns a Promise, so the rejection must be handled
                if (p && typeof p.then === 'function') {
                    p.then(function () {
                        vlog('[Placemill] IPC emit OK (via __TAURI__.event.emit)');
                    }).catch(function (e) {
                        console.error('[Placemill] IPC emit FAILED:', e);
                    });
                } else {
                    vlog('[Placemill] IPC emit OK (sync)');
                }
            } else if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
                var p2 = window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
                    event: 'business-data',
                    payload: payload
                });
                if (p2 && typeof p2.then === 'function') {
                    p2.then(function () {
                        vlog('[Placemill] IPC emit OK (via invoke fallback)');
                    }).catch(function (e) {
                        console.error('[Placemill] IPC emit FAILED:', e);
                    });
                } else {
                    vlog('[Placemill] IPC emit OK (sync fallback)');
                }
            } else {
                throw new Error('No IPC method available');
            }
        } catch (e) {
            console.error('[Placemill] IPC emit FAILED:', e);
        }
    }

// ============================================================
// 5.1 Health probe (UI-01b)
//
// R-11: the old no-op 3 s "heartbeat" interval above this section was removed
// — it ran an empty function forever and contributed nothing.
// ============================================================
//
// The switch being on does not mean data is arriving: Google may park the
// page on its consent screen, throw a captcha, or return a search with no
// result feed. The panel cannot see any of that, so the page reports it.
//
// Deliberately cheap: a 10 s interval reading three selectors, no
// MutationObserver — a big observer loop would fight the auto-scroll for
// CPU. Every probe is wrapped: a selector that stops matching must degrade
// to "unknown", never throw into the collection path.
// ============================================================
var HEALTH_INTERVAL_MS = 10000;
var HEALTH_SILENCE_MS = 20000;
var lastHealthState = '';

function probeHealth() {
    try {
        if (location.hostname === 'consent.google.com' ||
            document.querySelector('form[action*="consent"]')) {
            return 'consent';
        }
        if (document.querySelector('#captcha-form') ||
            document.querySelector('iframe[src*="recaptcha"]')) {
            return 'captcha';
        }
        // Silence only counts once this page load has actually seen a search
        // response: sitting on the Maps home page with the switch on is not a
        // "no results" condition, and saying so would cry wolf before the user
        // has searched anything.
        if (lastMapResponseAt > 0 &&
            Date.now() - lastMapResponseAt > HEALTH_SILENCE_MS &&
            !document.querySelector('[role="feed"]')) {
            return 'no-results';
        }
        return 'ok';
    } catch (e) {
        // A probe that cannot run says "unknown"; the panel keeps its last
        // honest message instead of inventing one.
        return 'unknown';
    }
}

setInterval(function () {
    // Only while collecting: an idle page must stay silent.
    if (!window.__placemillEnabled) return;
    var state = probeHealth();
    // Emit on change only, so a healthy search produces one event per state
    // rather than one every 10 s (log volume is the acceptance criterion).
    if (state === lastHealthState) return;
    lastHealthState = state;
    emitEvent('maps:health', { state: state, at: Date.now() });
    vlog('[Placemill] maps:health state=' + state);
}, HEALTH_INTERVAL_MS);

// ============================================================
// 6. Auto-scroll pagination (mimics real user behaviour to avoid detection)
// ============================================================
(function () {
    // Values come from the settings mirrored into localStorage. The literals are
    // only a fallback (missing storage, or an older payload without the field).
    var _settings = window.__placemillSettings || {};
    function _num(value, fallback) { return typeof value === 'number' ? value : fallback; }

    var autoScroll = {
        running: false,
        timer: null,
        scrollCount: 0,
        maxScrolls: _num(_settings.maxScrolls, 80),        // scroll at most N times
        // The configured budget, kept separately because each cell narrows
        // `maxScrolls` to fit the job radius. Without this the narrowing would
        // accumulate: every restart in the same document would shrink it again.
        baseMaxScrolls: _num(_settings.maxScrolls, 80),
        // Cell geometry handed over by Rust in the tile context. `null` means
        // "no cell" (a manual search), which disables the drift check.
        tileLat: null,
        tileLng: null,
        maxDriftKm: 0,
        containerCache: null,
        lastContainerHeight: 0,
        noChangeCount: 0,                                  // consecutive rounds without change
        containerMisses: 0,                                // consecutive failed container lookups
        maxNoChange: _num(_settings.stopAfterIdle, 4),     // stop after N idle rounds
        minDelay: _num(_settings.scrollMinMs, 1000),       // minimum delay (ms)
        maxDelay: _num(_settings.scrollMaxMs, 3000),       // maximum delay (ms)
        jitter: typeof _settings.jitter === 'boolean' ? _settings.jitter : true,
        // Tile identity captured when this run started, NOT when it ends.
        // `__placemillGoto` writes the next tile into sessionStorage before the
        // page unloads, so reading it at stop() time lets a timer on the old
        // page report `no-results` under the *new* tile's id — which closed a
        // fresh cell before it had loaded.
        jobId: '',
        tileId: '',

        // Applies a partial update pushed by Rust. `containerCache` is
        // deliberately left alone: none of these values affect container lookup,
        // and clearing it would force a full `findContainer` scan mid-round.
        configure: function (partial) {
            if (!partial) return;
            if (typeof partial.minDelay === 'number') {
                this.minDelay = Math.max(200, partial.minDelay);
            }
            if (typeof partial.maxDelay === 'number') {
                this.maxDelay = Math.max(this.minDelay, partial.maxDelay);
            }
            if (typeof partial.maxScrolls === 'number') {
                this.baseMaxScrolls = Math.max(1, partial.maxScrolls);
                this.maxScrolls = this.baseMaxScrolls;
            }
            if (typeof partial.maxNoChange === 'number') this.maxNoChange = Math.max(1, partial.maxNoChange);
            if (typeof partial.jitter === 'boolean') this.jitter = partial.jitter;
            log('[Placemill] autoScroll configured: ' + this.minDelay + '-' + this.maxDelay +
                'ms, max=' + this.maxScrolls + ', idle=' + this.maxNoChange + ', jitter=' + this.jitter);
        },

        // Locate the search results container
        findContainer: function () {
            // Method 1: the Google Maps results panel uses role="feed"
            var feed = document.querySelector('[role="feed"]');
            if (feed) return feed;

            // Method 2: find a scrollable div that contains search result links
            var allDivs = document.querySelectorAll('div');
            for (var i = 0; i < allDivs.length; i++) {
                var style = window.getComputedStyle(allDivs[i]);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                    allDivs[i].clientHeight > 200) {
                    var links = allDivs[i].querySelectorAll('a[href*="/maps/place/"]');
                    if (links.length > 3) return allDivs[i];
                }
            }
            return null;
        },

        // Simulate human scrolling (small random offsets, never jump to the bottom at once)
        humanScroll: function (container) {
            var currentScroll = container.scrollTop;
            var maxScroll = container.scrollHeight - container.clientHeight;

            if (currentScroll >= maxScroll - 10) {
                container.scrollTop = maxScroll;
                return;
            }

            // Scroll 60%-90% of the viewport height each time, with randomness
            var viewHeight = container.clientHeight;
            var scrollAmount = viewHeight * (0.6 + Math.random() * 0.3);
            var targetScroll = Math.min(currentScroll + scrollAmount, maxScroll);

            container.scrollTop = targetScroll;
        },

        // Did the camera walk away from the cell Rust asked for?
        //
        // The URL keeps `@lat,lng,zoom` and Google rewrites it whenever it
        // re-fits the map to the places it has loaded. Once that happens, every
        // further page of results describes a different area than the cell, and
        // the batch would be attributed to a cell it does not belong to. The
        // camera is the only thing an injected script can read, so it is the
        // only honest drift signal available.
        drifted: function () {
            if (this.tileLat === null || this.tileLng === null || !(this.maxDriftKm > 0)) {
                return false;
            }
            var view = parseMapView();
            if (!view) return false;
            var km = haversineKm(this.tileLat, this.tileLng, view.lat, view.lng);
            if (km <= this.maxDriftKm) return false;
            log('[Placemill] autoScroll: camera moved ' + km.toFixed(2) +
                ' km from the cell (allowed ' + this.maxDriftKm.toFixed(2) + ' km), stopping');
            return true;
        },

        // Perform a single scroll
        doScroll: function () {
            if (!this.running) return;

            if (this.drifted()) {
                this.stop('drift');
                return;
            }

            var container = this.containerCache || this.findContainer();
            this.containerCache = container;

            if (!container) {
                // An area with no results never renders a feed. Retrying forever
                // would burn the whole per-tile budget (90 s) on an empty cell, so
                // five misses is "this cell has nothing" — the grid runner treats
                // `no-results` as a finished cell, not a failure.
                this.containerMisses++;
                if (this.containerMisses >= 5) {
                    log('[Placemill] autoScroll: no result list after ' + this.containerMisses + ' tries, ending this cell');
                    this.stop('no-results');
                    return;
                }
                log('[Placemill] autoScroll: container not found, retrying in 3s...');
                this.timer = setTimeout(this.doScroll.bind(this), 3000);
                return;
            }
            this.containerMisses = 0;

            var prevHeight = this.lastContainerHeight;
            var currentHeight = container.scrollHeight;

            this.humanScroll(container);
            this.scrollCount++;
            this.lastContainerHeight = currentHeight;

            // Check whether new data was loaded
            if (currentHeight === prevHeight && this.scrollCount > 3) {
                this.noChangeCount++;
                log('[Placemill] autoScroll #' + this.scrollCount +
                    ' | no new data (x' + this.noChangeCount + ') | height=' + currentHeight);
            } else {
                this.noChangeCount = 0;
                log('[Placemill] autoScroll #' + this.scrollCount +
                    ' | height: ' + prevHeight + ' -> ' + currentHeight);
            }

            // Stop condition: no new data for several consecutive rounds
            if (this.noChangeCount >= this.maxNoChange) {
                log('[Placemill] autoScroll: no new data, stopping (total ' + this.scrollCount + ' scrolls)');
                this.stop('idle');
                return;
            }

            // Stop condition: reached the maximum number of scrolls
            if (this.scrollCount >= this.maxScrolls) {
                log('[Placemill] autoScroll: reached max scrolls (' + this.maxScrolls + '), stopping');
                this.stop('max-scrolls');
                return;
            }

            // Continue after a random delay inside [minDelay, maxDelay]. Turning
            // jitter off pins it to minDelay; that is a debug-only mode because a
            // fixed cadence is much easier to fingerprint.
            var delay = this.jitter
                ? this.minDelay + Math.random() * (this.maxDelay - this.minDelay)
                : this.minDelay;
            delay = Math.round(delay);
            log('[Placemill] autoScroll: next scroll in ' + (delay / 1000).toFixed(1) + 's');
            this.timer = setTimeout(this.doScroll.bind(this), delay);
        },

        start: function () {
            if (this.running) {
                log('[Placemill] autoScroll already running');
                return;
            }
            this.running = true;
            this.scrollCount = 0;
            this.lastContainerHeight = 0;
            this.noChangeCount = 0;
            this.containerMisses = 0;
            this.containerCache = null;
            // Bind the identity for the whole run: this document cannot know
            // which cell replaces it later, and must not pretend it does.
            this.jobId = currentTileField('jobId');
            this.tileId = currentTileField('tileId');

            // Per-cell budget and geometry, written by the grid runner right
            // before it navigated here. The scroll budget follows the job
            // radius (a 1.5 km cell has no use for 80 scrolls, and the extra
            // ones are exactly what walks the feed out of the area), and the
            // cell centre is what the drift check compares against.
            var tileCtx = readTileContext() || {};
            this.maxScrolls = this.baseMaxScrolls;
            var ctxMaxScrolls = _num(tileCtx.maxScrolls, 0);
            if (ctxMaxScrolls > 0) {
                this.maxScrolls = Math.min(this.maxScrolls, ctxMaxScrolls);
            }
            this.tileLat = _num(tileCtx.lat, null);
            this.tileLng = _num(tileCtx.lng, null);
            this.maxDriftKm = _num(tileCtx.maxDriftKm, 0);

            log('[Placemill] ===== autoScroll STARTED =====');
            log('[Placemill] autoScroll: max=' + this.maxScrolls +
                ', delay=' + (this.minDelay / 1000) + '-' + (this.maxDelay / 1000) + 's');

            // The scheduler waits for this before it starts its own watchdog: a
            // cell that never reports a start means the script did not run.
            emitEvent('collector:scroll-start', {
                maxScrolls: this.maxScrolls,
                minDelay: this.minDelay,
                maxDelay: this.maxDelay,
                jobId: this.jobId,
                tileId: this.tileId,
                url: location.href
            });

            // Wait 2-3s before the first scroll
            var initialDelay = 2000 + Math.random() * 1000;
            this.timer = setTimeout(this.doScroll.bind(this), initialDelay);
        },

        // `reason` is part of the contract with the scheduler: only 'idle' and
        // 'max-scrolls' mean "this grid cell is finished". 'navigate' fires
        // before every restart (the search handler stops then starts), and
        // 'manual' covers the user / Rust toggling the switch — neither may
        // close a cell.
        stop: function (reason) {
            var wasRunning = this.running;
            var scrolls = this.scrollCount;
            var idleRounds = this.noChangeCount;

            this.running = false;
            if (this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            log('[Placemill] ===== autoScroll STOPPED (total: ' + scrolls + ' scrolls) =====');

            if (wasRunning) {
                emitEvent('collector:scroll-idle', {
                    reason: reason || 'manual',
                    scrolls: scrolls,
                    idleRounds: idleRounds,
                    // Identity captured at start(), not read now: an event from
                    // the previous cell must not close the tile that is
                    // currently loading.
                    jobId: this.jobId,
                    tileId: this.tileId,
                    url: location.href
                });
            }
        },

        status: function () {
            log('[Placemill] autoScroll status:', JSON.stringify({
                running: this.running,
                scrollCount: this.scrollCount,
                noChangeCount: this.noChangeCount,
                lastContainerHeight: this.lastContainerHeight
            }));
        }
    };

    // Expose globally (read-only binding; the object's own state stays live)
    defineEntryPoint('__placemillAutoScroll', autoScroll);

    // ===== No boot-time auto-resume =====
    // There used to be a 4 s timer here that restarted scrolling whenever the
    // localStorage mirror said '1'. That mirror survives app restarts, so a
    // crashed job came back as a scrolling page with no runner behind it, and
    // every page load raced the timer against whatever Rust wanted. Rust now
    // starts the loop from `collector_settings_script` on each document, so the
    // timer is gone on purpose: see `apply_listening` / `on_page_load`.
    log('[Placemill] autoScroll module loaded. Manual: __placemillAutoScroll.start() / .stop() / .status()');

    // ===== Navigation detection: restart scrolling on a new search, only while enabled =====
    (function () {
        var navDebounceTimer = null;
        var NAV_DEBOUNCE = 1500; // 1.5s debounce so consecutive pushState calls restart only once
        var viewTimer = null;
        var lastSearchKey = '';

        // Google rewrites the URL while the result list scrolls (it appends
        // `data=!4m...`), and every rewrite used to look like "a new search":
        // stop -> restart, scroll counter reset, never reaching the idle rounds.
        // A grid tile then timed out and was marked failed even though it had
        // already collected 120 rows. Only a change of query or camera is a new
        // search; a rewrite of the same one is not.
        function searchSignature() {
            var match = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/.exec(location.href);
            var camera = match ? match[1] + ',' + match[2] + ',' + match[3] : '';
            return queryFromUrl(location.href) + '|' + camera;
        }

        // Panning rewrites the URL through replaceState very often; report the
        // settled camera once per burst instead of on every call.
        function reportViewSoon() {
            if (viewTimer) clearTimeout(viewTimer);
            viewTimer = setTimeout(function () {
                if (window.__placemillReportView) window.__placemillReportView();
            }, 1200);
        }

        // A page that was already on a search when the script loaded still has to
        // tell Rust where the map is: the grid dialog seeds its centre from here.
        setTimeout(reportViewSoon, 2500);

        function onSearchNavigate() {
            var url = location.href;
            var isSearch = /search\?/i.test(url) || location.pathname.includes('/search');
            if (!isSearch) return;

            var key = searchSignature();
            if (key === lastSearchKey) return; // same search, URL rewrite only
            lastSearchKey = key;

            if (!window.__placemillEnabled) {
                log('[Placemill] autoScroll: new search detected, but disabled — skipping');
                return;
            }

            // Debounce: several navigations in a short window restart only once
            if (navDebounceTimer) clearTimeout(navDebounceTimer);
            navDebounceTimer = setTimeout(function () {
                if (!window.__placemillEnabled) return;
                log('[Placemill] autoScroll: new search detected, restarting...');
                autoScroll.stop('navigate');
                // Wait 3-5s for the search results to load
                var waitTime = 3000 + Math.random() * 2000;
                setTimeout(function () {
                    if (window.__placemillEnabled) {
                        autoScroll.start();
                    }
                }, waitTime);
            }, NAV_DEBOUNCE);
        }

        // Hook pushState
        var origPushState = history.pushState;
        history.pushState = function () {
            origPushState.apply(this, arguments);
            onSearchNavigate();
            reportViewSoon();
        };

        // Hook replaceState
        var origReplaceState = history.replaceState;
        history.replaceState = function () {
            origReplaceState.apply(this, arguments);
            onSearchNavigate();
            reportViewSoon();
        };

        // Listen for browser back/forward navigation
        window.addEventListener('popstate', function () {
            onSearchNavigate();
            reportViewSoon();
        });
    })();

    // ============================================================
    // 7. Settings pushed from Rust (eval after every page load)
    //
    // Mirrored into localStorage so a reload or a new search keeps them before
    // Rust gets a chance to push again.
    // ============================================================
    defineEntryPoint('__placemillApplySettings', function (next) {
        if (!next || typeof next !== 'object') return;
        window.__placemillSettings = next;
        // M5: a validated remote field map rides along with the settings. A
        // payload without one (fetch failed, degraded) leaves the current map —
        // built-in or the last good mirror — untouched.
        if (next.fieldMap !== undefined) {
            applyFieldMap(next.fieldMap, next.fieldMapVersion);
        }
        try {
            localStorage.setItem('placemill.settings', JSON.stringify(next));
        } catch (e) {
            /* storage can be unavailable; the in-memory copy is still updated */
        }
        if (window.__placemillAutoScroll) {
            window.__placemillAutoScroll.configure({
                minDelay: next.scrollMinMs,
                maxDelay: next.scrollMaxMs,
                maxScrolls: next.maxScrolls,
                maxNoChange: next.stopAfterIdle,
                jitter: next.jitter
            });
        }
        setLogLevel(next.logLevel);
        log('[Placemill] settings applied: ' + JSON.stringify(next));
    });
})();

console.log('[Placemill] ' + VERSION + ' injection complete');
if (DEBUG_BUILD) {
    console.log('[Placemill] Tips: run __placemillDiag() to diagnose, __placemillTest() to test IPC');
}
})();
