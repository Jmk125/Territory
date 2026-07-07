require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Datastore = require('nedb');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const entityResolution = require('./lib/entityResolution');
const coverageDerivation = require('./lib/coverageDerivation');
const coverageDepthLib = require('./lib/coverageDepth');

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
  mapTabs: new Datastore({ filename: path.join(__dirname, 'data/mapTabs.db'), autoload: true }),
  // ── Bid-coverage analytics (Territory Phase 2) ──────────────────────
  // bidderName -> Territory location link, produced by the entity-resolution
  // cascade or confirmed/skipped by hand in the review panel.
  bidderLinks: new Datastore({ filename: path.join(__dirname, 'data/bidderLinks.db'), autoload: true }),
  // Geocoded project addresses, keyed by project name + address hash so a
  // changed address naturally invalidates the cached coordinates.
  projectLocations: new Datastore({ filename: path.join(__dirname, 'data/projectLocations.db'), autoload: true }),
  // Raw observations fetched from the Bid Database (single "latest" doc).
  // Territory never stores bid amounts beyond this fetched cache.
  bidObservationsCache: new Datastore({ filename: path.join(__dirname, 'data/bidObservationsCache.db'), autoload: true }),
  // Last-good derived coverage config (single "latest" doc).
  coverageConfig: new Datastore({ filename: path.join(__dirname, 'data/coverageConfig.db'), autoload: true }),
  // Manual per-bidder overrides; merged over auto-derived flags (manual wins).
  bidderOverrides: new Datastore({ filename: path.join(__dirname, 'data/bidderOverrides.db'), autoload: true }),
  // Precomputed H3 coverage-depth cells, cached per division+resolution.
  coverageDepthCache: new Datastore({ filename: path.join(__dirname, 'data/coverageDepthCache.db'), autoload: true }),
  // Manual display-name overrides for a CSI division (independent of any
  // Territory location-type naming).
  divisionOverrides: new Datastore({ filename: path.join(__dirname, 'data/divisionOverrides.db'), autoload: true }),
  // Forces a bidder's observations into a specific division, for cases where
  // the Bid Database's csi_division tag is wrong/too coarse for that bidder.
  bidderDivisionOverrides: new Datastore({ filename: path.join(__dirname, 'data/bidderDivisionOverrides.db'), autoload: true }),
  // Folds a duplicate bidder name (aliasName) into a canonical one — survives
  // future syncs even if the Bid Database still reports them separately.
  bidderAliases: new Datastore({ filename: path.join(__dirname, 'data/bidderAliases.db'), autoload: true })
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

// Custom filtering fields live in a flat { name: value } object of trimmed
// strings. Anything else (arrays, objects, blank keys) is dropped.
function cleanProps(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const out = {};
  for (const k of Object.keys(p)) {
    const key = String(k).trim();
    if (!key) continue;
    const v = p[k];
    if (v == null) continue;
    out[key] = String(v).trim();
  }
  return out;
}

app.post('/api/locations', (req, res) => {
  const { name, typeId, address, lat, lng, customRadius, customRadiusUnit } = req.body;
  if (!name || !typeId || !lat || !lng) return res.status(400).json({ error: 'name, typeId, lat, lng required' });
  const doc = { name, typeId, address: address || '', lat, lng, customRadius: customRadius || null, customRadiusUnit: customRadiusUnit || null, props: cleanProps(req.body.props), notes: req.body.notes ? String(req.body.notes) : '', createdAt: Date.now() };
  db.locations.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(newDoc);
  });
});

// Bulk create (used by the Configure tab's batch spreadsheet/CSV import). Each
// item needs name + typeId + finite lat/lng; anything missing those is skipped
// rather than failing the whole import.
app.post('/api/locations/bulk', (req, res) => {
  const list = Array.isArray(req.body.locations) ? req.body.locations : [];
  const now = Date.now();
  const docs = [];
  for (const it of list) {
    const lat = Number(it.lat), lng = Number(it.lng);
    if (!it.name || !it.typeId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    docs.push({
      name: String(it.name), typeId: it.typeId, address: it.address || '', lat, lng,
      customRadius: it.customRadius || null, customRadiusUnit: it.customRadiusUnit || null,
      props: cleanProps(it.props), notes: it.notes ? String(it.notes) : '', createdAt: now
    });
  }
  if (!docs.length) return res.json({ inserted: 0, skipped: list.length });
  db.locations.insert(docs, (err, newDocs) => {
    if (err) return res.status(500).json({ error: err.message });
    const inserted = Array.isArray(newDocs) ? newDocs.length : 1;
    res.json({ inserted, skipped: list.length - inserted });
  });
});

// Set one custom property on every location of a type (type-level bulk assign).
app.post('/api/locations/set-prop', (req, res) => {
  const typeId = req.body.typeId;
  const key = String(req.body.name || '').trim();
  if (!typeId || !key) return res.status(400).json({ error: 'typeId and name required' });
  const val = req.body.value == null ? '' : String(req.body.value).trim();
  const set = {}; set['props.' + key] = val;
  db.locations.update({ typeId }, { $set: set }, { multi: true }, (err, num) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: num });
  });
});

app.put('/api/locations/:id', (req, res) => {
  const { name, address, lat, lng, customRadius, customRadiusUnit, typeId } = req.body;
  const set = { name, address, lat, lng, customRadius, customRadiusUnit };
  if (typeId) set.typeId = typeId; // allow reassigning a location to another type
  if (req.body.props !== undefined) set.props = cleanProps(req.body.props);
  if (req.body.notes !== undefined) set.notes = req.body.notes ? String(req.body.notes) : '';
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

// Shared by the /api/geocode route and the project-address sync path (2b).
// Pasted "lat, lng" pairs resolve directly; otherwise queries Nominatim,
// preferring US results but broadening the search if that finds nothing.
async function geocodeAddress(q) {
  const coords = parseLatLng(q);
  if (coords) {
    return [{ display_name: `📍 ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`, lat: coords.lat, lng: coords.lng }];
  }
  const lookup = async (extra) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&dedupe=1&limit=8&q=${encodeURIComponent(q)}${extra}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'ProjectSecretWishes/1.0' } });
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  };
  let data = await lookup('&countrycodes=us');
  if (!data.length) data = await lookup('');
  return data.map(d => ({ display_name: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) }));
}

