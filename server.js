require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const Datastore = require('nedb');
const fetch = require('node-fetch');
const path = require('path');
const turfBuffer = require('@turf/buffer');

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
  travelCache: new Datastore({ filename: path.join(__dirname, 'data/travelCache.db'), autoload: true })
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    orsMaxMinutes: Math.round(ORS_MAX_RANGE_SEC / 60),
    splashColor
  });
});

// ─── Location Types ────────────────────────────────────────────────
app.get('/api/location-types', (req, res) => {
  db.locationTypes.find({}).sort({ createdAt: 1 }).exec((err, docs) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(docs);
  });
});

app.post('/api/location-types', (req, res) => {
  const { name, color, defaultRadius, defaultRadiusUnit } = req.body;
  if (!name || !color) return res.status(400).json({ error: 'name and color required' });
  const doc = { name, color, defaultRadius: defaultRadius || 60, defaultRadiusUnit: defaultRadiusUnit || 'minutes', createdAt: Date.now() };
  db.locationTypes.insert(doc, (err, newDoc) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(newDoc);
  });
});

app.put('/api/location-types/:id', (req, res) => {
  const { name, color, defaultRadius, defaultRadiusUnit } = req.body;
  db.locationTypes.update({ _id: req.params.id }, { $set: { name, color, defaultRadius, defaultRadiusUnit } }, {}, (err) => {
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
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'query required' });
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&countrycodes=us`;
    const r = await fetch(url, { headers: { 'User-Agent': 'ProjectSecretWishes/1.0' } });
    const data = await r.json();
    res.json(data.map(d => ({ display_name: d.display_name, lat: parseFloat(d.lat), lng: parseFloat(d.lon) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Isochrone proxy (with persistent cache) ───────────────────────
// A given coordinate + range always produces the same isochrone, so once
// we've fetched it we store the geometry and serve every later request from
// the local cache. This means the ORS key is only hit the first time a new
// location/range combo appears — not on every coverage re-render.
//
// For drive times over the ORS cap we also pre-compute the outward buffer
// (the "approximation") here and cache the FINISHED shape, so the expensive
// turf.buffer runs once on the server instead of in every browser on every
// page load. Cache key is versioned (v2) so older un-buffered entries are
// ignored after this change and rebuilt correctly.
function isoCacheKey(lat, lng, minutes) {
  return `v2:${Number(lat).toFixed(5)},${Number(lng).toFixed(5)},${minutes}`;
}
// A geometry is only useful if it actually has coordinates to draw. A null or
// empty geometry can sneak into the cache when turf.buffer returns a Feature
// with no geometry (it happens on some inputs) — and because the cache is
// persistent, one bad entry would otherwise be served forever, so a range that
// was poisoned during a past bug "never draws" even after the code is fixed.
// Validating here lets poisoned entries fall through and rebuild themselves.
function hasDrawableGeometry(g) {
  if (!g) return false;
  if (g.type === 'FeatureCollection') return Array.isArray(g.features) && g.features.some(hasDrawableGeometry);
  const geom = g.type === 'Feature' ? g.geometry : g;
  return !!(geom && Array.isArray(geom.coordinates) && geom.coordinates.length);
}
function isoCacheGet(key) {
  return new Promise(resolve => db.isochroneCache.findOne({ key }, (err, doc) => resolve(err ? null : doc)));
}
function isoCacheSet(key, geojson, extendMinutes) {
  db.isochroneCache.update({ key }, { key, geojson, extendMinutes, createdAt: Date.now() }, { upsert: true });
}

// The public ORS isochrone API rejects any range over 3600s (60 min). For
// longer drive times we fetch the capped isochrone and pad it outward by the
// remaining minutes as road distance. Override if you self-host ORS with a
// higher limit (value in seconds).
const ORS_MAX_RANGE_SEC = parseInt(process.env.ORS_MAX_RANGE_SEC) || 3600;

// Base URL for the ORS API. Defaults to the public endpoint; point this at a
// self-hosted instance (e.g. http://192.168.1.50:8080/ors) to lift the
// public 60-min isochrone cap and serve everything from your own machine.
// Trailing slashes are trimmed so we can append the /v2/... path cleanly.
const ORS_BASE_URL = (process.env.ORS_BASE_URL || 'https://api.openrouteservice.org').replace(/\/+$/, '');

app.post('/api/isochrone', async (req, res) => {
  const { lat, lng, minutes, force } = req.body;
  const apiKey = process.env.ORS_API_KEY;
  const finalKey = isoCacheKey(lat, lng, minutes);                 // finished (buffered) shape
  const rangeSec = Math.min(minutes * 60, ORS_MAX_RANGE_SEC);
  const cappedMin = rangeSec / 60;
  const rawKey = isoCacheKey(lat, lng, cappedMin);                 // raw capped isochrone
  const extendMinutes = Math.max(0, minutes - cappedMin);

  // 1. Serve the finished shape straight from cache when possible.
  if (!force) {
    const cached = await isoCacheGet(finalKey);
    if (cached && hasDrawableGeometry(cached.geojson)) {
      return res.json({ type: 'isochrone', geojson: cached.geojson, extendMinutes: cached.extendMinutes || 0, cached: true });
    }
  }

  if (!apiKey || !apiKey.trim()) {
    return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes) });
  }

  try {
    // 2. Get the raw capped isochrone — from cache (shared across ranges at the
    //    same point) or from ORS.
    let feature = null;
    if (!force) {
      const raw = await isoCacheGet(rawKey);
      if (raw && hasDrawableGeometry(raw.geojson)) feature = raw.geojson;
    }
    if (!feature) {
      const r = await fetch(`${ORS_BASE_URL}/v2/isochrones/driving-car`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
        body: JSON.stringify({ locations: [[lng, lat]], range: [rangeSec], range_type: 'time' })
      });
      const data = await r.json();
      if (data.error || !data.features) {
        const reason = data.error ? (data.error.message || JSON.stringify(data.error)) : 'no features returned';
        console.warn(`ORS isochrone fell back to circle (${rangeSec}s): ${reason}`);
        return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes), reason });
      }
      feature = data.features[0];
      isoCacheSet(rawKey, feature, 0);
    }

    // 3. Pad beyond the cap once (server-side), and cache the finished shape so
    //    the browser never has to buffer. If buffering fails, fall back to
    //    letting the client buffer (extendMinutes carried through).
    let finalGeo = feature, remaining = extendMinutes;
    if (extendMinutes > 0) {
      try {
        const km = (extendMinutes / 60) * 50; // ~50mph
        const buffered = turfBuffer(feature, km, { units: 'kilometers' });
        // Only accept the buffered shape if it actually produced geometry;
        // otherwise keep the capped isochrone and let the client pad it, so a
        // failed buffer never gets cached as a blank shape that won't draw.
        if (hasDrawableGeometry(buffered)) { finalGeo = buffered; remaining = 0; }
        else console.warn(`turf.buffer produced no geometry for ${minutes}min @ ${lat},${lng}; deferring pad to client`);
      } catch (e) { /* leave remaining for client to buffer */ }
    }
    // Never persist a shape we can't draw — that would poison the cache.
    if (hasDrawableGeometry(finalGeo)) isoCacheSet(finalKey, finalGeo, remaining);
    res.json({ type: 'isochrone', geojson: finalGeo, extendMinutes: remaining, cached: false });
  } catch (e) {
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
  const apiKey = process.env.ORS_API_KEY;

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
    if (apiKey && apiKey.trim()) {
      try {
        const locations = misses.map(i => [from[i].lng, from[i].lat]);
        locations.push([to.lng, to.lat]);
        const r = await fetch(`${ORS_BASE_URL}/v2/matrix/driving-car`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
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
