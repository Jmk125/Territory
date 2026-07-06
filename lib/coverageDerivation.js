'use strict';

// Phase 2d — turns joined bid observations (dev_pct + linked location +
// geocoded project + distance) into the coverage config, following the
// PROCEDURE in the spec (not hardcoded numbers) so it re-derives cleanly
// every time new bid data lands. Pure function — no DB access — so it can be
// exercised with synthetic fixtures.

const MILE_EDGES = [15, 30, 50];
const MIN_EDGES = [20, 40, 60];
const MILE_LABELS = ['0_15mi', '15_30mi', '30_50mi', '50plus_mi'];
const MIN_LABELS = ['0_20min', '20_40min', '40_60min', '60plus_min'];

const FORCE_BLIND_DIVISIONS = new Set(['11', '12', '14']);
const MIN_USABLE_FOR_DERIVATION = 25;
const THIN_BAND_N = 6;

// Procedural fallbacks — "local 20/50 mi or 25/55 min, regional 30/60 mi or
// 40/70 min" — used whenever a division's own bands are too thin to trust.
const TIER_DEFAULTS = {
  local: { mi: [20, 50], min: [25, 55] },
  regional: { mi: [30, 60], min: [40, 70] },
  insufficient_data: { mi: [30, 60], min: [40, 70] } // "emit regional defaults"
};

const DEFAULT_WEIGHTS = { inside_competitive: 1.0, beyond_outer: 0.0 };

// Tunable via /api/derivation-thresholds (Bid Coverage tab) — these are the
// only numbers in the whole procedure that are a judgment call rather than
// derived from data, so they're the one thing exposed as a setting.
const DEFAULT_THRESHOLDS = { competitiveDevPct: 1.0, outerDevPct: 5.0, outerWinRate: 0.10 };

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round5(v) { return Math.round(v / 5) * 5; }

// Band index for a distance given ascending edges: 0..edges.length-1 are the
// bounded bands, edges.length is the "plus" band beyond the last edge.
function bandIndexOf(distance, edges) {
  for (let i = 0; i < edges.length; i++) if (distance <= edges[i]) return i;
  return edges.length;
}

// Per-band median dev / n / win-rate for one unit (miles or minutes).
function computeBandStats(obs, edges, distField) {
  const bands = edges.length + 1;
  const buckets = Array.from({ length: bands }, () => []);
  for (const o of obs) {
    const d = o[distField];
    if (d == null) continue;
    buckets[bandIndexOf(d, edges)].push(o);
  }
  return buckets.map(list => ({
    n: list.length,
    medianDev: list.length ? median(list.map(o => o.dev_pct)) : null,
    winRate: list.length ? list.filter(o => o.won).length / list.length : null,
    list
  }));
}

// Largest edge where the CUMULATIVE median dev (everyone at or inside that
// edge) is <= competitiveDevPct (default +1%). Returns { edge, bandN } or
// null if none qualifies.
function findCompetitiveRadius(obs, edges, distField, competitiveDevPct = DEFAULT_THRESHOLDS.competitiveDevPct) {
  let best = null;
  for (const edge of edges) {
    const within = obs.filter(o => o[distField] != null && o[distField] <= edge);
    if (!within.length) continue;
    const med = median(within.map(o => o.dev_pct));
    if (med <= competitiveDevPct) best = { edge, bandN: within.length };
  }
  return best;
}

// First edge beyond which median dev > outerDevPct (default +5%) OR win
// rate < outerWinRate (default 10%).
function findOuterRadius(obs, edges, distField, outerDevPct = DEFAULT_THRESHOLDS.outerDevPct, outerWinRate = DEFAULT_THRESHOLDS.outerWinRate) {
  for (const edge of edges) {
    const beyond = obs.filter(o => o[distField] != null && o[distField] > edge);
    if (!beyond.length) continue;
    const med = median(beyond.map(o => o.dev_pct));
    const winRate = beyond.filter(o => o.won).length / beyond.length;
    if (med > outerDevPct || winRate < outerWinRate) return { edge, bandN: beyond.length };
  }
  return null;
}

function radiiForUnit(obs, edges, distField, tier, fallbackPair, thresholds) {
  let competitive = findCompetitiveRadius(obs, edges, distField, thresholds.competitiveDevPct);
  let outer = findOuterRadius(obs, edges, distField, thresholds.outerDevPct, thresholds.outerWinRate);
  const compVal = (competitive && competitive.bandN >= THIN_BAND_N) ? round5(competitive.edge) : round5(fallbackPair[0]);
  const outerVal = (outer && outer.bandN >= THIN_BAND_N) ? round5(outer.edge) : round5(fallbackPair[1]);
  return { competitive: compVal, outer: Math.max(outerVal, compVal + 5) };
}