app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'query required' });
  try {
    res.json(await geocodeAddress(q));
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

// ─── Directions (turn-by-turn, with up to 3 alternative routes) ────────
// Proxies the ORS Directions API from one location → the pin, requesting a few
// alternative routes. Returns each route's geometry + step list (miles). Needs
// a usable ORS source — without one there's no routing engine, so we say so.
app.post('/api/directions', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to || from.lat == null || to.lat == null) {
    return res.status(400).json({ error: 'from and to required' });
  }
  const target = resolveOrsTarget(await getOrsSettings());
  if (!target.usable) {
    return res.json({ usable: false, routes: [], message: 'Turn-by-turn directions need an OpenRouteService source. Set one in ⚙ Map Data Source.' });
  }
  try {
    const r = await fetchWithTimeout(`${target.baseUrl}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': target.authHeader },
      body: JSON.stringify({
        coordinates: [[from.lng, from.lat], [to.lng, to.lat]],
        alternative_routes: { target_count: 3, weight_factor: 1.6, share_factor: 0.6 },
        instructions: true,
        units: 'mi'
      })
    });
    const data = await r.json();
    if (data.error || !Array.isArray(data.features)) {
      const reason = data.error ? (data.error.message || JSON.stringify(data.error)) : `HTTP ${r.status}`;
      return res.json({ usable: true, routes: [], message: `Could not compute a route (${reason}).` });
    }
    const routes = data.features.map(f => {
      const props = f.properties || {};
      const steps = (props.segments || []).flatMap(seg => seg.steps || []).map(st => ({
        instruction: st.instruction, distance: st.distance, name: st.name && st.name !== '-' ? st.name : ''
      }));
      return { summary: props.summary || {}, geometry: f.geometry, steps };
    });
    res.json({ usable: true, routes });
  } catch (e) {
    res.json({ usable: true, routes: [], message: `Routing request failed (${e.name === 'AbortError' ? 'timed out' : e.message}).` });
  }
});

// average driving speed ~50mph = ~1340 meters/minute
function minutesToMeters(minutes) {
  return Math.round(minutes * 1340);
}

// ═════════════════════════════════════════════════════════════════
// BID COVERAGE ANALYTICS (Territory Phase 2)
// ═════════════════════════════════════════════════════════════════
// Consumes GET /api/bid-observations from a separate Bid Database app
// (location-free bid facts), links bidders to Territory's own location
// records, geocodes project addresses, computes distances, and derives a
// self-updating coverage config + H3 depth layer. Bid Database stays the
// system of record for bid economics; Territory never stores bid amounts
// beyond the fetched observations cache, and never sends coordinates back.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }

// "04A Masonry" -> {division:'04', packageCode:'04A', tradeName:'Masonry'}
// "22 - Plumbing" -> {division:'22', packageCode:'22', tradeName:'Plumbing'}
function parseDivisionFromTypeName(name) {
  const m = String(name || '').trim().match(/^(\d{2})([A-Za-z]?)\s*[-–:]?\s*(.*)$/);
  if (!m) return null;
  return { division: m[1], packageCode: m[1] + (m[2] || ''), tradeName: m[3].trim() };
}

// ─── Bid Database connection settings ───────────────────────────────
const BIDDB_SETTINGS_KEY = 'bidDb';
const BID_SYNC_STALE_MS = 24 * 60 * 60 * 1000;

function getBidDbSettings() {
  return new Promise(resolve => db.settings.findOne({ key: BIDDB_SETTINGS_KEY }, (err, doc) => {
    resolve({
      baseUrl: (doc && doc.baseUrl) || (process.env.BID_DATABASE_URL || '').trim(),
      lastSyncAt: doc ? (doc.lastSyncAt || null) : null,
      lastSyncOk: doc ? (doc.lastSyncOk == null ? null : doc.lastSyncOk) : null,
      lastSyncMessage: doc ? (doc.lastSyncMessage || '') : ''
    });
  }));
}
function setBidDbSyncStatus({ ok, at, message }) {
  return new Promise(resolve => db.settings.update(
    { key: BIDDB_SETTINGS_KEY },
    { $set: { key: BIDDB_SETTINGS_KEY, lastSyncAt: at, lastSyncOk: ok, lastSyncMessage: message } },
    { upsert: true }, () => resolve()
  ));
}
app.get('/api/bid-db-settings', async (req, res) => { res.json(await getBidDbSettings()); });
app.post('/api/bid-db-settings', (req, res) => {
  const baseUrl = String(req.body.baseUrl || '').trim();
  db.settings.update({ key: BIDDB_SETTINGS_KEY }, { $set: { key: BIDDB_SETTINGS_KEY, baseUrl } }, { upsert: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, baseUrl });
  });
});

// ─── Bundled fallback config (schema contract + last-resort defaults) ──
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'data/division_coverage_config.default.json');
let BUNDLED_CONFIG = null;
try { BUNDLED_CONFIG = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8')); }
catch (e) { console.warn('Could not load bundled coverage config default:', e.message); }

function getCoverageConfigDoc() {
  return new Promise(resolve => db.coverageConfig.findOne({ _id: 'latest' }, (err, doc) => resolve(doc || null)));
}
app.get('/api/coverage-config', async (req, res) => {
  const doc = await getCoverageConfigDoc();
  if (doc && doc.config) return res.json({ config: doc.config, source: 'cached', generatedAt: (doc.config.meta && doc.config.meta.generated) || doc.savedAt });
  if (BUNDLED_CONFIG) return res.json({ config: BUNDLED_CONFIG, source: 'bundled', generatedAt: BUNDLED_CONFIG.meta && BUNDLED_CONFIG.meta.generated });
  res.status(503).json({ error: 'No coverage config available yet (no live data and no bundled default).' });
});

// ─── Observations cache ─────────────────────────────────────────────
function getCachedObservations() {
  return new Promise(resolve => db.bidObservationsCache.findOne({ _id: 'latest' }, (err, doc) => resolve(doc || null)));
}
function saveCachedObservations(payload) {
  return new Promise(resolve => db.bidObservationsCache.update(
    { _id: 'latest' },
    { _id: 'latest', generated: payload.generated, observations: payload.observations, fetchedAt: Date.now() },
    { upsert: true }, () => resolve()
  ));
}
async function fetchBidObservations(baseUrl) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/bid-observations`;
  const r = await fetchWithTimeout(url, {}, 20000);
  if (!r.ok) throw new Error(`Bid Database returned HTTP ${r.status}`);
  const data = await r.json();
  if (!data || !Array.isArray(data.observations)) throw new Error('Unexpected response shape from /api/bid-observations');
  return data;
}

// ─── Division / bidder-division manual overrides ────────────────────
// bidderName -> array of divisions (a bidder can legitimately bid across
// several trades — e.g. a combined masonry/concrete sub — so the override
// is a set, not a single replacement).
function getBidderDivisionOverrideMap() {
  return new Promise(resolve => db.bidderDivisionOverrides.find({}, (err, docs) => resolve(new Map((docs || []).map(d => [d.bidderName, Array.isArray(d.divisions) ? d.divisions : (d.division ? [d.division] : [])])))));
}
function getDivisionNameOverrideMap() {
  return new Promise(resolve => db.divisionOverrides.find({}, (err, docs) => resolve(new Map((docs || []).map(d => [d.division, d.name])))));
}
// aliasName -> canonicalName, flattened at write-time (see /api/bidders/merge)
// so this never needs to walk a chain — one lookup always resolves fully.
function getBidderAliasMap() {
  return new Promise(resolve => db.bidderAliases.find({}, (err, docs) => resolve(new Map((docs || []).map(d => [d.aliasName, d.canonicalName])))));
}

// The cached observations, with any manual bidder->division reassignment
// applied. This is the single point where that override takes effect, so
// every consumer (derivation, coverage-depth grouping, the link review list)
// stays consistent with each other.
const BID_RECENCY_KEY = 'bidRecency';
function getBidRecencyYears() {
  return new Promise(resolve => db.settings.findOne({ key: BID_RECENCY_KEY }, (err, doc) => resolve(doc && doc.years > 0 ? doc.years : null)));
}
app.get('/api/bid-recency', async (req, res) => { res.json({ years: await getBidRecencyYears() }); });
app.post('/api/bid-recency', async (req, res) => {
  const raw = req.body.years;
  const years = raw != null && raw !== '' && Number(raw) > 0 ? Number(raw) : null;
  db.settings.update({ key: BID_RECENCY_KEY }, { $set: { key: BID_RECENCY_KEY, years } }, { upsert: true }, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true, years });
  });
});

// The only judgment-call numbers in the whole derivation procedure — how far
// "at/below median" (competitive) and "unreliable insurance number" (outer)
// actually mean — exposed as a tunable setting instead of buried constants.
const DERIVATION_THRESHOLDS_KEY = 'derivationThresholds';
function getDerivationThresholds() {
  return new Promise(resolve => db.settings.findOne({ key: DERIVATION_THRESHOLDS_KEY }, (err, doc) => {
    const d = coverageDerivation.DEFAULT_THRESHOLDS;
    if (!doc) return resolve({ ...d });
    resolve({
      competitiveDevPct: Number.isFinite(doc.competitiveDevPct) ? doc.competitiveDevPct : d.competitiveDevPct,
      outerDevPct: Number.isFinite(doc.outerDevPct) ? doc.outerDevPct : d.outerDevPct,
      outerWinRate: Number.isFinite(doc.outerWinRate) ? doc.outerWinRate : d.outerWinRate
    });
  }));
}
app.get('/api/derivation-thresholds', async (req, res) => {
  const t = await getDerivationThresholds();
  res.json({ competitiveDevPct: t.competitiveDevPct, outerDevPct: t.outerDevPct, outerWinRatePct: Math.round(t.outerWinRate * 1000) / 10 });
});
app.post('/api/derivation-thresholds', async (req, res) => {
  const competitiveDevPct = Number(req.body.competitiveDevPct);
  const outerDevPct = Number(req.body.outerDevPct);
  const outerWinRatePct = Number(req.body.outerWinRatePct);
  if (![competitiveDevPct, outerDevPct, outerWinRatePct].every(Number.isFinite)) {
    return res.status(400).json({ error: 'competitiveDevPct, outerDevPct, and outerWinRatePct must all be numbers' });
  }
  const doc = { key: DERIVATION_THRESHOLDS_KEY, competitiveDevPct, outerDevPct, outerWinRate: outerWinRatePct / 100 };
  db.settings.update({ key: DERIVATION_THRESHOLDS_KEY }, { $set: doc }, { upsert: true }, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true, competitiveDevPct, outerDevPct, outerWinRatePct });
  });
});

