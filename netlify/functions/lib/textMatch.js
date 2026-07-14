// Address/name matching for inspection-report ingestion (see
// inspection-reports.js).
//
// Matching a warranty document to the wrong roof is explicitly worse than
// not filing it at all (Mark's framing). A false trip to the review queue
// costs ten seconds. A silent misfile costs a warranty claim and a
// customer's trust. So every function here is deliberately conservative:
// it is fine to under-match into the review queue, it is NOT fine to
// over-match onto the wrong building. When in doubt: DO NOT AUTO-FILE.
//
// ---------------------------------------------------------------------
// WHY THIS FILE WAS REWRITTEN -- read before "simplifying" it
// ---------------------------------------------------------------------
// The original implementation compared normalized addresses and building
// names with a RAW SUBSTRING test (String.indexOf). That silently filed
// reports onto the wrong roof, because substrings do not respect token
// boundaries:
//
//   "1234 oak".indexOf("234 oak")   !== -1  -> a report for 1234 Oak Ave
//                                              auto-filed onto 234 Oak Ave
//   "112 elm".indexOf("12 elm")     !== -1  -> 12 Elm St    -> 112 Elm St
//   "1500 park".indexOf("500 park") !== -1  -> 500 Park Way -> 1500 Park Way
//   "ridgewood...".indexOf("ridge") !== -1  -> a building named "Ridge"
//                                              captured "Ridgewood Elementary"
//   "oakstone...".indexOf("oaks")   !== -1  -> "Oaks" captured "Oakstone"
//
// All five are covered by regression tests in tests/textMatch.test.js.
// If you change the matching primitives, those tests must still pass.
//
// The fix is TOKEN ALIGNMENT, not a tighter substring:
//   * addresses -- the leading street NUMBER must match EXACTLY, and the
//                  street-name tokens must line up from the start;
//   * names     -- must match on whole-token (word) boundaries, and a name
//                  too short or too generic to be real evidence is not
//                  allowed to auto-file at all.
// ---------------------------------------------------------------------

function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(s) {
  const n = normalizeText(s);
  return n ? n.split(" ").filter(Boolean) : [];
}

// Street-suffix / unit words carry no identifying information ("123 Main St"
// and "123 Main Street" are the same roof), so they're dropped before
// comparison. Deliberately not a full address-parsing/geocoding dependency.
const ADDRESS_STOPWORDS = new Set([
  "street", "st", "avenue", "ave", "drive", "dr", "road", "rd",
  "boulevard", "blvd", "lane", "ln", "court", "ct", "way", "place", "pl",
  "circle", "cir", "parkway", "pkwy", "highway", "hwy", "suite", "ste",
  "apt", "apartment", "unit", "building", "bldg", "floor", "fl"
]);

function addressTokens(s) {
  return tokenize(s).filter(w => !ADDRESS_STOPWORDS.has(w));
}

function normalizeAddress(s) {
  return addressTokens(s).join(" ");
}

// Splits a normalized address into its leading street number and the
// remaining (street-name) tokens. An address with no leading number is
// unusable for confident matching -- callers refuse to auto-file on it.
function parseAddress(s) {
  const toks = addressTokens(s);
  if (!toks.length) return { number: null, rest: [], tokens: [] };
  if (!/^\d+$/.test(toks[0])) return { number: null, rest: toks, tokens: toks };
  return { number: toks[0], rest: toks.slice(1), tokens: toks };
}

