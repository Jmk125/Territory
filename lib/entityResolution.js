'use strict';

// Bidder ↔ Territory-location matching cascade (Phase 2a). Pure functions —
// no DB access — so the whole cascade can be exercised with plain fixtures.
const stringSimilarity = require('string-similarity');

const STOPWORDS = new Set([
  'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'companies', 'the'
]);

const FUZZY_THRESHOLD = 0.88;

// lowercase, treat '&' as equivalent to 'and' (a very common real-world
// naming inconsistency — "A & B Electric" vs "A and B Electric"), strip
// remaining punctuation, drop stopwords, collapse whitespace.
function normalizeName(raw) {
  if (!raw) return '';
  const withAnd = String(raw).toLowerCase().replace(/&/g, ' and ');
  const stripped = withAnd.replace(/[^\w\s]/g, ' ');
  const words = stripped.split(/\s+/).filter(Boolean).filter(w => !STOPWORDS.has(w));
  return words.join(' ').trim();
}

// "The Apostolos Group, Inc. dba Thomarios" -> "Thomarios"
function dbaTail(locationName) {
  const m = String(locationName || '').match(/\bdba\b(.+)$/i);
  return m ? m[1].trim() : null;
}

// Every normalized name form a location answers to: its own name, plus (if
// present) the text after " dba " — so a dba'd location matches on either.
function buildLocationIndex(locations) {
  const index = [];
  for (const loc of locations) {
    const norm = normalizeName(loc.name);
    if (norm) index.push({ locationId: loc._id, norm });
    const tail = dbaTail(loc.name);
    if (tail) {
      const tailNorm = normalizeName(tail);
      if (tailNorm && tailNorm !== norm) index.push({ locationId: loc._id, norm: tailNorm });
    }
  }
  return index;
}

// Every distinct normalized form a bidder answers to: canonical name + aliases.
function bidderNormForms(bidderName, aliases) {
  const forms = new Set();
  const cn = normalizeName(bidderName);
  if (cn) forms.add(cn);
  for (const a of aliases || []) {
    const an = normalizeName(a);
    if (an) forms.add(an);
  }
  return [...forms];
}

function collectHits(forms, locationIndex, predicate) {
  const hits = new Set();
  for (const form of forms) {
    for (const e of locationIndex) {
      if (predicate(form, e.norm)) hits.add(e.locationId);
    }
  }
  return hits;
}

// Run the cascade for one bidder against the full location index. Returns
// { method, locationId, confirmed } or null (no match / left unlinked).
// Ambiguous exact/prefix hits deliberately return null rather than guessing —
// e.g. "Lake Erie Electric" resolving to more than one branch office.
function matchBidder(bidderName, aliases, locationIndex) {
  const forms = bidderNormForms(bidderName, aliases);
  if (!forms.length) return null;

  const exactHits = collectHits(forms, locationIndex, (form, norm) => norm === form);
  if (exactHits.size === 1) return { method: 'exact', locationId: [...exactHits][0], confirmed: true };
  if (exactHits.size > 1) return null;

  const prefixHits = collectHits(
    forms, locationIndex,
    (form, norm) => form.length >= 3 && norm.startsWith(form + ' ')
  );
  if (prefixHits.size === 1) return { method: 'prefix', locationId: [...prefixHits][0], confirmed: true };
  if (prefixHits.size > 1) return null;

  let best = null;
  for (const form of forms) {
    for (const e of locationIndex) {
      const ratio = stringSimilarity.compareTwoStrings(form, e.norm);
      if (ratio >= FUZZY_THRESHOLD && (!best || ratio > best.ratio)) {
        best = { ratio, locationId: e.locationId };
      }
    }
  }
  if (best) return { method: 'fuzzy', locationId: best.locationId, confirmed: false };

  return null;
}

// Best candidate regardless of threshold — used to show a "closest guess"
// in the review UI even when it's too weak to auto-suggest, so a human can
// eyeball a near-miss (e.g. "Electrical" vs "Electric") and confirm it in
// one click instead of hunting through the full location list.
function findBestCandidate(bidderName, aliases, locationIndex) {
  const forms = bidderNormForms(bidderName, aliases);
  if (!forms.length || !locationIndex.length) return null;
  let best = null;
  for (const form of forms) {
    for (const e of locationIndex) {
      const ratio = stringSimilarity.compareTwoStrings(form, e.norm);
      if (!best || ratio > best.ratio) best = { ratio, locationId: e.locationId };
    }
  }
  return best;
}

module.exports = { normalizeName, dbaTail, buildLocationIndex, bidderNormForms, matchBidder, findBestCandidate, FUZZY_THRESHOLD };