async function getEffectiveObservations() {
  const cache = await getCachedObservations();
  if (!cache) return [];
  const aliasMap = await getBidderAliasMap();
  const overrides = await getBidderDivisionOverrideMap();
  const years = await getBidRecencyYears();
  const cutoff = years ? Date.now() - years * 365.25 * 24 * 3600 * 1000 : null;
  return cache.observations
    .filter(o => {
      if (!cutoff) return true;
      const t = o.project_date ? new Date(o.project_date).getTime() : NaN;
      return Number.isNaN(t) || t >= cutoff; // unparseable/missing date -> keep it, don't discard data we can't classify
    })
    .map(o => {
      // Merged bidders: rewrite to the canonical name before anything else
      // (division overrides, entity resolution, derivation) sees it, so a
      // merge sticks across syncs even if the Bid Database still reports
      // the two names separately.
      const canonical = aliasMap.get(o.bidder);
      return canonical ? { ...o, bidder: canonical } : o;
    })
    .flatMap(o => {
      const forced = overrides.get(o.bidder);
      if (!forced || !forced.length) return [o];
      // A bid counts toward every division the bidder is overridden into —
      // duplicate the observation per division rather than picking one.
      return forced.map(division => ({ ...o, csi_division: division }));
    });
}

// Re-run derivation off the current observations cache (if any) — used
// after any override change so the effect is visible immediately rather
// than waiting for the next Bid Database sync.
async function reDeriveIfPossible() {
  const cache = await getCachedObservations();
  if (!cache) return;
  const effective = await getEffectiveObservations();
  await runDerivation(effective).catch(e => console.warn('Re-derivation after override change failed:', e.message));
}

// Distinct bidders across the observation set, with aliases/bid counts/
// divisions merged — the unit the entity-resolution cascade operates on.
function distinctBidders(observations) {
  const map = new Map();
  for (const o of observations) {
    if (!o.bidder) continue;
    if (!map.has(o.bidder)) map.set(o.bidder, { bidderName: o.bidder, aliases: new Set(), bidCount: 0, divisions: new Set() });
    const e = map.get(o.bidder);
    (o.aliases || []).forEach(a => e.aliases.add(a));
    e.bidCount++;
    if (o.csi_division) e.divisions.add(o.csi_division);
  }
  return [...map.values()].map(e => ({ ...e, aliases: [...e.aliases], divisions: [...e.divisions] }));
}

// ─── 2a. Entity resolution (bidder <-> Territory location) ─────────
// Rule 1 (existing confirmed link) is enforced here: only bidders lacking a
// confirmed bidderLinks doc run the cascade. Exact/dba/prefix auto-confirm;
// fuzzy is stored as an unconfirmed suggestion; no match clears the doc to
// an explicit "unlinked" state so the review panel is a single query.
async function resolveBidderLinks(observations) {
  const bidders = distinctBidders(observations);
  const locations = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(docs || [])));
  const locIndex = entityResolution.buildLocationIndex(locations);

  for (const b of bidders) {
    const existing = await new Promise(resolve => db.bidderLinks.findOne({ bidderName: b.bidderName }, (err, doc) => resolve(doc)));
    if (existing && existing.confirmed) continue;
    const match = entityResolution.matchBidder(b.bidderName, b.aliases, locIndex);
    const doc = match
      ? { bidderName: b.bidderName, locationId: match.locationId, method: match.method, confirmed: match.confirmed, updatedAt: Date.now() }
      : { bidderName: b.bidderName, locationId: null, method: 'none', confirmed: false, updatedAt: Date.now() };
    await new Promise(resolve => db.bidderLinks.update({ bidderName: b.bidderName }, doc, { upsert: true }, () => resolve()));
  }
  return bidders;
}

async function countUnconfirmedBidders(observations) {
  const bidders = distinctBidders(observations);
  const links = await new Promise(resolve => db.bidderLinks.find({}, (err, docs) => resolve(new Map((docs || []).map(d => [d.bidderName, d])))));
  return bidders.filter(b => { const l = links.get(b.bidderName); return !l || !l.confirmed; }).length;
}

// Review panel: by default, every bidder without a confirmed link, sorted by
// bid volume so the highest-impact names surface first (acceptance: any
// bidder with >=4 bids must show up here — trivially true since nothing is
// filtered out). Pass ?all=true for the full roster (management view).
app.get('/api/bidder-links', async (req, res) => {
  const observations = await getEffectiveObservations();
  const bidders = distinctBidders(observations);
  const infoByName = new Map(bidders.map(b => [b.bidderName, { bidCount: b.bidCount, divisions: b.divisions, aliases: b.aliases }]));
  const divisionOverrides = await getBidderDivisionOverrideMap();
  const links = await new Promise((resolve, reject) => db.bidderLinks.find({}, (err, docs) => err ? reject(err) : resolve(docs)));
  const byName = new Map(links.map(l => [l.bidderName, l]));
  const names = new Set([...infoByName.keys(), ...byName.keys()]);

  let out = [...names].map(name => {
    const link = byName.get(name);
    const info = infoByName.get(name) || { bidCount: 0, divisions: [], aliases: [] };
    return {
      bidderName: name, bidCount: info.bidCount, divisions: info.divisions,
      divisionOverrides: divisionOverrides.get(name) || [],
      locationId: link ? link.locationId : null,
      method: link ? link.method : null,
      confirmed: link ? !!link.confirmed : false
    };
  }).sort((a, b) => b.bidCount - a.bidCount);
  if (req.query.all !== 'true') out = out.filter(b => !b.confirmed);

  // For anything still unconfirmed, surface the closest candidate + score
  // regardless of the auto-fuzzy threshold — so a human can eyeball a
  // near-miss ("Electrical" vs "Electric") and confirm it in one click
  // instead of hunting through the full location list.
  const SUGGESTION_FLOOR = 0.4; // below this, showing a "guess" would just mislead
  const unconfirmed = out.filter(b => !b.confirmed);
  if (unconfirmed.length) {
    const locations = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(docs || [])));
    const locIndex = entityResolution.buildLocationIndex(locations);
    for (const b of unconfirmed) {
      const info = infoByName.get(b.bidderName) || { aliases: [] };
      const candidate = entityResolution.findBestCandidate(b.bidderName, info.aliases, locIndex);
      if (candidate && candidate.ratio >= SUGGESTION_FLOOR) {
        b.suggestion = { locationId: candidate.locationId, ratio: Math.round(candidate.ratio * 100) / 100 };
      }
    }
  }

  res.json(out);
});

// Clears any bidderLinks doc pointing at a location that no longer exists
// (e.g. after a batch re-import replaced every location with a new _id) and
// re-runs the matching cascade for everything that's now unconfirmed. This
// is the "force it to try matching again" button — plain re-running the
// cascade wouldn't help on its own, since a confirmed-but-dangling link
// still counts as confirmed and gets skipped. Registered ahead of the
// `:bidderName` route below so "resync" isn't swallowed as a bidder name.
app.post('/api/bidder-links/resync', async (req, res) => {
  const validLocationIds = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(new Set((docs || []).map(l => l._id)))));
  const links = await new Promise(resolve => db.bidderLinks.find({}, (err, docs) => resolve(docs || [])));
  const dangling = links.filter(l => l.locationId && !validLocationIds.has(l.locationId));
  await Promise.all(dangling.map(l => new Promise(resolve => db.bidderLinks.remove({ _id: l._id }, {}, () => resolve()))));

  const observations = await getEffectiveObservations();
  const bidders = await resolveBidderLinks(observations);
  const needsReview = await countUnconfirmedBidders(observations);
  await reDeriveIfPossible();
  res.json({ ok: true, clearedDangling: dangling.length, bidderCount: bidders.length, needsReview });
});

