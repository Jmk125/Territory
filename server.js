require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Datastore = require('nedb');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3080;

// Databases
const db = {
  locationTypes: new Datastore({ filename: path.join(__dirname, 'data/locationTypes.db'), autoload: true }),
  locations: new Datastore({ filename: path.join(__dirname, 'data/locations.db'), autoload: true }),
  // Persistent cache of computed isochrones so we only call the ORS key once
  // per unique coordinate+range instead of on every map render.
  isochroneCache: new Datastore({ filename: path.join(__dirname, 'data/isochroneCache.db'), autoload: true }),
  // Cache of driving durations (source→destination) to avoid repeat key calls.
  travelCache: new Datastore({ filename: path.join(__dirname, 'data/travelCache.db'), autoload: true }),
  // Runtime ORS settings chosen from the UI (which server to call, range limit).
  settings: new Datastore({ filename: path.join(__dirname, 'data/settings.db'), autoload: true }),
  mapTabs: new Datastore({ filename: path.join(__dirname, 'data/mapTabs.db'), autoload: true })
};

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Seed the default map tab if it doesn't exist
db.mapTabs.findOne({ _id: 'default' }, (err, doc) => {
  if (!doc) db.mapTabs.insert({ _id: 'default', name: 'Default', isDefault: true, order: 0, createdAt: Date.now() });
});

// ─── Config endpoint ───────────────────────────────────────────────
// SPLASH_COLOR presets: red (default), mgs (Metal Gear Solid green), blue
const SPLASH_PRESETS = {
  red:  { main: '#c0392b', dark: '#922b21', glow: 'rgba(192,57,43,0.8)', glowFar: 'rgba(192,57,43,0.4)', faint: 'rgba(192,57,43,0.4)', fainter: 'rgba(192,57,43,0.6)' },
  mgs:  { main: '#39ff6a', dark: '#1a7a35', glow: 'rgba(57,255,106,0.8)', glowFar: 'rgba(57,255,106,0.3)', faint: 'rgba(57,255,106,0.4)', fainter: 'rgba(57,255,106,0.6)' },
  blue: { main: '#3ea8e5', dark: '#1a5f8a', glow: 'rgba(62,168,229,0.8)', glowFar: 'rgba(62,168,229,0.3)', faint: 'rgba(62,168,229,0.4)', fainter: 'rgba(62,168,229,0.6)' },
};
app.get('/api/config', (req, res) => {
  const colorKey = (process.env.SPLASH_COLOR || 'red').toLowerCase();
  const splashColor = SPLASH_PRESETS[colorKey] || SPLASH_PRESETS.red;
  res.json({
    showSplash: process.env.SHOW_SPLASH !== 'false',
    hasOrsKey: !!(process.env.ORS_API_KEY && process.env.ORS_API_KEY.trim()),
    splashColor
  });
});

// ─── Location Types ────────────────────────────────────────────────
// Per-type bubble drawing style. Stored on the type so coverage shapes for
// every location of that type render consistently across all view modes.
const LINE_STYLES = ['solid', 'dashed', 'dotted', 'dashdot'];
const FILL_PATTERNS = ['solid', 'none', 'stripes', 'crosshatch', 'dots', 'grid'];
const TYPE_STYLE_DEFAULTS = { lineWeight: 2, lineStyle: 'solid', lineOpacity: 0.8, fillPattern: 'solid', fillOpacity: 0.28 };

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// Pull only the recognised style fields from a request body, coercing/validating
// each one. Returns just the keys that were actually supplied so PUT can patch
// without wiping fields the caller didn't send.
function sanitizeTypeStyle(b) {
  const out = {};
  if (b.lineWeight != null)  out.lineWeight  = clampNum(b.lineWeight, 0, 12, TYPE_STYLE_DEFAULTS.lineWeight);
  if (b.lineStyle != null)   out.lineStyle   = LINE_STYLES.includes(b.lineStyle) ? b.lineStyle : TYPE_STYLE_DEFAULTS.lineStyle;
  if (b.lineOpacity != null) out.lineOpacity = clampNum(b.lineOpacity, 0, 1, TYPE_STYLE_DEFAULTS.lineOpacity);
  if (b.fillPattern != null) out.fillPattern = FILL_PATTERNS.includes(b.fillPattern) ? b.fillPattern : TYPE_STYLE_DEFAULTS.fillPattern;
  if (b.fillOpacity != null) out.fillOpacity = clampNum(b.fillOpacity, 0, 1, TYPE_STYLE_DEFAULTS.fillOpacity);
  return out;
}

