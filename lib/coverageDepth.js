'use strict';

// Phase 2e — H3 hex-grid coverage-depth computation. Pure functions; the
// caller supplies the linked bidder coordinates + the derived division
// config and gets back a per-cell depth map.
const h3 = require('h3-js');

function haversineMiles(a, b) {
  const R = 3958.8, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Rectangle of H3 cells covering all supplied points, padded outward by
// paddingMiles so the grid extends past the outermost bidders/projects —
// otherwise a division whose outer radius runs past the data's own bounding
// box gets clipped and shows "fully covered" right up to the grid edge
// instead of the real falloff to zero.
function buildHexGrid(points, resolution, paddingMiles = 20) {
  if (!points.length) return [];
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const centerLat = (minLat + maxLat) / 2;
  const padLat = paddingMiles / 69;
  const padLng = paddingMiles / (69 * Math.max(0.2, Math.cos(centerLat * Math.PI / 180)));
  const poly = [
    [minLat - padLat, minLng - padLng], [minLat - padLat, maxLng + padLng],
    [maxLat + padLat, maxLng + padLng], [maxLat + padLat, minLng - padLng]
  ];
  return h3.polygonToCells(poly, resolution);
}

// bidders: [{ locationId, name, lat, lng, multiplier, medianSupportOnly,
//             ignoreDistanceDecay, competitiveRadiusMi, outerRadiusMi }]
// divCfg: the division's derived config entry (competitive_radius_mi,
//         outer_radius_mi, weights)
function computeDivisionDepth(cells, bidders, divCfg) {
  const result = {};
  for (const cell of cells) {
    const [lat, lng] = h3.cellToLatLng(cell);
    let depth = 0, secondaryDepth = 0;
    const contributors = [];
    for (const b of bidders) {
      const mi = haversineMiles({ lat, lng }, { lat: b.lat, lng: b.lng });
      const compR = b.competitiveRadiusMi != null ? b.competitiveRadiusMi : divCfg.competitive_radius_mi;
      const outR = b.outerRadiusMi != null ? b.outerRadiusMi : divCfg.outer_radius_mi;
      let w;
      if (b.ignoreDistanceDecay || mi <= compR) w = divCfg.weights.inside_competitive;
      else if (mi <= outR) w = divCfg.weights.competitive_to_outer;
      else w = divCfg.weights.beyond_outer;
      const contribution = w * (b.multiplier != null ? b.multiplier : 1);
      if (contribution <= 0) continue;
      if (b.medianSupportOnly) {
        secondaryDepth += contribution;
      } else {
        depth += contribution;
        contributors.push({ locationId: b.locationId, name: b.name, weight: Math.round(contribution * 100) / 100 });
      }
    }
    contributors.sort((a, c) => c.weight - a.weight);
    result[cell] = {
      depth: Math.round(depth * 100) / 100,
      secondaryDepth: Math.round(secondaryDepth * 100) / 100,
      contributors: contributors.slice(0, 8)
    };
  }
  return result;
}

module.exports = { haversineMiles, buildHexGrid, computeDivisionDepth };