// Bulk "Save All Visible" — confirms a batch of bidder->location picks (and
// optional division overrides) in one call instead of one round-trip per
// row, then re-derives once at the end. Registered ahead of the
// `:bidderName` route below for the same reason resync is.
app.post('/api/bidder-links/bulk-confirm', async (req, res) => {
  const items = Array.isArray(req.body.links) ? req.body.links : [];
  let updated = 0;
  for (const item of items) {
    const bidderName = String(item.bidderName || '').trim();
    const locationId = item.locationId;
    if (!bidderName || !locationId) continue;
    await new Promise(resolve => db.bidderLinks.update(
      { bidderName },
      { bidderName, locationId, method: 'manual', confirmed: true, updatedAt: Date.now() },
      { upsert: true }, () => resolve()
    ));
    updated++;
    const divisions = Array.isArray(item.divisions) ? item.divisions.filter(Boolean) : (item.division ? [item.division] : []);
    if (divisions.length) {
      await new Promise(resolve => db.bidderDivisionOverrides.update(
        { bidderName }, { bidderName, divisions, updatedAt: Date.now() }, { upsert: true }, () => resolve()
      ));
    }
  }
  await new Promise(resolve => db.coverageDepthCache.remove({}, { multi: true }, () => resolve()));
  await reDeriveIfPossible();
  res.json({ ok: true, updated });
});

app.post('/api/bidder-links/:bidderName', (req, res) => {
  const bidderName = req.params.bidderName;
  const locationId = req.body.locationId;
  if (!locationId) return res.status(400).json({ error: 'locationId required' });
  db.bidderLinks.update(
    { bidderName },
    { bidderName, locationId, method: 'manual', confirmed: true, updatedAt: Date.now() },
    { upsert: true },
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.coverageDepthCache.remove({}, { multi: true }, () => res.json({ ok: true }));
    }
  );
});