// True when one token array is a leading run (prefix) of the other. Street
// names come immediately after the house number, so a genuine partial --
// extracted "100 Main" vs stored "100 Main, Springfield MO 65801" -- always
// agrees from the FIRST street-name token onward. Requiring a prefix (rather
// than "appears anywhere") is what stops "100 N Main" matching "100 Main":
// those diverge at token 0 and are, in fact, different roofs.
function isTokenPrefix(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (!shorter.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

// THE address gate. Both sides must carry a street number, the numbers must
// be EXACTLY equal (this is the check whose absence caused 1234 Oak -> 234
// Oak), and the street-name tokens must align from the start.
//
// Returns a structured result, not a bare boolean, so the caller can
// audit-log WHY a near-miss was rejected -- when something does go wrong,
// Mark needs to see how it decided.
function compareAddresses(candidate, buildingLocation) {
  const c = parseAddress(candidate);
  const b = parseAddress(buildingLocation);

  if (!c.tokens.length || !b.tokens.length) {
    return { match: false, reason: "empty_address" };
  }
  if (!c.number || !b.number) {
    // No house number on one side => not enough to be sure. Queue it.
    return { match: false, reason: "no_street_number" };
  }
  if (c.number !== b.number) {
    // Same street, different building -- the near-miss most worth logging.
    const sameStreet = isTokenPrefix(c.rest, b.rest);
    return { match: false, reason: sameStreet ? "street_number_mismatch" : "different_address" };
  }
  if (!c.rest.length || !b.rest.length) {
    // A bare number with no street name is not an address.
    return { match: false, reason: "no_street_name" };
  }
  if (!isTokenPrefix(c.rest, b.rest)) {
    return { match: false, reason: "street_name_diverges" };
  }
  return { match: true, reason: "address_token_aligned" };
}

function isConfidentAddressMatch(candidate, buildingLocation) {
  return compareAddresses(candidate, buildingLocation).match === true;
}

// ---- Name matching ----
//
// Name is FALLBACK evidence, only consulted when no address matched, and it
// is much weaker than an address. Two guards:
//
// 1. WORD BOUNDARIES. The building's name tokens must appear as a contiguous
//    whole-token run in the candidate text. "Ridge" no longer captures
//    "Ridgewood Elementary"; "Oaks" no longer captures "Oakstone Industrial".
//
// 2. DISTINCTIVENESS. A name too short or too generic is not evidence at all
//    -- a building called "Shop" or "Warehouse" would otherwise match any
//    email that happens to mention a shop or a warehouse. Such names are
//    refused for auto-filing and sent to the review queue instead. A
//    deliberate bias toward the queue: we would rather ask Mark than guess.
const GENERIC_NAME_TOKENS = new Set([
  "shop", "office", "store", "plant", "depot", "annex", "main", "north",
  "south", "east", "west", "building", "warehouse", "school", "church",
  "gym", "clinic", "center", "centre", "unit", "site", "roof", "house"
]);

// A single-token name must be reasonably long AND not generic to auto-file.
// Multi-token names ("Main Plaza", "Riverside Depot") are distinctive enough.
const MIN_SINGLE_TOKEN_NAME_LEN = 6;

function isNameDistinctiveEnough(name) {
  const toks = tokenize(name);
  if (!toks.length) return false;
  if (toks.length >= 2) return true;
  const t = toks[0];
  if (GENERIC_NAME_TOKENS.has(t)) return false;
  return t.length >= MIN_SINGLE_TOKEN_NAME_LEN;
}

// Contiguous whole-token run containment.
function containsTokenRun(haystackTokens, needleTokens) {
  if (!needleTokens.length || needleTokens.length > haystackTokens.length) return false;
  for (let i = 0; i + needleTokens.length <= haystackTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < needleTokens.length; j++) {
      if (haystackTokens[i + j] !== needleTokens[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function compareNames(candidateText, buildingName) {
  const nameToks = tokenize(buildingName);
  if (!nameToks.length) return { match: false, reason: "empty_name", wouldHaveMatchedUnderOldRule: false };

  const textToks = tokenize(candidateText);
  const wordBoundaryHit = containsTokenRun(textToks, nameToks);

  // Did the OLD (buggy) raw-substring rule think this was a match? Recording
  // it lets the audit log show exactly which reports the previous code would
  // have silently misfiled -- and proves this one didn't.
  const substringHit =
    nameToks.join(" ").length >= 4 &&
    normalizeText(candidateText).indexOf(normalizeText(buildingName)) !== -1;

  if (!wordBoundaryHit) {
    return {
      match: false,
      reason: substringHit ? "name_substring_only_not_word_boundary" : "name_absent",
      wouldHaveMatchedUnderOldRule: substringHit
    };
  }
  if (!isNameDistinctiveEnough(buildingName)) {
    return {
      match: false,
      reason: "name_too_generic_to_autofile",
      wouldHaveMatchedUnderOldRule: substringHit
    };
  }
  return { match: true, reason: "name_word_boundary", wouldHaveMatchedUnderOldRule: substringHit };
}

function isConfidentNameMatch(candidateText, buildingName) {
  return compareNames(candidateText, buildingName).match === true;
}

// Scans free text (email subject / attachment filename) for an address-shaped
// substring: a street number followed by a street name and a known suffix.
//
// Unlike the original, this STOPS at the street suffix instead of greedily
// swallowing up to 40 trailing characters. That greedy tail used to drag
// unrelated words into the address ("100 Main St inspection" -> "100 main
// inspection"; "12 Elm St.pdf" -> "12 elm pdf"), which made matching depend
// on incidental subject-line wording -- sometimes masking a real collision,
// sometimes causing a spurious miss. An optional unit/suite designator is
// still captured, since it genuinely belongs to the address.
const ADDRESS_PATTERN = new RegExp(
  "\\d{1,6}\\s+" +                                   // house number
  "(?:[A-Za-z0-9'.#-]+\\s+){0,5}?" +                 // street-name words (lazy)
  "(?:Street|St|Avenue|Ave|Drive|Dr|Road|Rd|Boulevard|Blvd|Lane|Ln|Court|Ct|" +
  "Way|Place|Pl|Circle|Cir|Parkway|Pkwy|Highway|Hwy)\\b\\.?" +
  "(?:\\s*,?\\s*(?:Suite|Ste|Apt|Unit|Bldg|Building)\\.?\\s*[A-Za-z0-9-]+)?", // optional unit
  "gi"
);

function extractAddressCandidates(text) {
  const s = String(text || "");
  const matches = s.match(ADDRESS_PATTERN) || [];
  return matches.map(m => m.trim().replace(/[.,\s]+$/, "")).filter(Boolean);
}

// Exposed for callers that want a confidence score to SHOW A HUMAN in the
// review queue. Never used to auto-file -- a warranty document needs a real
// match, not a maybe.
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

module.exports = {
  normalizeText, tokenize, normalizeAddress, addressTokens, parseAddress,
  isTokenPrefix, containsTokenRun,
  compareAddresses, isConfidentAddressMatch,
  compareNames, isConfidentNameMatch, isNameDistinctiveEnough,
  extractAddressCandidates, levenshtein,
  ADDRESS_STOPWORDS, GENERIC_NAME_TOKENS, MIN_SINGLE_TOKEN_NAME_LEN
};