function winRateWithin(obs, edge, distField) {
  const within = obs.filter(o => o[distField] != null && o[distField] <= edge);
  if (!within.length) return 0;
  return within.filter(o => o.won).length / within.length;
}
function winRateBeyond(obs, edge, distField) {
  const beyond = obs.filter(o => o[distField] != null && o[distField] > edge);
  if (!beyond.length) return 0;
  return beyond.filter(o => o.won).length / beyond.length;
}

function computeWeight(obs, competitiveMi, outerMi) {
  const near = winRateWithin(obs, competitiveMi, 'miles');
  const far = winRateBeyond(obs, outerMi, 'miles');
  const ratio = near > 0 ? (far / near) : (far > 0 ? 2 : 0);
  return clamp(0.3 + 0.5 * ratio, 0.3, 0.9);
}

// Per-bidder auto-flags within one division (bidder needs >=10 usable obs).
function bidderAutoFlags(bidderName, obs, competitiveMi, outerMi, thresholds) {
  if (obs.length < 10) return null;
  const devs = obs.map(o => o.dev_pct);
  const wins = obs.filter(o => o.won).length;
  const flags = {};

  if (wins === 0 && devs.every(d => Math.abs(d) <= 6)) flags.median_support_only = true;
  if (wins === 0 && median(devs) >= 10) flags.weight_multiplier = 0.2;

  const winsBeyondOuter = obs.filter(o => o.won && o.miles > outerMi).length;
  const over20 = devs.filter(d => d > 20).length;
  if (winsBeyondOuter > 0 && over20 >= 3) {
    flags.ignore_distance_decay = true;
    flags.weight_multiplier = 0.5;
  }

  // Custom competitive radius when the bidder's own crossover clearly
  // differs from the trade's (own rolling-median rule, same band edges).
  const own = findCompetitiveRadius(obs, MILE_EDGES, 'miles', thresholds.competitiveDevPct);
  if (own && own.bandN >= THIN_BAND_N && Math.abs(round5(own.edge) - competitiveMi) >= 15) {
    flags.competitive_radius_mi = round5(own.edge);
  }

  return Object.keys(flags).length ? { division: null, usable_bids: obs.length, ...flags } : null;
}

function computeDivisionStats(division, obs) {
  const miBands = computeBandStats(obs, MILE_EDGES, 'miles');
  const minBands = computeBandStats(obs, MIN_EDGES, 'minutes');
  const farBand = miBands[miBands.length - 1];
  const nearestBand = miBands[0];
  const farShare = obs.length ? farBand.n / obs.length : 0;
  return { miBands, minBands, farShare, farMedian: farBand.medianDev, nearestMedian: nearestBand.medianDev, nearestN: nearestBand.n };
}

function assignTier(division, usableN, stats) {
  if (FORCE_BLIND_DIVISIONS.has(division)) return 'distance_blind';
  if (usableN < MIN_USABLE_FOR_DERIVATION) return 'insufficient_data';
  if (stats.farShare >= 0.5 && stats.farMedian != null && stats.farMedian <= 2) return 'distance_blind';
  if (stats.nearestMedian != null && stats.nearestMedian <= -3.5 && stats.nearestN >= 6) return 'local';
  return 'regional';
}

function bandsToEvidence(bands, labels) {
  const median_dev_pct_by_band = {}, band_sample_sizes = {};
  labels.forEach((label, i) => {
    median_dev_pct_by_band[label] = bands[i].n ? bands[i].medianDev : null;
    band_sample_sizes[label] = bands[i].n;
  });
  return { median_dev_pct_by_band, band_sample_sizes };
}