app.post('/api/bidder-links/:bidderName/skip', (req, res) => {
  const bidderName = req.params.bidderName;
  db.bidderLinks.update(
    { bidderName },
    { bidderName, locationId: null, method: 'skip', confirmed: true, updatedAt: Date.now() },
    { upsert: true },
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

// Puts a bidder back into "unlinked, never reviewed" state — the entity
// resolution cascade will re-attempt matching it on the next sync.
app.post('/api/bidder-links/:bidderName/unlink', (req, res) => {
  db.bidderLinks.remove({ bidderName: req.params.bidderName }, {}, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.coverageDepthCache.remove({}, { multi: true }, () => res.json({ ok: true }));
  });
});

// ─── Division display-name overrides ────────────────────────────────
app.get('/api/division-overrides', (req, res) => {
  db.divisionOverrides.find({}, (err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs || []);
  });
});
app.post('/api/division-overrides/:code', async (req, res) => {
  const division = req.params.code;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  db.divisionOverrides.update({ division }, { division, name, updatedAt: Date.now() }, { upsert: true }, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});
app.delete('/api/division-overrides/:code', async (req, res) => {
  db.divisionOverrides.remove({ division: req.params.code }, {}, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});

// ─── Per-bidder division reassignment ───────────────────────────────
// Forces a bidder's observations into a specific set of divisions — for when
// the Bid Database's csi_division tag is wrong/too coarse, or the bidder
// genuinely bids across multiple trades that should each count them.
app.get('/api/bidder-division-overrides', (req, res) => {
  db.bidderDivisionOverrides.find({}, (err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs || []);
  });
});
app.post('/api/bidder-division-overrides/:bidderName', async (req, res) => {
  const bidderName = req.params.bidderName;
  const divisions = Array.isArray(req.body.divisions)
    ? [...new Set(req.body.divisions.map(d => String(d || '').trim()).filter(Boolean))]
    : (req.body.division ? [String(req.body.division).trim()] : []);
  if (!divisions.length) return res.status(400).json({ error: 'divisions required' });
  db.bidderDivisionOverrides.update({ bidderName }, { bidderName, divisions, updatedAt: Date.now() }, { upsert: true }, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});
app.delete('/api/bidder-division-overrides/:bidderName', async (req, res) => {
  db.bidderDivisionOverrides.remove({ bidderName: req.params.bidderName }, {}, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});

// ─── Bidder merge (duplicate-name cleanup) ──────────────────────────
// Folds one bidder name into another. Unlike a Bid-Database-side rename,
// this takes effect immediately and survives future syncs even if the
// source data still reports the two names separately — getEffectiveObservations()
// rewrites the loser's bids to the survivor's name before anything else
// (division overrides, entity resolution, derivation) sees them.
app.post('/api/bidders/merge', async (req, res) => {
  const loserName = String(req.body.loserName || '').trim();
  const survivorNameRaw = String(req.body.survivorName || '').trim();
  if (!loserName || !survivorNameRaw) return res.status(400).json({ error: 'loserName and survivorName required' });
  if (loserName === survivorNameRaw) return res.status(400).json({ error: 'Cannot merge a bidder into itself' });

  const aliasMap = await getBidderAliasMap();
  // Resolve the survivor through any existing chain, in case it was itself
  // already merged into something else — merges always flatten to one hop.
  const survivorName = aliasMap.get(survivorNameRaw) || survivorNameRaw;
  if (survivorName === loserName) return res.status(400).json({ error: 'That would create a merge cycle' });

  // Anything that currently resolves to the loser (a prior merge chained
  // through it) now needs to resolve to the new final target instead.
  const repointed = [...aliasMap.entries()].filter(([, canon]) => canon === loserName).map(([alias]) => alias);
  for (const alias of repointed) {
    await new Promise(resolve => db.bidderAliases.update({ aliasName: alias }, { $set: { canonicalName: survivorName } }, {}, () => resolve()));
  }
  await new Promise(resolve => db.bidderAliases.update(
    { aliasName: loserName }, { aliasName: loserName, canonicalName: survivorName, updatedAt: Date.now() }, { upsert: true }, () => resolve()
  ));

  // Migrate settings keyed to the loser's name — survivor's existing values
  // win on conflict, loser only fills in what the survivor doesn't have.
  const [loserLink, survivorLink] = await Promise.all([
    new Promise(resolve => db.bidderLinks.findOne({ bidderName: loserName }, (e, d) => resolve(d))),
    new Promise(resolve => db.bidderLinks.findOne({ bidderName: survivorName }, (e, d) => resolve(d)))
  ]);
  if (loserLink && loserLink.locationId && (!survivorLink || !survivorLink.locationId)) {
    await new Promise(resolve => db.bidderLinks.update(
      { bidderName: survivorName },
      { bidderName: survivorName, locationId: loserLink.locationId, method: loserLink.method, confirmed: loserLink.confirmed, updatedAt: Date.now() },
      { upsert: true }, () => resolve()
    ));
  }
  await new Promise(resolve => db.bidderLinks.remove({ bidderName: loserName }, {}, () => resolve()));

  const [loserOv, survivorOv] = await Promise.all([
    new Promise(resolve => db.bidderOverrides.findOne({ bidderName: loserName }, (e, d) => resolve(d))),
    new Promise(resolve => db.bidderOverrides.findOne({ bidderName: survivorName }, (e, d) => resolve(d)))
  ]);
  if (loserOv) {
    const { _id, bidderName, updatedAt, ...loserFields } = loserOv;
    const { _id: sId, bidderName: sName, updatedAt: sAt, ...survivorFields } = survivorOv || {};
    await new Promise(resolve => db.bidderOverrides.update(
      { bidderName: survivorName },
      { bidderName: survivorName, ...loserFields, ...survivorFields, updatedAt: Date.now() },
      { upsert: true }, () => resolve()
    ));
    await new Promise(resolve => db.bidderOverrides.remove({ bidderName: loserName }, {}, () => resolve()));
  }

  const [loserDiv, survivorDiv] = await Promise.all([
    new Promise(resolve => db.bidderDivisionOverrides.findOne({ bidderName: loserName }, (e, d) => resolve(d))),
    new Promise(resolve => db.bidderDivisionOverrides.findOne({ bidderName: survivorName }, (e, d) => resolve(d)))
  ]);
  if (loserDiv) {
    const divisions = [...new Set([...((survivorDiv && survivorDiv.divisions) || []), ...(loserDiv.divisions || [])])];
    if (divisions.length) {
      await new Promise(resolve => db.bidderDivisionOverrides.update(
        { bidderName: survivorName }, { bidderName: survivorName, divisions, updatedAt: Date.now() }, { upsert: true }, () => resolve()
      ));
    }
    await new Promise(resolve => db.bidderDivisionOverrides.remove({ bidderName: loserName }, {}, () => resolve()));
  }

  await reDeriveIfPossible();
  res.json({ ok: true, loserName, survivorName });
});

app.get('/api/bidders/aliases', (req, res) => {
  db.bidderAliases.find({}).sort({ updatedAt: -1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json((docs || []).map(({ aliasName, canonicalName, updatedAt }) => ({ aliasName, canonicalName, updatedAt })));
  });
});

app.delete('/api/bidders/aliases/:aliasName', async (req, res) => {
  db.bidderAliases.remove({ aliasName: req.params.aliasName }, {}, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});

// ─── 2b. Project geocoding cache ────────────────────────────────────
// Keyed by project name + address hash, so an edited address is simply a
// cache miss (re-geocoded); an unchanged address is never re-geocoded.
async function getProjectLocation(projectName, address) {
  const hash = sha1(String(address || '').trim().toLowerCase());
  return new Promise(resolve => db.projectLocations.findOne({ _id: `${projectName}::${hash}` }, (err, doc) => resolve(doc)));
}
async function syncProjectLocations(observations) {
  const projects = new Map();
  for (const o of observations) {
    if (!o.project || !o.project_address) continue;
    const key = `${o.project}::${o.project_address}`;
    if (!projects.has(key)) projects.set(key, { projectName: o.project, address: o.project_address });
  }
  for (const { projectName, address } of projects.values()) {
    const hash = sha1(address.trim().toLowerCase());
    const id = `${projectName}::${hash}`;
    const existing = await new Promise(resolve => db.projectLocations.findOne({ _id: id }, (err, doc) => resolve(doc)));
    if (existing) continue;
    try {
      const results = await geocodeAddress(address);
      const doc = results && results.length
        ? { _id: id, projectName, address, lat: results[0].lat, lng: results[0].lng, geocodedAt: Date.now() }
        : { _id: id, projectName, address, lat: null, lng: null, geocodedAt: Date.now(), failed: true };
      await new Promise(resolve => db.projectLocations.insert(doc, () => resolve()));
    } catch (e) {
      console.warn(`Geocoding failed for project "${projectName}": ${e.message}`);
    }
    await sleep(1100); // be polite to Nominatim's free tier (1 req/sec)
  }
}

// ─── 2c. Distance (ORS matrix, haversine fallback per-pair) ────────
// Batches every unresolved (linked-bidder -> project) pair into one ORS
// matrix call; real durations are cached in the existing travelCache (same
// key scheme as /api/travel-times). Unreachable/partial ORS falls back to
// haversine per pair, and the basis used is recorded on each result.
async function resolvePairDistances(pairs) {
  const out = new Map();
  const misses = [];
  for (const [key, coords] of pairs.entries()) {
    const cacheKey = travelKey(coords.from, coords.to);
    const cached = await new Promise(resolve => db.travelCache.findOne({ key: cacheKey }, (err, doc) => resolve(doc)));
    if (cached && typeof cached.seconds === 'number') {
      out.set(key, { miles: haversineMeters(coords.from, coords.to) / 1609.34, minutes: cached.seconds / 60, basis: 'ors' });
    } else {
      misses.push(key);
    }
  }
  if (!misses.length) return out;

  const target = resolveOrsTarget(await getOrsSettings());
  if (target.usable) {
    try {
      const uniqueFrom = [], fromIndex = new Map();
      const uniqueTo = [], toIndex = new Map();
      const idxOf = (list, indexMap, coord) => {
        const ck = `${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`;
        if (indexMap.has(ck)) return indexMap.get(ck);
        const i = list.length; list.push(coord); indexMap.set(ck, i); return i;
      };
      const rows = misses.map(key => {
        const { from, to } = pairs.get(key);
        return { key, fromIdx: idxOf(uniqueFrom, fromIndex, from), toIdx: idxOf(uniqueTo, toIndex, to) };
      });
      const locations = [...uniqueFrom.map(c => [c.lng, c.lat]), ...uniqueTo.map(c => [c.lng, c.lat])];
      const sources = uniqueFrom.map((_, i) => i);
      const destinations = uniqueTo.map((_, i) => uniqueFrom.length + i);
      const r = await fetchWithTimeout(`${target.baseUrl}/v2/matrix/driving-car`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': target.authHeader },
        body: JSON.stringify({ locations, sources, destinations, metrics: ['duration'] })
      });
      const data = await r.json();
      if (data && data.durations) {
        for (const row of rows) {
          const sec = data.durations[row.fromIdx] ? data.durations[row.fromIdx][row.toIdx] : null;
          if (sec == null) continue;
          const coords = pairs.get(row.key);
          out.set(row.key, { miles: haversineMeters(coords.from, coords.to) / 1609.34, minutes: Math.round(sec) / 60, basis: 'ors' });
          const ck = travelKey(coords.from, coords.to);
          db.travelCache.update({ key: ck }, { key: ck, seconds: Math.round(sec), createdAt: Date.now() }, { upsert: true });
        }
      }
    } catch (e) {
      console.warn(`ORS matrix request failed, falling back to haversine for ${misses.length} pairs: ${e.message}`);
    }
  }
  for (const key of misses) {
    if (out.has(key)) continue;
    const coords = pairs.get(key);
    const meters = haversineMeters(coords.from, coords.to);
    out.set(key, { miles: meters / 1609.34, minutes: meters / 1340, basis: 'haversine' });
  }
  return out;
}

// Resolves every observation's bidder->project distance, dropping in
// miles/minutes/basis (null when the bidder isn't linked or the project
// isn't geocoded yet — those observations just aren't usable for derivation).
async function computeDistances(observations) {
  const linksByName = await new Promise(resolve => db.bidderLinks.find(
    { confirmed: true, locationId: { $ne: null } },
    (err, docs) => resolve(new Map((docs || []).map(d => [d.bidderName, d.locationId])))
  ));
  const locationsById = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(new Map((docs || []).map(l => [l._id, l])))));

  const pairs = new Map();
  const enriched = [];
  for (const o of observations) {
    const locId = linksByName.get(o.bidder);
    const loc = locId ? locationsById.get(locId) : null;
    const proj = loc ? await getProjectLocation(o.project, o.project_address) : null;
    if (!loc || !proj || proj.lat == null) { enriched.push({ ...o, miles: null, minutes: null, basis: null }); continue; }
    const pairKey = `${locId}::${proj._id}`;
    pairs.set(pairKey, { from: { lat: loc.lat, lng: loc.lng }, to: { lat: proj.lat, lng: proj.lng } });
    enriched.push({ ...o, _pairKey: pairKey });
  }

  const distByPair = await resolvePairDistances(pairs);
  return enriched.map(o => {
    if (!o._pairKey) return o;
    const d = distByPair.get(o._pairKey);
    const { _pairKey, ...rest } = o;
    return d ? { ...rest, miles: d.miles, minutes: d.minutes, basis: d.basis } : { ...rest, miles: null, minutes: null, basis: null };
  });
}

// ─── 2d. Derivation ─────────────────────────────────────────────────
async function buildDivisionNamesFromTypes() {
  const types = await new Promise(resolve => db.locationTypes.find({}, (err, docs) => resolve(docs || [])));
  const names = {};
  for (const t of types) {
    const parsed = parseDivisionFromTypeName(t.name);
    if (parsed && parsed.tradeName && !names[parsed.division]) names[parsed.division] = parsed.tradeName;
  }
  return names;
}

async function getManualOverrides() {
  return new Promise(resolve => db.bidderOverrides.find({}, (err, docs) => {
    const map = {};
    (docs || []).forEach(d => { const { bidderName, _id, updatedAt, ...rest } = d; map[bidderName] = rest; });
    resolve(map);
  }));
}

async function runDerivation(observations) {
  const enriched = await computeDistances(observations);
  const joined = enriched
    .filter(o => o.miles != null && o.minutes != null && o.dev_pct != null)
    .map(o => ({ csi_division: o.csi_division, bidderName: o.bidder, dev_pct: o.dev_pct, won: !!o.won, miles: o.miles, minutes: o.minutes, basis: o.basis }));

  const typeNames = await buildDivisionNamesFromTypes();
  const nameOverrides = await getDivisionNameOverrideMap();
  const divisionNames = { ...typeNames };
  for (const [code, name] of nameOverrides.entries()) divisionNames[code] = name; // manual wins
  const manualOverrides = await getManualOverrides();
  const previous = await getCoverageConfigDoc();
  const previousConfig = previous ? previous.config : BUNDLED_CONFIG;
  const thresholds = await getDerivationThresholds();

  const derived = coverageDerivation.deriveConfig({ observations: joined, divisionNames, manualOverrides, previousConfig, thresholds });
  await new Promise(resolve => db.coverageConfig.update({ _id: 'latest' }, { _id: 'latest', config: derived, savedAt: Date.now() }, { upsert: true }, () => resolve()));
  await new Promise(resolve => db.coverageDepthCache.remove({}, { multi: true }, () => resolve()));
  return derived;
}

// Manual per-bidder overrides — small editable collection, merged over
// auto-derived flags (manual always wins) on the next derivation.
app.get('/api/coverage-overrides', (req, res) => {
  db.bidderOverrides.find({}, (err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs || []);
  });
});
app.post('/api/coverage-overrides/:bidderName', async (req, res) => {
  const bidderName = req.params.bidderName;
  const body = { ...req.body };
  delete body._id; delete body.bidderName;
  db.bidderOverrides.update({ bidderName }, { bidderName, ...body, updatedAt: Date.now() }, { upsert: true }, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});
app.delete('/api/coverage-overrides/:bidderName', async (req, res) => {
  db.bidderOverrides.remove({ bidderName: req.params.bidderName }, {}, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    await reDeriveIfPossible();
    res.json({ ok: true });
  });
});

// Direct patch for target_bidders — this isn't derived from bid data (it's a
// staffing/business choice), so it edits the persisted config in place
// rather than requiring a full re-derivation.
app.post('/api/coverage-config/target-bidders/:division', async (req, res) => {
  const division = req.params.division;
  const target = parseInt(req.body.target_bidders, 10);
  if (!(target > 0)) return res.status(400).json({ error: 'target_bidders must be a positive integer' });
  const doc = await getCoverageConfigDoc();
  if (!doc || !doc.config || !doc.config.divisions[division]) {
    return res.status(404).json({ error: 'No live config for this division yet — run a bid-data sync first.' });
  }
  doc.config.divisions[division].target_bidders = target;
  db.coverageConfig.update({ _id: 'latest' }, { _id: 'latest', config: doc.config, savedAt: doc.savedAt }, { upsert: true }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.coverageDepthCache.remove({}, { multi: true }, () => res.json({ ok: true, target_bidders: target }));
  });
});