app.get('/api/location-types', (req, res) => {
  db.locationTypes.find({}).sort({ createdAt: 1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs);
  });
});

app.post('/api/location-types', (req, res) => {
  const { name, color, defaultRadius, defaultRadiusUnit, layerKind, tabIds,
          geojsonData, colorByField, colorScaleLow, colorScaleHigh,
          tooltipNameField, tooltipFields } = req.body;
  if (!name || !color) return res.status(400).json({ error: 'name and color required' });
  const kind = layerKind === 'boundary' ? 'boundary' : 'isochrone';
  const doc = { name, color, layerKind: kind,
    tabIds: Array.isArray(tabIds) ? tabIds : ['default'],
    defaultRadius: defaultRadius || 60, defaultRadiusUnit: defaultRadiusUnit || 'minutes',
    ...TYPE_STYLE_DEFAULTS, ...sanitizeTypeStyle(req.body), createdAt: Date.now() };
  if (kind === 'boundary') {
    doc.geojsonData = geojsonData || null;
    doc.colorByField = colorByField || '';
    doc.colorScaleLow = colorScaleLow || '#ffffcc';
    doc.colorScaleHigh = colorScaleHigh || '#800026';
    doc.tooltipNameField = tooltipNameField || '';
    doc.tooltipFields = Array.isArray(tooltipFields) ? tooltipFields : [];
  }
  db.locationTypes.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(newDoc);
  });
});

app.put('/api/location-types/:id', (req, res) => {
  const { name, color, defaultRadius, defaultRadiusUnit, tabIds,
          geojsonData, colorByField, colorScaleLow, colorScaleHigh } = req.body;
  const set = { name, color, defaultRadius, defaultRadiusUnit, ...sanitizeTypeStyle(req.body) };
  if (tabIds !== undefined) set.tabIds = Array.isArray(tabIds) ? tabIds : ['default'];
  if (geojsonData !== undefined) set.geojsonData = geojsonData;
  if (colorByField !== undefined) set.colorByField = colorByField;
  if (colorScaleLow !== undefined) set.colorScaleLow = colorScaleLow;
  if (colorScaleHigh !== undefined) set.colorScaleHigh = colorScaleHigh;
  if (req.body.tooltipNameField !== undefined) set.tooltipNameField = req.body.tooltipNameField;
  if (req.body.tooltipFields !== undefined) set.tooltipFields = Array.isArray(req.body.tooltipFields) ? req.body.tooltipFields : [];
  db.locationTypes.update({ _id: req.params.id }, { $set: set }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.locationTypes.findOne({ _id: req.params.id }, (err2, doc) => res.json(doc));
  });
});

app.delete('/api/location-types/:id', (req, res) => {
  db.locationTypes.remove({ _id: req.params.id }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    // Also remove all locations of this type
    db.locations.remove({ typeId: req.params.id }, { multi: true }, () => {
      res.json({ success: true });
    });
  });
});

// ─── Locations ─────────────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
  const query = req.query.typeId ? { typeId: req.query.typeId } : {};
  db.locations.find(query).sort({ createdAt: 1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs);
  });
});

app.post('/api/locations', (req, res) => {
  const { name, typeId, address, lat, lng, customRadius, customRadiusUnit } = req.body;
  if (!name || !typeId || !lat || !lng) return res.status(400).json({ error: 'name, typeId, lat, lng required' });
  const doc = { name, typeId, address: address || '', lat, lng, customRadius: customRadius || null, customRadiusUnit: customRadiusUnit || null, createdAt: Date.now() };
  db.locations.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(newDoc);
  });
});

