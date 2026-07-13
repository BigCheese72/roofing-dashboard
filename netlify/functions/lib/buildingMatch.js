// Decides which building an inspection report belongs to (see
// inspection-reports.js, which is the only caller).
//
// Lives in its own lib file for the same reason lib/textMatch.js does: it's
// plain logic with no Firestore/Admin-SDK dependency, so it can be unit
// tested directly (tests/buildingMatch.test.js) without standing up
// firebase-admin. The poller passes in an already-loaded array of buildings.
//
// THE RULE, which is not negotiable: a warranty inspection filed against the
// wrong roof is worse than not filing it at all. A false trip to the review
// queue costs Mark ten seconds. A silent misfile costs a warranty claim and
// a customer's trust. So anything short of exactly ONE confident,
// unambiguous match goes to the review queue for a human to assign. This
// code never guesses.
//
// Every path produces a `decision` record alongside the match: what it
// matched, what it REJECTED, and why -- including near-misses (a building on
// the same street with a different house number; a name that only matched as
// a substring). inspection-reports.js audit-logs that record on every
// ingestion, filed or queued, so a wrong filing can always be traced back to
// the decision that produced it.
const { compareAddresses, compareNames, extractAddressCandidates } = require("./textMatch");

const MAX_LOGGED_NEAR_MISSES = 10;

function dedupeById(list) {
  const seen = new Set(); const out = [];
  list.forEach(b => { if (!seen.has(b.id)) { seen.add(b.id); out.push(b); } });
  return out;
}

function matchBuilding(buildings, candidateText) {
  const rawAddrCandidates = extractAddressCandidates(candidateText);
  const nearMisses = [];
  const addrMatches = [];

  buildings.forEach(b => {
    if (!b.location) return;
    // Most informative result across all extracted address candidates:
    // a match wins; otherwise keep the first rejection reason.
    let best = null;
    rawAddrCandidates.forEach(c => {
      const r = compareAddresses(c, b.location);
      if (!best || (r.match && !best.match)) best = Object.assign({ candidate: c }, r);
    });
    if (!best) return;
    if (best.match) {
      addrMatches.push(b);
    } else if (best.reason === "street_number_mismatch" || best.reason === "street_name_diverges") {
      // A real near-miss: same street, wrong house number (or vice versa).
      // Precisely the class the old raw-substring rule used to file silently.
      nearMisses.push({
        buildingId: b.id, buildingName: b.name, buildingLocation: b.location,
        stage: "address", reason: best.reason, candidate: best.candidate
      });
    }
  });

  const uniqueAddr = dedupeById(addrMatches);
  const base = {
    candidateText: candidateText,
    addressCandidates: rawAddrCandidates,
    buildingsConsidered: buildings.length
  };
  const misses = () => nearMisses.slice(0, MAX_LOGGED_NEAR_MISSES);

  if (uniqueAddr.length === 1) {
    return {
      building: uniqueAddr[0], method: "address",
      matchedText: rawAddrCandidates.join(" | "),
      decision: Object.assign({}, base, {
        stage: "address", method: "address",
        matchedBuildingId: uniqueAddr[0].id,
        matchedBuildingLocation: uniqueAddr[0].location,
        nearMisses: misses()
      })
    };
  }
  if (uniqueAddr.length > 1) {
    // Two buildings genuinely fit. Never pick one -- that's a coin flip on
    // somebody's warranty.
    return {
      building: null, method: "ambiguous_address",
      matchedText: rawAddrCandidates.join(" | "),
      decision: Object.assign({}, base, {
        stage: "address", method: "ambiguous_address", matchedBuildingId: null,
        ambiguousCandidates: uniqueAddr.map(b => ({ id: b.id, name: b.name, location: b.location })),
        nearMisses: misses()
      })
    };
  }

  // ---- Fallback: name. Weaker evidence than an address, so it's gated on
  // word boundaries AND distinctiveness (see textMatch.js compareNames). ----
  const nameMatches = [];
  buildings.forEach(b => {
    const r = compareNames(candidateText, b.name);
    if (r.match) {
      nameMatches.push(b);
    } else if (r.wouldHaveMatchedUnderOldRule) {
      // The old raw-substring rule WOULD have filed onto this building.
      // Log it: this is the bug visibly not happening.
      nearMisses.push({
        buildingId: b.id, buildingName: b.name, buildingLocation: b.location,
        stage: "name", reason: r.reason, rejectedByNewRule: true
      });
    }
  });

  const uniqueName = dedupeById(nameMatches);
  if (uniqueName.length === 1) {
    return {
      building: uniqueName[0], method: "name", matchedText: uniqueName[0].name,
      decision: Object.assign({}, base, {
        stage: "name", method: "name",
        matchedBuildingId: uniqueName[0].id, matchedBuildingName: uniqueName[0].name,
        nearMisses: misses()
      })
    };
  }
  if (uniqueName.length > 1) {
    return {
      building: null, method: "ambiguous_name", matchedText: null,
      decision: Object.assign({}, base, {
        stage: "name", method: "ambiguous_name", matchedBuildingId: null,
        ambiguousCandidates: uniqueName.map(b => ({ id: b.id, name: b.name, location: b.location })),
        nearMisses: misses()
      })
    };
  }

  return {
    building: null, method: "no_match", matchedText: null,
    decision: Object.assign({}, base, {
      stage: "none", method: "no_match", matchedBuildingId: null,
      nearMisses: misses()
    })
  };
}

module.exports = { matchBuilding, dedupeById, MAX_LOGGED_NEAR_MISSES };