// Manually create a division/package that doesn't exist in the Bid
// Database's own CSI-division tagging — e.g. splitting one division into
// finer packages (05 Structural Steel vs 05 Misc Steel). Starts as an empty
// placeholder; assigning bidders to it via a bidder-division override gives
// it real bid history, and the next re-derivation replaces the placeholder
// with real tier/radius numbers computed from that data.
app.post('/api/coverage-config/add-division', async (req, res) => {
  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim() || code;
  if (!code) return res.status(400).json({ error: 'code required' });
  const doc = await getCoverageConfigDoc();
  const config = (doc && doc.config) ? doc.config : JSON.parse(JSON.stringify(BUNDLED_CONFIG));
  if (config.divisions[code]) return res.status(409).json({ error: `Division "${code}" already exists` });
  config.divisions[code] = {
    name, tier: 'insufficient_data', target_bidders: 3,
    evidence: { usable_bids: 0, median_dev_pct_by_band: {}, band_sample_sizes: {}, share_of_bids_from_50plus_mi: 0 },
    competitive_radius_mi: 30, outer_radius_mi: 60, competitive_radius_min: 40, outer_radius_min: 70,
    weights: { inside_competitive: 1.0, beyond_outer: 0.0, competitive_to_outer: 0.7 },
    note: 'Manually added — no bid data yet. Assign bidders to this division in Bidder Links; the next sync/re-derive replaces these placeholder numbers with real ones.'
  };
  await new Promise(resolve => db.divisionOverrides.update({ division: code }, { division: code, name, updatedAt: Date.now() }, { upsert: true }, () => resolve()));
  await new Promise(resolve => db.coverageConfig.update({ _id: 'latest' }, { _id: 'latest', config, savedAt: Date.now() }, { upsert: true }, () => resolve()));
  await new Promise(resolve => db.coverageDepthCache.remove({}, { multi: true }, () => resolve()));
  res.json({ ok: true, code });
});

// Removes a division/package Territory is tracking. If real bid data is
// still tagged with this exact code, it simply reappears on the next sync —
// this only clears a stale/placeholder entry, plus any bidder overrides
// pointing at it (those bidders fall back to their actual bid-data division
// instead of silently losing their assignment).
app.delete('/api/coverage-config/division/:code', async (req, res) => {
  const code = req.params.code;
  const doc = await getCoverageConfigDoc();
  if (doc && doc.config && doc.config.divisions[code]) {
    delete doc.config.divisions[code];
    await new Promise(resolve => db.coverageConfig.update({ _id: 'latest' }, { _id: 'latest', config: doc.config, savedAt: doc.savedAt }, { upsert: true }, () => resolve()));
  }
  await new Promise(resolve => db.divisionOverrides.remove({ division: code }, {}, () => resolve()));
  const affected = await new Promise(resolve => db.bidderDivisionOverrides.find({ divisions: code }, (err, docs) => resolve(docs || [])));
  for (const d of affected) {
    const remaining = (d.divisions || []).filter(c => c !== code);
    if (remaining.length) await new Promise(resolve => db.bidderDivisionOverrides.update({ _id: d._id }, { $set: { divisions: remaining } }, {}, () => resolve()));
    else await new Promise(resolve => db.bidderDivisionOverrides.remove({ _id: d._id }, {}, () => resolve()));
  }
  await new Promise(resolve => db.coverageDepthCache.remove({}, { multi: true }, () => resolve()));
  res.json({ ok: true });
});

// ─── 2e. Coverage-depth (H3 hex grid) ───────────────────────────────
const MAX_HEX_CELLS = 20000; // safety cap for a Pi-class host

// "Linked subs" for a division = bidders with a confirmed, non-skip
// location link AND actual bid history in that division (not just any
// location tagged with a matching type) — depth reflects proven presence.
async function getBiddersForDivision(division, config, observations, excludeSet) {
  const bidderDivisions = new Map();
  for (const o of observations) {
    if (!o.bidder || !o.csi_division) continue;
    if (!bidderDivisions.has(o.bidder)) bidderDivisions.set(o.bidder, new Set());
    bidderDivisions.get(o.bidder).add(o.csi_division);
  }
  const links = await new Promise(resolve => db.bidderLinks.find({ confirmed: true, locationId: { $ne: null } }, (err, docs) => resolve(docs || [])));
  const locationsById = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(new Map((docs || []).map(l => [l._id, l])))));
  const overrides = (config && config.bidder_overrides) || {};

  const out = [];
  for (const link of links) {
    if (excludeSet && excludeSet.has(link.bidderName)) continue;
    const divs = bidderDivisions.get(link.bidderName);
    if (!divs || !divs.has(division)) continue;
    const loc = locationsById.get(link.locationId);
    if (!loc) continue;
    const ov = overrides[link.bidderName];
    const scoped = ov && (!ov.division || ov.division === division) ? ov : null;
    out.push({
      locationId: loc._id, bidderName: link.bidderName, name: loc.name, lat: loc.lat, lng: loc.lng,
      multiplier: scoped && scoped.weight_multiplier != null ? scoped.weight_multiplier : 1,
      medianSupportOnly: !!(scoped && scoped.median_support_only),
      ignoreDistanceDecay: !!(scoped && scoped.ignore_distance_decay),
      competitiveRadiusMi: scoped && scoped.competitive_radius_mi != null ? scoped.competitive_radius_mi : null,
      outerRadiusMi: scoped && scoped.outer_radius_mi != null ? scoped.outer_radius_mi : null
    });
  }
  return out;
}