app.put('/api/locations/:id', (req, res) => {
  const { name, address, lat, lng, customRadius, customRadiusUnit, typeId } = req.body;
  const set = { name, address, lat, lng, customRadius, customRadiusUnit };
  if (typeId) set.typeId = typeId; // allow reassigning a location to another type
  db.locations.update({ _id: req.params.id }, { $set: set }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.locations.findOne({ _id: req.params.id }, (err2, doc) => res.json(doc));
  });
});

app.delete('/api/locations/:id', (req, res) => {
  db.locations.remove({ _id: req.params.id }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ─── Geocoding proxy ───────────────────────────────────────────────
// Recognise a raw "lat, lng" (or "lat lng") pair — e.g. coordinates copied
// from Google Maps — so the caller can resolve them without a lookup.
function parseLatLng(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'query required' });

  // Pasted coordinates resolve directly — skip the address lookup entirely.
  const coords = parseLatLng(q);
  if (coords) {
    return res.json([{ display_name: `📍 ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`, lat: coords.lat, lng: coords.lng }]);
  }

  const lookup = async (extra) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&dedupe=1&limit=8&q=${encodeURIComponent(q)}${extra}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'ProjectSecretWishes/1.0' } });
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  };

  try {
    // Prefer US results, but broaden the search if the restricted query finds
    // nothing — many specific addresses only surface without the country filter.
    let data = await lookup('&countrycodes=us');
    if (!data.length) data = await lookup('');
    res.json(data.map(d => ({ display_name: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ORS source settings (chosen from the Configure tab) ───────────
// The user picks where isochrones/travel times come from at runtime:
//   • 'api'        → the public ORS API, using the key in .env. The public
//                    service hard-caps isochrones at 60 min, so longer ranges
//                    are approximated (the capped shape is padded outward).
//   • 'selfhosted' → their own ORS instance on the network, with a range limit
//                    they configure to match its maximum_range_time. Ranges
//                    above that limit are approximated the same way.
// Settings persist in data/settings.db so they survive restarts.
const ORS_PUBLIC_URL = 'https://api.openrouteservice.org';
const ORS_DEFAULT_MAX_MINUTES = 60;   // public ORS API hard cap
const ORS_SETTINGS_KEY = 'ors';
// How long to wait on an ORS request before giving up. Large self-hosted
// isochrones (e.g. 90+ min, fastisochrones disabled) can take a while to
// compute, so this is generous — a genuinely unreachable host fails fast with
// a connection error long before this fires. Override with ORS_TIMEOUT_MS.
const ORS_TIMEOUT_MS = parseInt(process.env.ORS_TIMEOUT_MS, 10) || 120000;

// Until the user saves a choice from the UI, fall back to the legacy .env vars
// (ORS_BASE_URL / ORS_MAX_RANGE_SEC) so existing deployments keep working
// unchanged. Once they save from the Configure tab, the stored doc wins.
function envSeedSettings() {
  const envUrl = normalizeOrsUrl(process.env.ORS_BASE_URL || '');
  const isSelf = envUrl && !/(^|\.)openrouteservice\.org/i.test(envUrl);
  const envMaxSec = parseInt(process.env.ORS_MAX_RANGE_SEC, 10);
  const envMaxMin = envMaxSec > 0 ? Math.round(envMaxSec / 60) : ORS_DEFAULT_MAX_MINUTES;
  return isSelf
    ? { mode: 'selfhosted', selfHostedUrl: envUrl, maxRangeMinutes: envMaxMin }
    : { mode: 'api', selfHostedUrl: '', maxRangeMinutes: ORS_DEFAULT_MAX_MINUTES };
}

function getOrsSettings() {
  return new Promise(resolve => db.settings.findOne({ key: ORS_SETTINGS_KEY }, (err, doc) => {
    if (!doc) return resolve(envSeedSettings());
    const max = Number(doc.maxRangeMinutes);
    resolve({
      mode: doc.mode === 'selfhosted' ? 'selfhosted' : 'api',
      selfHostedUrl: doc.selfHostedUrl || '',
      maxRangeMinutes: max > 0 ? max : ORS_DEFAULT_MAX_MINUTES
    });
  }));
}

// fetch with an abort timeout so a slow/unreachable ORS server (e.g. a wrong
// self-hosted IP) fails fast and falls back to circles/estimates instead of
// hanging every coverage request.
async function fetchWithTimeout(url, opts = {}, ms = ORS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Accept either a full URL or a bare host[:port] and return a clean ORS base
// URL (scheme + /ors context path, no trailing slash), or '' if unparseable.
function normalizeOrsUrl(input) {
  if (!input || !String(input).trim()) return '';
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return ''; }
  if (!u.pathname || u.pathname === '/') u.pathname = '/ors';
  return u.toString().replace(/\/+$/, '');
}

// Resolve the active settings into a concrete request target: which base URL to
// hit, what auth header to send, the effective range cap, and whether ORS is
// actually usable (else callers fall back to circles/straight-line estimates).
function resolveOrsTarget(settings) {
  const envKey = (process.env.ORS_API_KEY || '').trim();
  if (settings.mode === 'selfhosted' && settings.selfHostedUrl) {
    return {
      source: settings.selfHostedUrl,
      baseUrl: settings.selfHostedUrl,
      authHeader: envKey || 'local',      // self-hosted ORS ignores auth
      maxRangeSec: settings.maxRangeMinutes * 60,
      usable: true
    };
  }
  // Public API mode — hard-capped at 60 min regardless of the stored value.
  return {
    source: 'api',
    baseUrl: ORS_PUBLIC_URL,
    authHeader: envKey,
    maxRangeSec: Math.min(settings.maxRangeMinutes, ORS_DEFAULT_MAX_MINUTES) * 60,
    usable: !!envKey
  };
}

// ─── Isochrone proxy (with persistent cache) ───────────────────────
// A given coordinate + range always produces the same isochrone, so once
// we've fetched it we store the geometry and serve every later request from
// the local cache. This means ORS is only hit the first time a new
// location/range combo appears — not on every coverage re-render.
//
// We cache the RAW capped isochrone (keyed by source + capped minutes), and the
// browser pads it outward by any leftover minutes (extendMinutes) with
// turf.buffer. Caching the capped shape lets several requested ranges that
// share the same cap reuse one ORS call. Cache key is versioned (v4) and
// includes the data source so switching servers/limits never serves a stale
// shape from the previous source.
// A true isochrone for a given coordinate + drive time is the same shape no
// matter which ORS engine computed it. The public API can only ever produce
// shapes up to its hard cap (ORS_DEFAULT_MAX_MINUTES), so for any range at or
// below that cap we file the entry under a single source-agnostic "shared"
// scope. That lets a coverage bubble generated on a self-hosted server be
// reused when the user later switches to the public API (and vice versa)
// instead of being recomputed — the whole point of the persistent cache.
//
// Above the cap only a self-hosted engine can produce a real shape, and two
// different self-hosted graphs could legitimately differ, so there we keep the
// source in the key to avoid one server serving another's shape.
const ISO_SHARED_SCOPE = 'shared';
function isoCacheScope(source, minutes) {
  return minutes <= ORS_DEFAULT_MAX_MINUTES ? ISO_SHARED_SCOPE : source;
}
function isoCacheKey(source, lat, lng, minutes) {
  return `v4:${isoCacheScope(source, minutes)}:${Number(lat).toFixed(5)},${Number(lng).toFixed(5)},${minutes}`;
}
// A geometry is only useful if it actually has coordinates to draw. A null or
// empty geometry can sneak into the cache when ORS returns a Feature with no
// geometry — and because the cache is persistent, one bad entry would otherwise
// be served forever, so a range that was poisoned during a past bug "never
// draws" even after the code is fixed. Validating here lets poisoned entries
// fall through and rebuild themselves.
function hasDrawableGeometry(g) {
  if (!g) return false;
  if (g.type === 'FeatureCollection') return Array.isArray(g.features) && g.features.some(hasDrawableGeometry);
  const geom = g.type === 'Feature' ? g.geometry : g;
  return !!(geom && Array.isArray(geom.coordinates) && geom.coordinates.length);
}
function isoCacheGet(key) {
  return new Promise(resolve => db.isochroneCache.findOne({ key }, (err, doc) => resolve(err ? null : doc)));
}
function isoCacheSet(key, geojson) {
  db.isochroneCache.update({ key }, { key, geojson, createdAt: Date.now() }, { upsert: true });
}
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// Find a cached shape for this coordinate+range stored under ANY scope. Cache
// keys end in ":<lat>,<lng>,<minutes>", so a suffix match locates an entry no
// matter which source (or the shared scope) wrote it. Used only for ranges
// within the API cap, where every source's shape is interchangeable, so we can
// reuse e.g. a self-hosted entry while running against the public API — and
// pull forward older v-prefixed/per-source keys without a recompute.
function isoCacheGetBySuffix(lat, lng, minutes) {
  const suffix = `:${Number(lat).toFixed(5)},${Number(lng).toFixed(5)},${minutes}`;
  const re = new RegExp(escapeRegExp(suffix) + '$');
  return new Promise(resolve => db.isochroneCache.findOne({ key: re }, (err, doc) => resolve(err ? null : doc)));
}
// Resolve a usable cached geometry for source+coord+range, or null. Prefers an
// exact key hit; for shareable ranges it falls back to any-source match and
// migrates the result onto the canonical (shared) key so later lookups are
// direct hits.
async function isoCacheResolve(source, lat, lng, minutes) {
  const key = isoCacheKey(source, lat, lng, minutes);
  const exact = await isoCacheGet(key);
  if (exact && hasDrawableGeometry(exact.geojson)) return exact.geojson;
  if (minutes <= ORS_DEFAULT_MAX_MINUTES) {
    const any = await isoCacheGetBySuffix(lat, lng, minutes);
    if (any && hasDrawableGeometry(any.geojson)) {
      if (any.key !== key) isoCacheSet(key, any.geojson);  // migrate forward
      return any.geojson;
    }
  }
  return null;
}

// ─── ORS settings endpoints (read/save/test from the Configure tab) ──
app.get('/api/ors-settings', async (req, res) => {
  const s = await getOrsSettings();
  const target = resolveOrsTarget(s);
  res.json({
    mode: s.mode,
    selfHostedUrl: s.selfHostedUrl,
    maxRangeMinutes: s.maxRangeMinutes,
    hasApiKey: !!(process.env.ORS_API_KEY && process.env.ORS_API_KEY.trim()),
    effectiveMaxMinutes: target.maxRangeSec / 60,
    orsActive: target.usable,
    defaultApiMaxMinutes: ORS_DEFAULT_MAX_MINUTES
  });
});

app.post('/api/ors-settings', (req, res) => {
  const mode = req.body.mode === 'selfhosted' ? 'selfhosted' : 'api';
  const selfHostedUrl = mode === 'selfhosted' ? normalizeOrsUrl(req.body.selfHostedUrl) : '';
  let maxRangeMinutes = parseInt(req.body.maxRangeMinutes, 10);
  if (!(maxRangeMinutes > 0)) maxRangeMinutes = ORS_DEFAULT_MAX_MINUTES;
  if (mode === 'api') maxRangeMinutes = ORS_DEFAULT_MAX_MINUTES;   // public API cap
  maxRangeMinutes = Math.min(maxRangeMinutes, 600);                // sanity ceiling (10h)
  const doc = { key: ORS_SETTINGS_KEY, mode, selfHostedUrl, maxRangeMinutes, updatedAt: Date.now() };
  db.settings.update({ key: ORS_SETTINGS_KEY }, doc, { upsert: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, mode, selfHostedUrl, maxRangeMinutes });
  });
});

// Probe an ORS server's health endpoint so the UI can confirm a good
// connection before the user commits to using it.
app.post('/api/ors-test', async (req, res) => {
  const baseUrl = normalizeOrsUrl(req.body.url);
  if (!baseUrl) return res.json({ ok: false, message: 'Enter a valid server address.' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const r = await fetch(`${baseUrl}/v2/health`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => ({}));
    if (r.ok && (!data.status || data.status === 'ready')) {
      return res.json({ ok: true, normalizedUrl: baseUrl, message: `Connected to ${baseUrl}` });
    }
    return res.json({ ok: false, normalizedUrl: baseUrl, message: `Server reachable but not ready (HTTP ${r.status}${data.status ? `, status: ${data.status}` : ''})` });
  } catch (e) {
    clearTimeout(timer);
    const why = e.name === 'AbortError' ? 'timed out' : e.message;
    return res.json({ ok: false, normalizedUrl: baseUrl, message: `Could not reach ${baseUrl} (${why})` });
  }
});

// ─── Isochrone proxy ───────────────────────────────────────────────
app.post('/api/isochrone', async (req, res) => {
  const { lat, lng, minutes, force } = req.body;
  const settings = await getOrsSettings();
  const target = resolveOrsTarget(settings);

  // Cap the range at the source's limit; the browser pads the leftover minutes.
  const cappedMin = Math.min(minutes, target.maxRangeSec / 60);
  const rangeSec = cappedMin * 60;
  const extendMinutes = Math.max(0, minutes - cappedMin);
  const rawKey = isoCacheKey(target.source, lat, lng, cappedMin);

  // 1. Serve the capped isochrone straight from cache when possible. For ranges
  //    within the API cap this also reuses a shape cached under another source
  //    (e.g. one generated on a self-hosted server while now on the API).
  if (!force) {
    const cachedGeo = await isoCacheResolve(target.source, lat, lng, cappedMin);
    if (cachedGeo) {
      return res.json({ type: 'isochrone', geojson: cachedGeo, extendMinutes, cached: true });
    }
  }

  if (!target.usable) {
    return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes) });
  }

  try {
    // 2. Fetch the capped isochrone from the active ORS source. If it can't
    //    honor the range, fall back to a circle and log why.
    const r = await fetchWithTimeout(`${target.baseUrl}/v2/isochrones/driving-car`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': target.authHeader },
      body: JSON.stringify({ locations: [[lng, lat]], range: [rangeSec], range_type: 'time' })
    });
    const data = await r.json();
    if (data.error || !data.features) {
      const reason = data.error ? (data.error.message || JSON.stringify(data.error)) : 'no features returned';
      console.warn(`ORS isochrone fell back to circle (range=${rangeSec}s, HTTP ${r.status}): ${reason}`);
      return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes), reason });
    }
    const feature = data.features[0];
    // Never persist a shape we can't draw — that would poison the cache.
    if (hasDrawableGeometry(feature)) isoCacheSet(rawKey, feature);
    res.json({ type: 'isochrone', geojson: feature, extendMinutes, cached: false });
  } catch (e) {
    console.warn(`ORS isochrone request failed (range=${rangeSec}s): ${e.message}`);
    res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes), reason: e.message });
  }
});