// observations: [{ csi_division, bidderName, dev_pct, won, miles, minutes, basis }]
//   (already joined to a confirmed non-skip location + geocoded project; only
//   entries with a non-null dev_pct and resolved distance count as "usable")
// manualOverrides: { [bidderName]: {...fields...} } — merged over auto-flags
// previousConfig: last derived/bundled config, used to carry forward things
//   that aren't derivable from bid data (target_bidders, division names)
function deriveConfig({ observations, divisionNames = {}, manualOverrides = {}, previousConfig = null, thresholds = {} }) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const byDivision = new Map();
  for (const o of observations) {
    if (o.dev_pct == null || o.miles == null || o.minutes == null) continue;
    if (!byDivision.has(o.csi_division)) byDivision.set(o.csi_division, []);
    byDivision.get(o.csi_division).push(o);
  }

  const prevDivisions = (previousConfig && previousConfig.divisions) || {};
  const divisions = {};
  const bidderCandidates = new Map(); // bidderName -> best {division, usable_bids, flags}
  let basisSeen = new Set();

  for (const [division, obs] of byDivision.entries()) {
    obs.forEach(o => basisSeen.add(o.basis));
    const stats = computeDivisionStats(division, obs);
    const tier = assignTier(division, obs.length, stats);
    const prev = prevDivisions[division] || {};
    const name = divisionNames[division] || prev.name || division;
    const target_bidders = prev.target_bidders || 3;

    const entry = { name, tier, target_bidders };
    entry.evidence = {
      usable_bids: obs.length,
      ...bandsToEvidence(stats.miBands, MILE_LABELS),
      share_of_bids_from_50plus_mi: obs.length ? stats.miBands[stats.miBands.length - 1].n / obs.length : 0
    };

    if (tier === 'distance_blind') {
      entry.always_covered = true;
      entry.note = FORCE_BLIND_DIVISIONS.has(division)
        ? 'Vendor/national trade: no distance-price relationship in bid history. Exclude from coverage-depth mapping; assume target bidders achievable anywhere in market.'
        : 'Far-band bids dominate at/below median — treated as distance-blind for coverage purposes.';
    } else {
      const fallback = TIER_DEFAULTS[tier] || TIER_DEFAULTS.regional;
      const mi = radiiForUnit(obs, MILE_EDGES, 'miles', tier, fallback.mi, t);
      const min = radiiForUnit(obs, MIN_EDGES, 'minutes', tier, fallback.min, t);
      entry.competitive_radius_mi = mi.competitive;
      entry.outer_radius_mi = mi.outer;
      entry.competitive_radius_min = min.competitive;
      entry.outer_radius_min = min.outer;
      entry.weights = {
        ...DEFAULT_WEIGHTS,
        competitive_to_outer: Math.round(computeWeight(obs, mi.competitive, mi.outer) * 100) / 100
      };
      if (tier === 'insufficient_data') {
        entry.note = 'Not enough multi-bid packages to derive empirically. Values are regional-tier defaults; refresh after more bid events.';
      }

      // Per-bidder auto-flags (needs radii, so lives in this branch).
      const byBidder = new Map();
      for (const o of obs) {
        if (!byBidder.has(o.bidderName)) byBidder.set(o.bidderName, []);
        byBidder.get(o.bidderName).push(o);
      }
      for (const [bidderName, bObs] of byBidder.entries()) {
        const flags = bidderAutoFlags(bidderName, bObs, mi.competitive, mi.outer, t);
        if (!flags) continue;
        flags.division = division;
        const existing = bidderCandidates.get(bidderName);
        if (!existing || flags.usable_bids > existing.usable_bids) bidderCandidates.set(bidderName, flags);
      }
    }

    divisions[division] = entry;
  }

  // Carry forward divisions we have zero fresh observations for this run
  // (e.g. a division that simply had no bids since the last sync).
  for (const [division, prev] of Object.entries(prevDivisions)) {
    if (!divisions[division]) divisions[division] = prev;
  }

  const bidder_overrides = {};
  for (const [bidderName, flags] of bidderCandidates.entries()) {
    const { usable_bids, ...rest } = flags;
    bidder_overrides[bidderName] = rest;
  }
  // Manual overrides always win — deep-merge (shallow per bidder is enough,
  // these are flat field objects) over whatever auto-derived it.
  for (const [bidderName, override] of Object.entries(manualOverrides)) {
    bidder_overrides[bidderName] = { ...(bidder_overrides[bidderName] || {}), ...override };
  }

  let distance_basis = 'straight_line_miles';
  if (basisSeen.has('ors') && !basisSeen.has('haversine')) distance_basis = 'drive_time_min';
  else if (basisSeen.has('ors') && basisSeen.has('haversine')) distance_basis = 'mixed';

  return {
    meta: {
      generated: new Date().toISOString(),
      source: 'Bid Database live sync (Territory-derived)',
      method: 'Per-bid deviation from package median, packages with >=3 bids only. Distance = ' +
        (distance_basis === 'drive_time_min' ? 'ORS drive-time matrix, minutes.' : 'straight-line miles (haversine), with drive-time where available.'),
      distance_basis,
      interpretation: (previousConfig && previousConfig.meta && previousConfig.meta.interpretation) ||
        'competitive_radius = distance within which the trade historically bids at/below package median. outer_radius = distance beyond which bids are unreliable insurance numbers. Weights feed coverage-depth counting: depth(cell, division) = sum over located bidders of weight(distance) * bidder multiplier.',
      coverage_rule: (previousConfig && previousConfig.meta && previousConfig.meta.coverage_rule) ||
        'A cell is covered for a division when weighted depth >= target_bidders. Project-viability boundary = cells covered for ALL user-selected divisions (minimum rule, not average).'
    },
    defaults: (previousConfig && previousConfig.defaults) || {
      tier: 'regional', competitive_radius_mi: 30, outer_radius_mi: 60,
      weights: { inside_competitive: 1.0, competitive_to_outer: 0.7, beyond_outer: 0.0 },
      target_bidders: 3
    },
    divisions,
    bidder_overrides
  };
}

module.exports = {
  deriveConfig, median, bandIndexOf, computeBandStats, findCompetitiveRadius, findOuterRadius,
  MILE_EDGES, MIN_EDGES, MILE_LABELS, MIN_LABELS, FORCE_BLIND_DIVISIONS, MIN_USABLE_FOR_DERIVATION,
  DEFAULT_THRESHOLDS
};