app.get('/api/coverage-depth', async (req, res) => {
  const resolution = clampNum(req.query.resolution, 5, 9, 7);
  const divisions = String(req.query.divisions || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!divisions.length) return res.status(400).json({ error: 'divisions query param required (comma-separated CSI codes)' });
  let padOverride = null;
  if (req.query.padMiles != null && req.query.padMiles !== '') {
    const v = Number(req.query.padMiles);
    if (Number.isFinite(v)) padOverride = Math.min(150, Math.max(5, v));
  }
  // Optional per-bidder exclusion so a single contractor's shape can be
  // isolated (or several toggled off) without touching the derived config.
  const excludeSet = req.query.excludeBidders
    ? new Set(String(req.query.excludeBidders).split(',').filter(Boolean).map(decodeURIComponent))
    : null;
  const excludeTag = excludeSet && excludeSet.size
    ? crypto.createHash('sha1').update([...excludeSet].sort().join('|')).digest('hex').slice(0, 10)
    : 'all';

  const configDoc = await getCoverageConfigDoc();
  const config = configDoc ? configDoc.config : BUNDLED_CONFIG;
  if (!config) return res.status(503).json({ error: 'No coverage config available yet — run a bid-data sync first.' });

  const observations = await getEffectiveObservations();

  const out = { resolution, divisions: {} };
  for (const division of divisions) {
    const divCfg = config.divisions[division];
    if (!divCfg || divCfg.always_covered) { out.divisions[division] = { alwaysCovered: true }; continue; }

    const bidders = await getBiddersForDivision(division, config, observations, excludeSet);
    if (!bidders.length) { out.divisions[division] = { cells: {}, computedAt: Date.now(), note: 'No linked subs with bid history in this division yet (or all are filtered out above).' }; continue; }

    // Default grid extent scales with how far this division's coverage can
    // actually reach — otherwise a wide outer radius gets clipped by the
    // grid edge and reads as "fully covered" right up to the border.
    let maxOuterMi = divCfg.outer_radius_mi || 60;
    for (const b of bidders) if (b.outerRadiusMi != null) maxOuterMi = Math.max(maxOuterMi, b.outerRadiusMi);
    const padMiles = padOverride != null ? padOverride : maxOuterMi + 15;

    const projLocs = await new Promise(resolve => db.projectLocations.find({ lat: { $ne: null } }, (err, docs) => resolve(docs || [])));
    const allPoints = [...bidders.map(b => ({ lat: b.lat, lng: b.lng })), ...projLocs.map(p => ({ lat: p.lat, lng: p.lng }))];

    // A wide auto-pad (to cover a large outer radius) can outgrow the cell
    // cap at the requested resolution — degrade to a coarser resolution
    // automatically rather than failing outright; only error if even the
    // coarsest resolution is still too large for this market's extent.
    let usedResolution = resolution;
    let cells = coverageDepthLib.buildHexGrid(allPoints, usedResolution, padMiles);
    while (cells.length > MAX_HEX_CELLS && usedResolution > 4) {
      usedResolution -= 1;
      cells = coverageDepthLib.buildHexGrid(allPoints, usedResolution, padMiles);
    }
    if (cells.length > MAX_HEX_CELLS) {
      return res.status(400).json({ error: `Grid too large (${cells.length} cells) even at the coarsest resolution for ${Math.round(padMiles)}mi padding — try a smaller grid extent.` });
    }

    const cacheId = `${division}:${usedResolution}:${Math.round(padMiles)}:${excludeTag}`;
    const cached = await new Promise(resolve => db.coverageDepthCache.findOne({ _id: cacheId }, (err, doc) => resolve(doc)));
    if (cached) { out.divisions[division] = { cells: cached.cells, computedAt: cached.computedAt, padMiles, resolution: usedResolution }; continue; }

    const depths = coverageDepthLib.computeDivisionDepth(cells, bidders, divCfg);
    await new Promise(resolve => db.coverageDepthCache.update(
      { _id: cacheId }, { _id: cacheId, cells: depths, computedAt: Date.now() }, { upsert: true }, () => resolve()
    ));
    out.divisions[division] = { cells: depths, computedAt: Date.now(), padMiles, resolution: usedResolution };
  }
  res.json(out);
});

// Full (untruncated) per-division contributor detail for exactly one cell —
// the bulk grid response above caps each cell's contributor list short to
// keep the whole-grid payload/cache size sane across thousands of cells, so
// a cell click fetches this instead of relying on that truncated list.
app.get('/api/coverage-depth/cell/:cellId', async (req, res) => {
  const cellId = req.params.cellId;
  const divisions = String(req.query.divisions || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!divisions.length) return res.status(400).json({ error: 'divisions query param required (comma-separated CSI codes)' });
  const excludeSet = req.query.excludeBidders
    ? new Set(String(req.query.excludeBidders).split(',').filter(Boolean).map(decodeURIComponent))
    : null;

  const configDoc = await getCoverageConfigDoc();
  const config = configDoc ? configDoc.config : BUNDLED_CONFIG;
  if (!config) return res.status(503).json({ error: 'No coverage config available yet — run a bid-data sync first.' });
  const observations = await getEffectiveObservations();

  const out = {};
  for (const division of divisions) {
    const divCfg = config.divisions[division];
    if (!divCfg || divCfg.always_covered) { out[division] = { alwaysCovered: true }; continue; }
    const bidders = await getBiddersForDivision(division, config, observations, excludeSet);
    if (!bidders.length) { out[division] = { depth: 0, secondaryDepth: 0, contributors: [] }; continue; }
    const depths = coverageDepthLib.computeDivisionDepth([cellId], bidders, divCfg, null);
    out[division] = depths[cellId] || { depth: 0, secondaryDepth: 0, contributors: [] };
  }
  res.json(out);
});

// ─── Linked contractors (the roster that actually feeds the map) ───
// Every confirmed, located bidder, with the divisions they contribute to
// and the effective radius/weight/flags applied for each — a quick roster
// view before drilling into any one bidder's full audit.
app.get('/api/linked-contractors', async (req, res) => {
  const configDoc = await getCoverageConfigDoc();
  const config = configDoc ? configDoc.config : BUNDLED_CONFIG;
  const observations = await getEffectiveObservations();
  const bidderDivisions = new Map();
  for (const o of observations) {
    if (!o.bidder || !o.csi_division) continue;
    if (!bidderDivisions.has(o.bidder)) bidderDivisions.set(o.bidder, new Set());
    bidderDivisions.get(o.bidder).add(o.csi_division);
  }
  const links = await new Promise(resolve => db.bidderLinks.find({ confirmed: true, locationId: { $ne: null } }, (err, docs) => resolve(docs || [])));
  const locationsById = await new Promise(resolve => db.locations.find({}, (err, docs) => resolve(new Map((docs || []).map(l => [l._id, l])))));
  const overrides = (config && config.bidder_overrides) || {};

  const out = links.map(link => {
    const loc = locationsById.get(link.locationId);
    const divs = [...(bidderDivisions.get(link.bidderName) || [])].sort();
    const ov = overrides[link.bidderName];
    return {
      bidderName: link.bidderName,
      locationName: loc ? loc.name : null,
      locationId: link.locationId,
      divisions: divs,
      alwaysCovered: divs.every(d => config && config.divisions[d] && config.divisions[d].always_covered),
      weightMultiplier: ov && ov.weight_multiplier != null ? ov.weight_multiplier : null,
      medianSupportOnly: !!(ov && ov.median_support_only),
      ignoreDistanceDecay: !!(ov && ov.ignore_distance_decay),
      customCompetitiveRadiusMi: ov && ov.competitive_radius_mi != null ? ov.competitive_radius_mi : null
    };
  }).filter(b => b.divisions.length && !b.alwaysCovered) // distance-blind divisions aren't depth-mapped at all
    .sort((a, b) => a.bidderName.localeCompare(b.bidderName));
  res.json(out);
});