// ─── Travel times (driving duration from each source → one destination) ──
// Uses the ORS Matrix API: one key call covers every source at once. Falls
// back to a straight-line estimate when no key is configured. Real (routed)
// results are cached per source→destination pair; estimates are never cached
// so they upgrade automatically once a key is added.
function travelKey(f, t) {
  return `${Number(f.lat).toFixed(5)},${Number(f.lng).toFixed(5)}->${Number(t.lat).toFixed(5)},${Number(t.lng).toFixed(5)}`;
}

function haversineMeters(a, b) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

app.post('/api/travel-times', async (req, res) => {
  const { from, to } = req.body;
  if (!Array.isArray(from) || !to) return res.status(400).json({ error: 'from[] and to required' });
  const target = resolveOrsTarget(await getOrsSettings());

  const results = new Array(from.length).fill(null);
  const misses = [];

  // Serve cached pairs first
  await Promise.all(from.map((f, i) => new Promise(resolve => {
    db.travelCache.findOne({ key: travelKey(f, to) }, (err, doc) => {
      if (doc && typeof doc.seconds === 'number') results[i] = { seconds: doc.seconds, estimated: false };
      else misses.push(i);
      resolve();
    });
  })));

  if (misses.length) {
    const computed = {};
    if (target.usable) {
      try {
        const locations = misses.map(i => [from[i].lng, from[i].lat]);
        locations.push([to.lng, to.lat]);
        const r = await fetchWithTimeout(`${target.baseUrl}/v2/matrix/driving-car`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': target.authHeader },
          body: JSON.stringify({ locations, sources: misses.map((_, k) => k), destinations: [misses.length], metrics: ['duration'] })
        });
        const data = await r.json();
        if (data && data.durations) {
          misses.forEach((idx, k) => {
            const sec = data.durations[k] ? data.durations[k][0] : null;
            if (sec != null) computed[idx] = { seconds: Math.round(sec), estimated: false };
          });
        }
      } catch (e) { /* fall through to estimate */ }
    }
    misses.forEach(idx => {
      if (!computed[idx]) {
        const meters = haversineMeters(from[idx], to);
        computed[idx] = { seconds: Math.round(meters / 1340 * 60), estimated: true };
      }
      results[idx] = computed[idx];
      if (!computed[idx].estimated) {
        const key = travelKey(from[idx], to);
        db.travelCache.update({ key }, { key, seconds: computed[idx].seconds, createdAt: Date.now() }, { upsert: true });
      }
    });
  }

  res.json({ times: results });
});

