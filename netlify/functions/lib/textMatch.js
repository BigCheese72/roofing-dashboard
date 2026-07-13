// Address/name matching for inspection-report ingestion (see
// inspection-reports.js). Server-side port of the same conservative
// normalize+Levenshtein approach js/workorders.js already uses for
// duplicate-building detection (dupNormalize()/dupLevenshtein()) -- same
// algorithm, same "exact or near-exact only" philosophy, kept in this
// separate lib file because it's plain logic with no Firestore/Admin SDK
// dependency, easy to reuse from anywhere that needs it later.
//
// Matching a warranty document to the wrong roof is explicitly worse than
// not filing it at all (Mark's framing) -- every function here is
// deliberately conservative: it's fine to under-match into the review
// queue, it is not fine to over-match onto the wrong building.

function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Address-specific normalization on top of normalizeText(): strips a
// small set of common street-suffix/unit words so "123 Main St" and
// "123 Main Street" normalize identically, without trying to be a full
// address-parsing library (deliberately not pulling in a geocoding/
// address-parsing dependency for this).
const ADDRESS_STOPWORDS = new Set([
  "street", "st", "avenue", "ave", "drive", "dr", "road", "rd",
  "boulevard", "blvd", "lane", "ln", "court", "ct", "way", "place", "pl",
  "circle", "cir", "parkway", "pkwy", "highway", "hwy", "suite", "ste",
  "apt", "apartment", "unit", "building", "bldg", "floor", "fl"
]);
function normalizeAddress(s) {
  return normalizeText(s).split(" ").filter(w => w && !ADDRESS_STOPWORDS.has(w)).join(" ");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = [], cur = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur.slice();
  }
  return prev[n];
}

// True only for an exact-after-normalization match, or one string fully
// containing the other (e.g. extracted "123 Main St" inside a building's
// full "123 Main St, Springfield, MO 65801") -- deliberately NOT using the
// Levenshtein-ratio "close enough" tier here that dup-detection uses for a
// same-tier duplicate WARNING; a warranty document needs a real match, not
// a maybe. Levenshtein is exposed separately for callers that want a
// confidence score to show a human in a review queue, never to auto-file.
function isConfidentContainmentMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 6 && b.length >= 6 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}

// Scans free text (email subject / attachment filename / body preview) for
// an address-shaped substring: a leading street number followed by a
// street name ending in a common suffix. Returns every candidate found
// (usually 0 or 1) since we'd rather try several match attempts than force
// a single, possibly-wrong extraction.
const ADDRESS_PATTERN = /\d{1,6}\s+[A-Za-z0-9.,'#\- ]{2,50}?\b(?:Street|St|Avenue|Ave|Drive|Dr|Road|Rd|Boulevard|Blvd|Lane|Ln|Court|Ct|Way|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\b\.?(?:[A-Za-z0-9.,'#\- ]{0,40})?/gi;
function extractAddressCandidates(text) {
  const s = String(text || "");
  const matches = s.match(ADDRESS_PATTERN) || [];
  return matches.map(m => m.trim()).filter(Boolean);
}

module.exports = {
  normalizeText, normalizeAddress, levenshtein, isConfidentContainmentMatch,
  extractAddressCandidates
};