// Full audit trail for one bidder: per division they've bid in, the raw
// joined observations (distance + deviation + outcome), their own band
// stats, and exactly which radius/weight/flags are being applied and why —
// so a "this contractor shouldn't be competitive here" read can be checked
// against the actual numbers instead of taken on faith.
app.get('/api/bidder-audit/:bidderName', async (req, res) => {
  const bidderName = req.params.bidderName;
  const link = await new Promise(resolve => db.bidderLinks.findOne({ bidderName }, (err, doc) => resolve(doc)));
  if (!link || !link.confirmed || !link.locationId) {
    return res.status(404).json({ error: 'This bidder is not confirmed/linked to a location yet.' });
  }
  const location = await new Promise(resolve => db.locations.findOne({ _id: link.locationId }, (err, doc) => resolve(doc)));
  if (!location) return res.status(404).json({ error: 'Linked location no longer exists — try Re-match Subcontractors.' });

  const configDoc = await getCoverageConfigDoc();
  const config = configDoc ? configDoc.config : BUNDLED_CONFIG;
  const overrides = (config && config.bidder_overrides) || {};
  const ov = overrides[bidderName] || null;
  const thresholds = await getDerivationThresholds();

  const allObservations = await getEffectiveObservations();
  const bidderObservations = allObservations.filter(o => o.bidder === bidderName);
  const enriched = await computeDistances(bidderObservations);

  const byDivision = new Map();
  for (const o of enriched) {
    if (!o.csi_division) continue;
    if (!byDivision.has(o.csi_division)) byDivision.set(o.csi_division, []);
    byDivision.get(o.csi_division).push(o);
  }

  const divisions = {};
  for (const [code, obs] of byDivision.entries()) {
    const divCfg = (config && config.divisions[code]) || null;
    const usable = obs.filter(o => o.dev_pct != null && o.miles != null && o.minutes != null);
    const scoped = ov && (!ov.division || ov.division === code) ? ov : null;

    const miBands = coverageDerivation.computeBandStats(usable, coverageDerivation.MILE_EDGES, 'miles');
    const ownCompetitive = coverageDerivation.findCompetitiveRadius(usable, coverageDerivation.MILE_EDGES, 'miles', thresholds.competitiveDevPct);
    const ownOuter = coverageDerivation.findOuterRadius(usable, coverageDerivation.MILE_EDGES, 'miles', thresholds.outerDevPct, thresholds.outerWinRate);

    divisions[code] = {
      name: (divCfg && divCfg.name) || code,
      alwaysCovered: !!(divCfg && divCfg.always_covered),
      tradeTier: divCfg ? divCfg.tier : null,
      tradeCompetitiveRadiusMi: divCfg ? divCfg.competitive_radius_mi : null,
      tradeOuterRadiusMi: divCfg ? divCfg.outer_radius_mi : null,
      effective: {
        competitiveRadiusMi: (scoped && scoped.competitive_radius_mi != null) ? scoped.competitive_radius_mi : (divCfg ? divCfg.competitive_radius_mi : null),
        outerRadiusMi: (scoped && scoped.outer_radius_mi != null) ? scoped.outer_radius_mi : (divCfg ? divCfg.outer_radius_mi : null),
        weightMultiplier: (scoped && scoped.weight_multiplier != null) ? scoped.weight_multiplier : 1,
        medianSupportOnly: !!(scoped && scoped.median_support_only),
        ignoreDistanceDecay: !!(scoped && scoped.ignore_distance_decay),
        source: scoped ? (scoped.note ? 'override: ' + scoped.note : 'override') : 'division default'
      },
      ownBandStats: coverageDerivation.MILE_LABELS.map((label, i) => ({
        band: label, n: miBands[i].n, medianDevPct: miBands[i].medianDev,
        winRate: miBands[i].n ? Math.round((miBands[i].list.filter(o => o.won).length / miBands[i].n) * 100) / 100 : null
      })),
      ownCrossover: {
        competitiveRadiusMi: ownCompetitive ? ownCompetitive.edge : null,
        competitiveSupportN: ownCompetitive ? ownCompetitive.bandN : 0,
        outerRadiusMi: ownOuter ? ownOuter.edge : null,
        outerSupportN: ownOuter ? ownOuter.bandN : 0
      },
      usableCount: usable.length,
      bids: obs.map(o => ({
        project: o.project, projectDate: o.project_date, miles: o.miles != null ? Math.round(o.miles * 10) / 10 : null,
        minutes: o.minutes != null ? Math.round(o.minutes) : null, basis: o.basis,
        devPct: o.dev_pct, won: !!o.won, nBidsInPackage: o.n_bids_in_package
      })).sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity))
    };
  }

  res.json({
    bidderName, location: { name: location.name, lat: location.lat, lng: location.lng },
    divisions
  });
});

// ─── Sync orchestration ─────────────────────────────────────────────
async function runFullSync(baseUrl) {
  const payload = await fetchBidObservations(baseUrl);
  await saveCachedObservations(payload);
  const bidders = await resolveBidderLinks(payload.observations);
  await syncProjectLocations(payload.observations);
  const effective = await getEffectiveObservations();
  const derived = await runDerivation(effective);
  const needsReview = await countUnconfirmedBidders(payload.observations);
  return { observationCount: payload.observations.length, bidderCount: bidders.length, needsReview, generatedAt: derived.meta.generated };
}

app.post('/api/bid-sync', async (req, res) => {
  const settings = await getBidDbSettings();
  if (!settings.baseUrl) return res.status(400).json({ error: 'Set a Bid Database URL first (⚙ Bid Data Source).' });
  try {
    const summary = await runFullSync(settings.baseUrl);
    await setBidDbSyncStatus({ ok: true, at: Date.now(), message: `Synced ${summary.observationCount} observations, ${summary.needsReview} bidders need review.` });
    res.json({ ok: true, ...summary, source: 'live' });
  } catch (e) {
    await setBidDbSyncStatus({ ok: false, at: Date.now(), message: e.message });
    res.status(502).json({ error: `Bid Database sync failed: ${e.message}` });
  }
});

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
  const { name, showCoverageDepth } = req.body;
  const set = {};
  // Renaming is restricted to non-default tabs (existing behavior); the
  // coverage-depth visibility toggle is allowed on any tab, including Default,
  // since clutter-avoidance applies there too.
  if (name != null) {
    if (!name.trim()) return res.status(400).json({ error: 'name required' });
    set.name = name.trim();
  }
  if (showCoverageDepth != null) set.showCoverageDepth = !!showCoverageDepth;
  if (!Object.keys(set).length) return res.status(400).json({ error: 'nothing to update' });
  const filter = name != null ? { _id: req.params.id, isDefault: { $ne: true } } : { _id: req.params.id };
  db.mapTabs.update(filter, { $set: set }, {}, (err) => {
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

// Fire-and-forget background sync if the bid-data cache is stale (or never
// populated) — the manual "🔄 Refresh Bid Data" button covers the rest.
(async () => {
  try {
    const settings = await getBidDbSettings();
    if (!settings.baseUrl) return;
    const stale = !settings.lastSyncAt || (Date.now() - settings.lastSyncAt) > BID_SYNC_STALE_MS;
    if (!stale) return;
    console.log('Bid data cache is stale — running a background sync...');
    const summary = await runFullSync(settings.baseUrl);
    await setBidDbSyncStatus({ ok: true, at: Date.now(), message: `Startup sync: ${summary.observationCount} observations, ${summary.needsReview} bidders need review.` });
    console.log(`Bid data sync complete (${summary.observationCount} observations).`);
  } catch (e) {
    console.warn(`Startup bid-data sync skipped/failed: ${e.message}`);
  }
})();

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
