"use strict";
// ONE place for every CompanyCam de-duplication knob. Mark's rule for this
// feature: "don't hardcode magic numbers scattered around; one config."
//
// Nothing else in the dedup path is allowed to invent a tolerance, a page
// size, or a collection name -- companyCamDedup.js reads this and only this.
//
// Every value is overridable from a Netlify environment variable (no redeploy
// of code needed, just a value change + redeploy), and the environment is read
// at CALL time, not at module load, so a running function picks up a changed
// value on its next cold start and tests can flip a knob per-case.
//
// WHY THE DEFAULTS ARE WHAT THEY ARE
//   timeToleranceSeconds  3  -- EXIF DateTimeOriginal is whole-second; CompanyCam
//                               stores unix seconds; a phone's clock and the
//                               upload path can disagree by a second or two.
//                               Wider than ~5s starts merging genuinely
//                               different shots in a burst, which would be a
//                               FALSE SKIP (lost photo) -- the expensive kind.
//   distanceToleranceMeters 5 -- consumer GPS is ~3-10m noisy (the app already
//                               says so in openPinModal()/companycam.js). Two
//                               readings of the SAME spot land inside 5m; two
//                               different roof defects usually do not.
//   alwaysHash            true -- see companyCamDedup.js: hashing every candidate
//                               (not just the metadata-less ones) is what lets
//                               the ledger catch a photo whose CompanyCam copy
//                               was pinned at a FINDING PIN rather than at its
//                               own GPS, which the primary check cannot see.
//                               Costs one Storage read (~200-400KB) per photo.
//                               Set CC_DEDUP_ALWAYS_HASH=false to hash only the
//                               photos that have no usable metadata.
//   assumedUtcOffsetMinutes null -- deliberately "refuse to guess". A naive
//                               timestamp with no offset cannot be compared to
//                               a UTC one without knowing the zone, and guessing
//                               wrong is exactly the "everything reads as new"
//                               failure this feature exists to avoid. The CLIENT
//                               resolves EXIF local time -> epoch ms while it
//                               still knows the device's zone (see
//                               parseExifCapturedAt() in js/photos.js), so the
//                               server normally receives an unambiguous number
//                               and never needs this. Set it (e.g. -300 for
//                               US Central DST) only if a naive timestamp is
//                               genuinely reaching the server.
const DEFAULTS = {
  enabled: true,
  timeToleranceSeconds: 3,
  distanceToleranceMeters: 5,
  hashFallback: true,
  alwaysHash: true,
  assumedUtcOffsetMinutes: null,
  indexPerPage: 100,
  indexMaxPages: 20,          // 20 x 100 = up to 2,000 existing photos scanned
  // Wall-clock ceiling on building that index, and the more important of the
  // two limits. Verified against the live API (2026-07-28): a real project can
  // hold thousands of photos, and paginating it all would take longer than a
  // Netlify function is allowed to run -- the push would die with a timeout
  // instead of doing its job. Whichever limit is hit first stops the scan and
  // marks the result truncated.
  //
  // Truncating is safe in the direction that matters: CompanyCam returns
  // newest-first, so what gets dropped is the OLDEST photos -- the least likely
  // to match a shot taken on site today -- and a miss means an extra upload
  // (recoverable), never a skipped photo (not).
  indexMaxMillis: 6000,
  indexCacheTtlMs: 15 * 60 * 1000,
  ledgerCollection: "cc_push_ledger",
  maxHashBytes: 40 * 1024 * 1024
};

const ENV_NAMES = {
  enabled: "CC_DEDUP_ENABLED",
  timeToleranceSeconds: "CC_DEDUP_TIME_TOLERANCE_SECONDS",
  distanceToleranceMeters: "CC_DEDUP_DISTANCE_TOLERANCE_METERS",
  hashFallback: "CC_DEDUP_HASH_FALLBACK",
  alwaysHash: "CC_DEDUP_ALWAYS_HASH",
  assumedUtcOffsetMinutes: "CC_DEDUP_ASSUMED_UTC_OFFSET_MINUTES",
  indexPerPage: "CC_DEDUP_INDEX_PER_PAGE",
  indexMaxPages: "CC_DEDUP_INDEX_MAX_PAGES",
  indexMaxMillis: "CC_DEDUP_INDEX_MAX_MILLIS",
  indexCacheTtlMs: "CC_DEDUP_INDEX_CACHE_TTL_MS",
  ledgerCollection: "CC_DEDUP_LEDGER_COLLECTION",
  maxHashBytes: "CC_DEDUP_MAX_HASH_BYTES"
};

// Bounds. A typo in a Netlify env var must not be able to turn dedup into a
// photo shredder: a 3-hour time window with a 50km radius would skip almost
// everything. Anything outside these bounds falls back to the default and says
// so in the returned config (cfg.warnings), which the push summary surfaces.
const BOUNDS = {
  timeToleranceSeconds: { min: 0, max: 300 },
  distanceToleranceMeters: { min: 0, max: 250 },
  assumedUtcOffsetMinutes: { min: -840, max: 840 },
  indexPerPage: { min: 1, max: 100 },
  indexMaxPages: { min: 1, max: 200 },
  indexMaxMillis: { min: 500, max: 20000 },
  indexCacheTtlMs: { min: 0, max: 60 * 60 * 1000 },
  maxHashBytes: { min: 1024, max: 200 * 1024 * 1024 }
};

function parseBool(raw) {
  const s = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].indexOf(s) >= 0) return true;
  if (["0", "false", "no", "off"].indexOf(s) >= 0) return false;
  return null;
}

function getDedupConfig(overrides) {
  const cfg = {};
  const warnings = [];
  Object.keys(DEFAULTS).forEach(function (key) {
    const fallback = DEFAULTS[key];
    const raw = process.env[ENV_NAMES[key]];
    let value = fallback;
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      if (typeof fallback === "boolean") {
        const b = parseBool(raw);
        if (b === null) warnings.push(ENV_NAMES[key] + "=" + raw + " is not a boolean -- using " + fallback);
        else value = b;
      } else if (typeof fallback === "number" || key === "assumedUtcOffsetMinutes") {
        const n = Number(raw);
        if (!isFinite(n)) {
          warnings.push(ENV_NAMES[key] + "=" + raw + " is not a number -- using " + fallback);
        } else {
          const b = BOUNDS[key];
          if (b && (n < b.min || n > b.max)) {
            warnings.push(ENV_NAMES[key] + "=" + n + " is outside [" + b.min + ", " + b.max + "] -- using " + fallback);
          } else {
            value = n;
          }
        }
      } else {
        value = String(raw).trim();
      }
    }
    cfg[key] = value;
  });
  // Explicit per-call overrides (tests, and any future per-project tuning) win
  // over the environment, and are NOT bounds-checked -- a caller inside this
  // repo is trusted in a way a typo'd env var is not.
  if (overrides && typeof overrides === "object") {
    Object.keys(overrides).forEach(function (k) {
      if (overrides[k] !== undefined) cfg[k] = overrides[k];
    });
  }
  cfg.warnings = warnings;
  return cfg;
}

module.exports = { getDedupConfig, DEFAULTS, ENV_NAMES, BOUNDS };
