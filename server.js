require('dotenv').config();
const express = require('express');
const Datastore = require('nedb');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3080;

// Databases
const db = {
  locationTypes: new Datastore({ filename: path.join(__dirname, 'data/locationTypes.db'), autoload: true }),
  locations: new Datastore({ filename: path.join(__dirname, 'data/locations.db'), autoload: true }),
  // Persistent cache of computed isochrones so we only call the ORS key once
  // per unique coordinate+range instead of on every map render.
  isochroneCache: new Datastore({ filename: path.join(__dirname, 'data/isochroneCache.db'), autoload: true })
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
  const { name, address, lat, lng, customRadius, customRadiusUnit } = req.body;
  db.locations.update({ _id: req.params.id }, { $set: { name, address, lat, lng, customRadius, customRadiusUnit } }, {}, (err) => {
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
function isoCacheKey(lat, lng, minutes) {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)},${minutes}`;
}

app.post('/api/isochrone', async (req, res) => {
  const { lat, lng, minutes, force } = req.body;
  const apiKey = process.env.ORS_API_KEY;
  const cacheKey = isoCacheKey(lat, lng, minutes);

  // Serve from cache unless an explicit refresh was requested.
  if (!force) {
    const cached = await new Promise(resolve =>
      db.isochroneCache.findOne({ key: cacheKey }, (err, doc) => resolve(err ? null : doc))
    );
    if (cached && cached.geojson) {
      return res.json({ type: 'isochrone', geojson: cached.geojson, cached: true });
    }
  }

  if (!apiKey || !apiKey.trim()) {
    return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes) });
  }

  try {
    const r = await fetch('https://api.openrouteservice.org/v2/isochrones/driving-car', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey },
      body: JSON.stringify({ locations: [[lng, lat]], range: [minutes * 60], range_type: 'time' })
    });
    const data = await r.json();
    if (data.error || !data.features) {
      return res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes) });
    }
    const feature = data.features[0];
    // Persist for next time (upsert so a forced refresh overwrites the old one).
    db.isochroneCache.update({ key: cacheKey }, { key: cacheKey, geojson: feature, createdAt: Date.now() }, { upsert: true });
    res.json({ type: 'isochrone', geojson: feature, cached: false });
  } catch (e) {
    res.json({ type: 'circle', lat, lng, radiusMeters: minutesToMeters(minutes) });
  }
});

// average driving speed ~50mph = ~1340 meters/minute
function minutesToMeters(minutes) {
  return Math.round(minutes * 1340);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚨 PROJECT SECRET WISHES 🚨`);
  console.log(`   Server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