// average driving speed ~50mph = ~1340 meters/minute
function minutesToMeters(minutes) {
  return Math.round(minutes * 1340);
}

// ─── Map Tabs ─────────────────────────────────────────────────────
app.get('/api/map-tabs', (req, res) => {
  db.mapTabs.find({}).sort({ order: 1, createdAt: 1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!docs.length) docs = [{ _id: 'default', name: 'Default', isDefault: true, order: 0 }];
    else if (!docs.some(d => d.isDefault)) {
      docs.unshift({ _id: 'default', name: 'Default', isDefault: true, order: 0 });
    }
    res.json(docs);
  });
});

app.post('/api/map-tabs', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const doc = { name: name.trim(), isDefault: false, order: Date.now(), createdAt: Date.now() };
  db.mapTabs.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(newDoc);
  });
});

app.put('/api/map-tabs/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  db.mapTabs.update({ _id: req.params.id, isDefault: { $ne: true } }, { $set: { name: name.trim() } }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.mapTabs.findOne({ _id: req.params.id }, (err2, doc) => res.json(doc));
  });
});

app.delete('/api/map-tabs/:id', (req, res) => {
  db.mapTabs.findOne({ _id: req.params.id }, (err, doc) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!doc || doc.isDefault) return res.status(400).json({ error: 'Cannot delete default tab' });
    db.mapTabs.remove({ _id: req.params.id }, {}, (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      db.locationTypes.find({}, (err3, types) => {
        if (types) {
          types.forEach(t => {
            if (Array.isArray(t.tabIds) && t.tabIds.includes(req.params.id)) {
              const newTabIds = t.tabIds.filter(id => id !== req.params.id);
              if (!newTabIds.length) newTabIds.push('default');
              db.locationTypes.update({ _id: t._id }, { $set: { tabIds: newTabIds } });
            }
          });
        }
        res.json({ success: true });
      });
    });
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚨 PROJECT SECRET WISHES 🚨`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set PORT in ${path.join(__dirname, '.env')}.`);
  }
  throw err;
});
