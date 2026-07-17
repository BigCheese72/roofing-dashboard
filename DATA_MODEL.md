# Future Firebase Data Model

This document proposes the future Firestore shape for RoofOps. It is not an implementation checklist for the current field app. The current app already uses some of these concepts, but the future model should become more explicit, account-scoped, and dashboard-friendly over time.

## Design Principles

- Keep field work fast and resilient.
- Scope future SaaS data by `accountId`.
- Keep large binary files out of Firestore documents.
- Store photo/PDF metadata and external references in Firestore.
- Preserve an append-only history trail for buildings.
- Avoid migrations that interrupt the current Watkins field workflow.

## Proposed Collections

### `accounts`

Top-level tenant/company record for a future SaaS platform.

Example fields:

```js
{
  name: "Watkins Roofing",
  slug: "watkins-roofing",
  status: "active",
  plan: "internal",
  createdAt,
  updatedAt
}
```

Notes:

- This becomes the tenant boundary in Phase 5.
- Existing Watkins-only data can later be migrated under one account.

### `users` (implemented, Phase 1 of the auth build — see `docs/AUTH_DESIGN.md`)

Per-user privilege **mirror** — non-authoritative. The Firebase custom claims on
the user's ID token (`{ owner, role, mfaOk }`, deliberately small — see "Custom
claims size" in `docs/AUTH_DESIGN.md`) are the real enforcement truth; this doc
exists for display/query only. **No client write path at all, for any field** —
every write goes through `netlify/functions/auth.js` via the Admin SDK
(`firestore.rules`: `allow write: if false`, unconditionally). A user can never
modify their own privilege record, not even their own `displayName`.

```js
// users/{uid}  (uid matches the Firebase Auth user's uid)
{
  uid,
  email,
  displayName,
  role,             // roleId, e.g. "field_tech" — matches a roles/{roleId} doc.
                     // "owner" is set only by bootstrap_owner/transfer_owner.
  permissions: {},   // resolved snapshot for display/query only, NOT authoritative
                      // — real checks always re-read the live roles/{role} doc.
                      // Currently written as {} (unused) — Phase 2+ may populate
                      // it for a role-management UI's convenience.
  projectRoles: {},  // placeholder for project-scoped access (superintendent/
                      // project_manager's "proj"-valued permissions) — shape not
                      // finalized until Phase 2/3 build the scoping resolution
  status,            // "active" | "disabled" (Phase 4: disable/recovery flows)
  mfaEnrolled,        // bool (Phase 4: MFA build-out)
  owner,             // bool — true only for the current owner; mirrors the
                      // claims field of the same name
  createdAt, updatedAt,
  createdBy,          // "bootstrap" for the first owner, else the assigning
                      // admin/owner's uid
  lastLoginAt         // not yet populated — no code currently writes this
}
```

Read access (`firestore.rules`): a user may read their own doc; an owner or admin
may read anyone's — checked directly against the caller's own verified token
(`request.auth.token.owner`/`.role`), no extra Firestore lookup needed.

**PIN-based admin mode (`netlify/functions/admin.js`, `ADMIN_PIN`) is untouched
and still fully functional** — this auth system is layered alongside it, not
replacing it yet. The PIN toggle continues to gate exactly what it always has
until a later phase formally migrates those actions onto claims-based checks.

### `roles` (implemented, Phase 1 — see `docs/AUTH_DESIGN.md`)

Data-driven role → permission grid. Adding a role is a data change (add a doc);
adding a permission *key* is a deliberate code change
(`netlify/functions/lib/permissions.js`'s `PERMISSION_KEYS`). Seeded with 9
approved roles via `netlify/functions/auth.js`'s `seed_roles` action, not written
directly.

```js
// roles/{roleId}
{
  id,            // matches the doc id, e.g. "field_tech"
  label,         // "Field Tech"
  description,
  permissions: {
    // permKey -> true | false | "proj" | "own" | "billing"
    // true    = granted, unconditionally
    // false   = not granted (also the default for any key not present)
    // "proj"  = granted, scoped to the user's assigned projects (projectRoles)
    // "own"   = granted, scoped to records the user themself created
    // "billing" = granted, scoped to billing-relevant fields/records only
    // Scope-string enforcement (resolving "proj"/"own"/"billing" against a
    // specific document) is Phase 2/3 work — this doc only defines the data.
  },
  isSystem,      // true for "owner"/"admin" only — protected, cannot be edited
                 // or deleted (not yet enforced by a role-editor UI, since one
                 // doesn't exist yet; the two isSystem roles just aren't
                 // touched by anything currently built)
  rank,          // display-ordering hint only, not used for enforcement
  createdAt, updatedAt
}
```

`firestore.rules`: readable by any signed-in user, `write: if false` always —
every write goes through `seed_roles` (Admin SDK).

### `audit_logs` (implemented — Phase 1 foundation + Phase 2 coverage expansion,
see `docs/AUTH_DESIGN.md`)

Append-only. **Immutable by design**: `firestore.rules` denies `update`/`delete`
to every client without exception, including the owner. Written by server
functions only (Admin SDK, not subject to rules) — started in Phase 1 for the
highest-risk actions (`bootstrap_owner`, `assign_role`, `transfer_owner`); Phase 2
adds every other mutating `admin.js` action (`delete_building`,
`delete_history_event`, `set_building_roof_map`, `set_roof_profile`).

```js
// audit_logs/{genId}
{
  actorUid, actorRole,  // who did it (if known), and what role they held at the
                        // time. null/null for a PIN-only caller (see actorMethod)
  actorEmail,           // Phase 2 addition — null for PIN-only callers, and for
                        // Phase 1 entries written before this field existed
  actorMethod,          // Phase 2 addition — "claims" (a real signed-in Firebase
                        // Auth identity was available) | "pin_only" (the shared
                        // ADMIN_PIN only — still true for 100% of production
                        // traffic and most of dev today, since admin mode
                        // doesn't require login yet). Absent on Phase 1 entries
                        // (bootstrap_owner/assign_role/transfer_owner always have
                        // a real caller by construction, so this wasn't needed
                        // there).
  ts,                    // Date.now() — server-set, not client-supplied. Every
                         // writer uses this same plain-number field (not a
                         // Firestore serverTimestamp()) — kept deliberately
                         // consistent across every audit_logs writer in the app.
  target: { collection, id, roofId }, // what was acted on. roofId only present
                                       // for roof-scoped actions (Phase 2)
  action,                 // e.g. "assign_role", "bootstrap_owner", "transfer_owner",
                          // "delete_building", "set_roof_profile"
  before, after           // shallow before/after snapshot of the changed field(s)
                          // -- an action-appropriate SUMMARY, not a full-document
                          // backup (e.g. delete_building's "before" is name/
                          // address/customerId + deleted-record counts, not the
                          // entire building doc with its full roofs[]/history)
}
```

Surfaced in-app via a new "🔒 Audit Log (admin)" card in the Reports view
(`list_audit_log` admin.js action, same PIN-gated precedent as the existing
`list_feedback` action).

Read access: gated by the caller's live `roles/{role}.permissions['audit.view']`
(a rules `get()` on the caller's own role doc — the same resolve-at-check-time
pattern `netlify/functions/lib/authGuard.js` uses server-side), or unconditionally
for the owner.

### `app_settings/auth_bootstrap` (new doc under the existing `app_settings`
collection — see "Global photo size setting" above for the collection's other
use)

```js
{
  ownerBootstrapped, // bool — flips true exactly once, on the first successful
                     // bootstrap_owner call. Refuses every subsequent
                     // bootstrap_owner attempt once true — not a standing
                     // backdoor, a single-use setup step.
  bootstrappedAt,
  ownerUid
}
```

### `customers`

Customer or bill-to organizations.

Example fields:

```js
{
  accountId,
  name,
  slug,
  primaryContactName,
  primaryContactEmail,
  primaryContactPhone,
  billingAddress,
  notes,
  createdAt,
  updatedAt
}
```

Notes:

- Current app derives customers from the Bill To field.
- Future UI should allow explicit customer selection and cleanup.

### `buildings`

Physical buildings/sites associated with a customer.

**A building can have one or more roofs** (implemented, not just proposed — started
2026-07-10, see "Multiple roofs per building" in `DEV_NOTES.md`). Example fields:

```js
{
  accountId,
  customerId,
  name,
  slug,
  address,
  companyCamProjectId,
  companyCamProjectName,
  roofs: [ /* see "roofs[] item shape" below */ ],
  geoCache, // optional — { lat, lng, source: "geocoded", updatedAt }. Set the first
            // time Buildings Near Me (see DEV_NOTES.md) has to geocode this
            // building's `location` address (Nominatim), so every later run reads
            // this instead of re-geocoding — a plain client `update`, same
            // open-write permissions as every other field here. Absent for a
            // building never resolved this way, e.g. one whose location was
            // already known from a roof outline's centroid instead (checked
            // first, since it's already-fetched and usually more accurate than a
            // street-address geocode).
  archived, // optional bool — soft delete (shipped 2026-07-11, see "Building archive
            // + move/reassign a roof" in DEV_NOTES.md). Replaces the old hard-delete-
            // only admin path; absent/false for every normal building. Set/cleared only
            // via admin.js's archive_building/unarchive_building actions (Admin SDK,
            // PIN-gated + audited), never a plain client write. Hides the building from
            // default list/search UI (Building History, RoofMapper's building picker/
            // save modal, the Change Order picker) without touching roofs/features/
            // history/companyCamProjectId at all — a visibility flag, not a data change.
  archivedAt, // number (Date.now()) or null — set alongside archived:true, cleared on unarchive.
  createdAt,
  updatedAt,

  // LEGACY fields — kept for backward compatibility, see "Multi-roof backward
  // compatibility" below. Never read these directly in new code; always go
  // through getBuildingRoofs()/saveBuildingRoofs() in index.html.
  roofSystem,
  roof_base_map_type: null,
  roof_base_map_url: null,
  roof_base_map_bounds: null,
  roof_base_map_synthetic: false,
  roof_assets: [],
  roof_outlines: []
}
```

**`roofs[]` item shape**:

```js
{
  id,       // "roof_default" for a synthesized/first roof, or genId("roof")
  label,    // "Roof 1" by default, e.g. "East Wing", "Warehouse". Set at
            // creation (rmAddRoofAndSave()) and renameable any time after —
            // from Building History (promptRenameRoof()) or, since
            // 2026-07-11, natively from RoofMapper itself without leaving
            // the screen (rmRenameLinkedRoof(), tap the map label or the
            // "Rename Roof" button — see "Rename a roof, discoverable from
            // RoofMapper" in DEV_NOTES.md; before that fix the function
            // existed but had no reachable entry point from RoofMapper).
            // NOT enforced unique at the Firestore level — collisions are
            // caught at the UI layer only, by rmResolveUniqueRoofLabel()
            // (warns + auto-suggests "{label} (2)"), shared by both the
            // creation and rename paths. Rendered as a persistent map
            // label (not just a picker-dropdown option) via the shared
            // roofLabelMarker() helper in both RoofMapper and Building
            // History's roof map. Note: an outline object passed into
            // renderBuildingMap() may carry a transient `_roofLabel` copied
            // from its owning roof at render time (openBuildingHistory()) —
            // display-only, never persisted on the outline itself.
  roofSystem,
  roof_base_map_type: null, // "roof_plan" | "sketch" | "drone_ortho"
  roof_base_map_url: null,
  roof_base_map_bounds: null,
  roof_base_map_synthetic: false, // true only when roof_base_map_type is "sketch"
    // AND the image is actually an uploaded drone ortho traced via
    // RoofMapper's ortho-upload flow (rmPersistOrthoBaseMap()), not a real
    // hand-drawn sketch — purely cosmetic (e.g. so a future label can say
    // "drone photo" instead of "sketch"), never read by any type-dispatch
    // logic. Deliberately saved as "sketch" (x/y pixel space), NOT
    // "drone_ortho" (real lat/lng bounds), even though it's visually a
    // drone photo — its bounds are synthetic (Null Island), and
    // "drone_ortho" is treated as georeferenced everywhere else in the
    // app (pin/asset placement would save real lat/lng against a fake
    // origin otherwise). See "Ortho upload: persist with the roof + pick
    // from an existing CompanyCam photo" in DEV_NOTES.md.
  roof_assets: [],   // same shape as before, now per-roof — see below
  roof_outlines: [], // same shape as before, now per-roof — see below
  profile: {}, // admin-editable roof facts — see "roof.profile shape" below.
               // Absent/undefined until an admin sets one — read via
               // getRoofProfile(roof), never directly.
  labelPos, // optional {lat, lng} or null/absent (shipped 2026-07-11, see "Draggable
            // roof labels" in DEV_NOTES.md) — a custom position the tech dragged this
            // roof's map label to, overriding the default recomputed-centroid
            // placement. Any plain client write (roofLabelMarker()'s onDragEnd via
            // rmSaveRoofLabelPos()), same tier as roof_assets placement, not
            // admin-gated. Reset to null (back to centroid) via rmResetRoofLabelPos().
            // Cleared automatically when this roof is split (rmSaveSplitSectionsToExistingRoof())
            // since the old position may no longer make sense on the new, smaller
            // shape. Carries through to the multi-roof export (rmBuildMultiRoofOutlineSvg())
            // and Building History's own read-only roof map, not just RoofMapper's.
  createdAt,
  updatedAt
}
```

**`roof.profile` shape** (implemented, not just proposed — third increment, 2026-07-10,
see "Admin roof-profile fields" in `DEV_NOTES.md`). A permanent profile of facts ABOUT a
roof — distinct from its living blueprint (`roof_assets`/`roof_outlines`, any tech can
edit) and its history (`building_history_events`, one entry per report/activity):

```js
{
  installDate,               // "YYYY-MM-DD" or ""
  estimatedAgeYears,         // number or null — used when installDate isn't known
  healthScore,               // number 0-100, or null
  condition,                 // "" | "Excellent" | "Good" | "Fair" | "Poor" | "Critical"
  manufacturer,              // free text
  deckType,                  // free text
  insulationType,            // free text
  warrantyProvider,          // free text
  warrantyExpiration,        // "YYYY-MM-DD" or ""
  warrantyStatus,            // "" | "Active" | "Expired" | "Unknown" — a DIFFERENT
                              // field from a report/timeline entry's warrantyStatus
                              // (computed per-report from findings) — nesting under
                              // profile avoids any naming collision between the two.
  drainageNotes,              // free text
  customerContacts,           // free text (name/phone/email, one field, not structured)
  internalNotes,              // free text — visible to everyone, same as every other
                               // field here, per spec; not staff-only despite the name
  replacementHistory,         // free text — a running log, not a structured array
  estimatedRemainingLifeYears, // number or null
  updatedAt
}
```

`roofSystem` itself is NOT nested under `profile` — it's the pre-existing top-level roof
field (see above), reused/reconciled rather than duplicated; the Roof Profile UI edits
it directly alongside the nested profile fields.

**Write path — routes through `netlify/functions/admin.js`'s `set_roof_profile`
action, not a direct client write**, even though `firestore.rules` already permits
client updates to `buildings`. Deliberate choice, matching the existing custom
base-map precedent (`set_building_roof_map`): a roof profile is a shared, building-wide
fact worth the same server-enforced admin gate, not per-work-order draft data a tech
should casually overwrite. Same dual-write rule as everywhere else in the multi-roof
model: `roofSystem` mirrors to the legacy singular field only while the building has
exactly one roof; `profile` itself has no legacy equivalent to mirror into at all (it's
a brand-new concept — production's old code never had a notion of a roof profile), so
it only ever lives inside the matching `roofs[]` entry. The action allow-lists profile
field names server-side before writing, so an arbitrary client payload can't add
unexpected keys.

**Multi-roof backward compatibility** — dev and production share one live Firestore,
and production's code only reads the legacy singular fields directly. Two adapter
functions in `index.html` make this safe:

- `getBuildingRoofs(bld)` — pure read-time function, never writes. A building with a
  real `roofs[]` array uses it as-is. Any other building (untouched by this feature, or
  brand new) gets one virtual roof synthesized from its legacy singular fields, `id:
  "roof_default"`, `label: "Roof 1"` — so every existing building looks exactly like it
  did before `roofs[]` existed, with zero migration.
- `saveBuildingRoofs(buildingId, roofs)` — always writes the new `roofs[]` array, and
  additionally mirrors `roofs[0]` back onto the legacy singular fields whenever a
  building still has exactly one roof. Production, which only reads those legacy
  fields, keeps seeing correct, current data for every still-single-roof building.
  **Once a building has a second real roof, the legacy fields stop being updated** for
  that building — production would show its last-synced single-roof snapshot until
  this feature ships to `main`. Deliberate, accepted limit: it only applies to a
  building actively using the brand-new multi-roof capability, which doesn't exist on
  production regardless.

**Work orders are roof-scoped** (implemented, not just proposed — second increment,
2026-07-10): a work order carries `roofId` (default `null`, meaning "the building's
first roof" — see `currentRoofId` in `index.html`). One work order's findings/pins all
belong to the SAME roof — a tech visits one roof per work order, not several at once —
so there's no per-finding roofId, just one per work order. A pin saved before this
field existed has no `roofId` at all, which is always treated as `"roof_default"`
(the building's first/only roof), same convention as everywhere else in the multi-roof
design. The picker to choose a roof only appears in the pin modal, and only once the
resolved building actually has more than one roof — a single-roof work order never
sees it. `buildPinsForHistoryEvent()` and `logReportAndHistoryEvent()`'s payload both
carry `roofId` now, and the Building History Roof Map filters its pins by whichever
roof is currently selected.

RoofMapper's save-to-building (`rmSaveOutlineToBuilding`) and the admin "Roof Base Map"
upload/clear card are both roof-aware now too (same increment) — see "Multiple roofs
per building, part 2" in `DEV_NOTES.md` for the full rundown, including the
`netlify/functions/admin.js` change that made the base-map card work again for
multi-roof buildings (it had been disabled for them in the first increment).

Remaining known follow-up gap:
- The building picker and Building History building list still read the legacy
  `roofSystem` field directly for their one-line summary (display-only) — accurate for
  single-roof buildings, may go stale for a multi-roof building until this is revisited.

**`roof_assets[]` item shape** (implemented, not just proposed — see "Roof assets" in
`DEV_NOTES.md`). Lives on each roof in `roofs[]` now, not directly on the building:

```js
{
  id,       // genId("ast")
  type,     // "drain" | "scupper" | "hvac" | "pipe_flashing" | "vent" | "hatch" |
            // "expansion_joint" | "skylight" | "curb" | "penetration" | "core_cut" |
            // "test_cut" | "safety_hazard" | "other"
  label,    // optional free text, e.g. "RTU-2"
  notes,    // optional free text
  lat, lng, x, y, // exactly one of {lat,lng} or {x,y}, same convention as finding pins
  createdAt, updatedAt
}
```

Distinct from a finding's `pin` (see `work_orders` below): a pin is historical, tied to
one report; a roof asset is permanent, independent of any work order, and is expected
to be added/moved/removed as the roof itself changes — the difference between "where a
leak was" and "where the roof drain has always been."

**`roof_markups[]` item shape** (implemented, not just proposed — see "Markup layer" in
`DEV_NOTES.md`). Bluebeam-style annotations (arrows/text/shapes/clouds/measurements/
count markers), drawn on RoofMapper's own map. Lives on each roof in `roofs[]`, alongside
`roof_assets[]`/`roof_outlines[]`:

```js
{
  id,       // genId("mkp")
  type,     // "arrow" | "text" | "rect" | "circle" | "cloud" | "measure" | "count"
  points,   // [{lat,lng}, ...] -- 1 point (text/count), 2 (arrow/rect/circle/measure),
            // or 3+ (cloud, closed polygon, NOT repeating the first point last)
  color,    // hex string, one of RM_MARKUP_COLORS
  text,     // caption -- only meaningful for type "text", empty string otherwise
  count,    // only for type "count" -- 1-based sequence number among this roof's
            // count markers at the time it was placed
  author,   // free text -- getFieldHistory("technician")[0], same "last technician
            // name typed into any form" convention used elsewhere, not a real login
  createdAt,
  period,   // new Date().toLocaleDateString() at creation time -- what the "Show"
            // filter in the Markup panel groups/filters by
  roofId    // which roof this belongs to (redundant with the array it lives in,
            // kept for symmetry with finding pins' roofId and so a markup is still
            // self-describing if ever pulled out of its roof's array)
}
```

Distinct from a roof asset: an asset is a permanent physical feature of the roof itself
(a drain really is there); a markup is a drawn annotation about the roof (an arrow
pointing at where to re-flash, a cloud around a problem area) — closer in spirit to a
Bluebeam markup layer than to the roof's own blueprint. Only two of the three surfaces
Mark asked markups to work over exist yet (the live satellite map, and a drone ortho set
as a roof's custom base map); the third — an uploaded drawing/PDF — is blocked on
"drawings/documents as attachable artifacts" not existing as a concept yet (see
`ROADMAP.md`).

**`roof_outlines[]` item shape** (implemented, not just proposed — see "RoofMapper" in
`DEV_NOTES.md`). Also lives on each roof in `roofs[]` now, not directly on the building:

```js
{
  id,             // genId("rmo")
  ring,           // [{lat,lng}, ...] closed polygon (first point repeated last)
  center,         // {lat,lng} centroid
  areaSqFt,
  perimeterFt,
  source,         // "osm" (OpenStreetMap/Overpass footprint) | "manual_trace"
                  // (tapped points) | "walk_corners" (GPS-recorded corners) |
                  // "ortho_trace" (tapped points on an uploaded FLAT drone
                  // image with no geodata, synthetic origin — see "Trace
                  // directly on an uploaded drone orthomosaic" in
                  // DEV_NOTES.md) | "geotiff_trace" (shipped 2026-07-11 —
                  // tapped points on an uploaded, TRUE georeferenced
                  // GeoTIFF, real lat/lng straight from the map, no
                  // synthetic origin and no calibration needed — see
                  // "GeoTIFF georeferenced ortho support" in DEV_NOTES.md) |
                  // "kml_groundoverlay_trace" (shipped 2026-07-12 -
                  // tapped points on a KMZ/KML GroundOverlay image placed
                  // from its KML north/south/east/west bounds)
  osmId,          // e.g. "way/12345" — only set when source is "osm"
  osmType,        // "way" | "relation" — only set when source is "osm"
  tags,           // raw OSM tags at capture time — only set when source is "osm"
  isSiteBoundary, // true if this was a fallback property/site polygon, not a
                  // real building footprint — see "RoofMapper" in DEV_NOTES.md
  tracedOnOrtho,  // optional — true only when source is "ortho_trace". Flags
                  // that ring/center sit at a synthetic (Null Island) origin,
                  // not a real-world position, until manual alignment (not
                  // built) happens — shape/area/perimeter are exact once
                  // calibrated, only WHERE on Earth it sits is a placeholder.
  georeferencedSource, // optional - true when source is "geotiff_trace" or
                  // "kml_groundoverlay_trace".
                  // The OPPOSITE meaning of tracedOnOrtho above: the ring is
                  // already a real-world lat/lng position, not a placeholder.
                  // GeoTIFF traces are RTK/survey-grade source material;
                  // KMZ/KML GroundOverlay traces are approximate georeferenced
                  // overlays and must not be reported as RTK survey-grade.
  measurementMethod, // optional - persisted audit label for exports/reports:
                  // { kind, accuracyClass, label, maxQuadBBoxErrorFt? }.
                  // Examples: RTK GeoTIFF trace, KMZ super-overlay tile trace
                  // (approximate; not RTK survey-grade), flat image trace,
                  // walked phone-GPS corners, OSM footprint trace.
  groundOverlay,  // optional - only when source is "kml_groundoverlay_trace":
                  // Single-image shape: { sourceType:"kml_groundoverlay" |
                  // "kmz_groundoverlay", sourceFileName, kmlFileName,
                  // imageHref, imageFileName, bounds:{north,south,east,west},
                  // rotation }. Google Earth super-overlay shape:
                  // { sourceType:"kmz_superoverlay", sourceFileName,
                  // imageFileName, tileCount, kmlLevel, highestKmlLevel,
                  // highestTileCount, mobileTileCapApplied, mobileTileCap,
                  // bounds, maxQuadBBoxErrorFt, tiles:[...] }.
                  // Rotation/quads are preserved as metadata; current Leaflet
                  // display warns but does not warp or rotate rasters.
  createdAt,
  calibration     // LEGACY -- superseded by edgeMeasurements[]/captureSource/
                  // scaleSource below (Codex's field-measured-dimensions work,
                  // merged to dev via PR #7), kept only as the migration
                  // source for outlines calibrated before that model existed
                  // (Mark's real Tri-Delta roofs among them). Two possible
                  // shapes. Manual: set once a tech taps an edge dimension
                  // label and enters a real tape-measured length
                  // (calibrate-by-known-edge) — { edgeIndex, measuredFt,
                  // calibratedAt, factor? }. `factor` may be ABSENT on an
                  // older record -- absence does NOT mean no rescale
                  // happened; it means the exact factor wasn't captured at
                  // the time. edgeIndex identifies which edge (ring[i] to
                  // ring[i+1]) was the calibration reference — also drives the
                  // checkmark highlight on that edge's label on the map.
                  // Inherited: auto-applied by rmFinishTrace() when a
                  // manual_trace/ortho_trace outline is finished on a
                  // building that already taught a scale factor via an
                  // earlier roof's manual calibration — no edge tap
                  // involved, so no edgeIndex — { inherited: true, factor,
                  // calibratedAt } instead. Either shape scales the entire
                  // ring/areaSqFt/perimeterFt/center by one uniform factor
                  // about the ring's centroid — see "Self-scaling dimension
                  // calibration" and "Multi-roof accuracy: scale inheritance,
                  // vertex snapping, precision cursor" in DEV_NOTES.md. Absent/
                  // undefined for an outline never calibrated either way.
                  // rmMigrateLegacyCalibration() (js/roofmapper.js) folds a
                  // legacy entry into edgeMeasurements[] the first time the
                  // outline is touched by anything measurement-related; new
                  // writes go straight to edgeMeasurements[] and this field
                  // is left null/absent going forward.
  edgeMeasurements // array, shipped with Codex's field-measured-dimensions
                  // work (PR #7) -- per-edge tape readings, append-only
                  // (never hard-deleted; superseded/invalidated instead, see
                  // invalidatedAt below). Each entry:
                  //   { id, edgeIndex, measuredFt, factor, appliedFactor,
                  //     composedAppliedFactor, rescaleApplied, decision,
                  //     source: "measured", measuredAt, measuredBy, rawInput,
                  //     conflictResolution?, invalidatedAt?, invalidatedReason?,
                  //     legacyCalibration? }
                  // `factor` is the raw measuredFt/currentEdgeFt ratio at
                  // measurement time; `appliedFactor` is what ACTUALLY got
                  // applied to the ring's geometry -- these differ whenever
                  // `decision` isn't "use" (see below). NEVER re-derive
                  // `factor` yourself from live ring geometry -- on a
                  // "keep_existing" decision, ring-length vs. measuredFt is
                  // the residual DISAGREEMENT between tape and drawing, not
                  // a factor that was ever applied; treating that quotient
                  // as provenance is a derived number wearing a badge.
                  // `decision` (only meaningfully distinct from "use" when a
                  // conflict was shown, tracked separately as
                  // conflictResolution on that same entry): "use" (rescale
                  // applied in full) | "keep_existing" (recorded, geometry
                  // NOT rescaled, appliedFactor forced to 1) | "average"
                  // (geometric-mean blend applied) | "record_only" (logged
                  // with no active conflict, tech chose not to rescale).
                  // `invalidatedAt`/`invalidatedReason` mark a superseded
                  // entry (e.g. "superseded_by_remeasure",
                  // "legacy_calibration_ring_mismatch", "geometry_edit") --
                  // still present in the array, just no longer active; a
                  // report or the live map's field-measurement history
                  // should surface these, not just the active ones. Read via
                  // rmActiveEdgeMeasurements()/rmActiveMeasuredEdges()/
                  // rmAllMeasuredEdgeRecords()/rmGetMeasuredEdge()
                  // (js/roofmapper.js) -- these already fold in the legacy
                  // `calibration` migration and the tolerance/conflict
                  // logic; don't re-derive that classification elsewhere.
  captureSource   // object, shipped with PR #7 -- HOW the geometry was
                  // traced. Immutable once set; a field measurement never
                  // changes it. { mechanism, rank, kind, accuracyClass,
                  // label, maxQuadBBoxErrorFt? }. `mechanism` is the
                  // reliable machine key ("geotiff" | "kmz_overlay" |
                  // "ortho_image" | "walk_corners" | "osm" | "manual_map" |
                  // "unknown"); `rank` is a coarser 4-value bucket
                  // ("survey" | "approximate" | "estimated" | "unknown") --
                  // note this does NOT 1:1 match any 5-value vocabulary a
                  // consumer might expect (OSM and walk_corners both map to
                  // existing `rank` buckets rather than getting their own).
                  // Computed by rmBuildCaptureSource(), persisted via
                  // rmRefreshOutlineMeasurementModel()/
                  // rmOutlineMeasurementPersistence() so a report can read
                  // it directly off the outline without recomputing.
  scaleSource     // object, shipped with PR #7 -- HOW the scale factor was
                  // determined. Independent of captureSource -- NOT a rung
                  // on the same confidence ladder; an inherited-scale
                  // satellite trace does not outrank a georeferenced GeoTIFF
                  // capture, and the two are never compared against each
                  // other. { kind, label, factor?, appliedFactor?,
                  // edgeIndex?, measuredFt?, measurementId?, fromOutlineId? }.
                  // `kind`: "measured" (a human taped/wheeled an edge of
                  // THIS roof -- edgeIndex/measuredFt/measurementId
                  // present) | "inherited" (scale carried from an
                  // adjoining/parent roof via inheritedScale below --
                  // fromOutlineId present) | "image" (scale derived from
                  // the georeferenced source image itself, no human
                  // measurement) | "none" (no field scale recorded at all).
                  // `factor`/`appliedFactor` may be null even when
                  // kind==="measured" -- see the back-compat note on
                  // `calibration` above; null means unknown, NOT "not
                  // measured." Computed by rmBuildScaleSource(); read this,
                  // don't recompute it.
  measurementMethod // object, persisted audit label combining the two above
                  // for convenience/back-compat: { kind, accuracyClass,
                  // label, captureSource, scaleSource, scaleProvenance,
                  // maxQuadBBoxErrorFt? }. `label` is a TERSE INTERNAL
                  // string ("Method: Capture: X. Scale: Y.") meant for the
                  // live map's own status line -- a customer-facing report
                  // should build its own two-sentence prose from
                  // captureSource.label/scaleSource.kind directly (see
                  // "Report provenance rendering" in DEV_NOTES.md) rather
                  // than surfacing this internal string verbatim.
  inheritedScale  // optional object -- present when scaleSource.kind is
                  // "inherited". { fromOutlineId, factor, scaleSource:
                  // "measured", derivedAt }. Built by
                  // rmBuildInheritedScaleRecord() when a new manual_trace/
                  // ortho_trace outline is finished on a building that
                  // already taught a scale factor from an earlier roof's
                  // field measurement -- see "Scale inheritance" in
                  // DEV_NOTES.md.
  squared         // optional — set once "🟦 Square Up" has been applied (shipped
                  // 2026-07-10). Shape: { at, tolerance, snappedEdges }. Snaps
                  // near-90°/axis-aligned edges clean (within `tolerance` degrees
                  // of the polygon's own dominant rotation), preserving each
                  // edge's original length exactly (corners move, measured
                  // lengths don't) — a real diagonal cut or an arc/curve run
                  // outside tolerance is left as traced. Absent/undefined for an
                  // outline never squared. Recommended order is trace -> Square
                  // Up -> Calibrate (calibrating last means whichever edge is
                  // chosen reflects its final post-square length regardless of
                  // what squaring did upstream) — see "Square Up" in
                  // DEV_NOTES.md.
}
```

**Blob-splitting** (shipped 2026-07-11 — see "Split a roof outline into labeled
sections" in `DEV_NOTES.md`): no new field or `source` value — splitting one traced
outline into several roof sections happens entirely in client-side state
(`rmSplitState`, never persisted) BEFORE the first save. Once a tech confirms and
saves, each resulting section becomes an entirely ordinary `roofs[]` entry with its
own ordinary `roof_outlines[]` entry — `source`/`tags`/`calibration` are copied
straight from the ORIGINAL (pre-split) outline, since splitting doesn't change how
the shape was originally captured, only subdivides it. `rmSaveSplitSectionsToBuilding()`
writes all N new roofs in one `saveBuildingRoofs()` call rather than N round-trips.

A building can have more than one — re-surveyed later, multiple roof sections, a
correction — the array is append-only; the newest entry is the current one. Real
lat/lng in every case except `source: "ortho_trace"` (synthetic Null Island origin,
see `tracedOnOrtho` above); not rendered on a building's custom `roof_plan`/`sketch`
base map for the same coordinate-system reason pins/assets aren't (see `DEV_NOTES.md`).

Notes:

- Current app derives buildings from Job Name and Bill To. As of 2026-07-10 this also
  happens eagerly from the "Select Existing Building" picker when a tech picks a
  CompanyCam-only project (not yet a building here) — `ensureCustomerAndBuilding()` is
  the same idempotent upsert either way, just triggered at selection time instead of
  save time. See "Change Order building picker" in `DEV_NOTES.md`.
- The building should become the anchor for long-term roof history.
- `roof_base_map_type`/`url`/`bounds` are implemented, not just proposed — see
  "Roof map: base maps + location pins" in `DEV_NOTES.md` for the full design (pin
  schema, satellite default via Leaflet + Esri tiles, x/y mode for `roof_plan`/
  `sketch`, real lat/lng mode for `drone_ortho`). Setting/clearing goes through
  `netlify/functions/admin.js`, not a plain client write — it's shared/building-wide,
  not per-work-order draft data.
- Satellite is the default and requires no base map fields at all (Esri tiles + a
  geocoded address); `roof_base_map_type`/`url`/`bounds` only exist for the
  `roof_plan`/`sketch`/`drone_ortho` exception cases.
- `roof_base_map_bounds` requires a companion offline tool
  (`tools/geotiff_to_webmap.py`) to produce — extracting real-world coordinates from a
  drone orthomosaic isn't something the app itself does. See `DEV_NOTES.md`.

### `work_orders`

Normalized future work order collection. The current app uses `workorders`; migration can happen later.

Example fields:

```js
{
  accountId,
  customerId,
  buildingId,
  workOrderNo,
  woType, // "Leak / Service" (default/legacy) | "Change Order" | "Inspection" |
          // "Repair" | "Warranty" — see WORK_ORDER_TYPES in index.html, easy to
          // extend. Absent/undefined always reads as "Leak / Service" (collect()/
          // fill() both fall back to WORK_ORDER_TYPES[0]) — see "Work order type"
          // in DEV_NOTES.md.
  jobName,
  location,
  serviceDate,
  technician,
  siteContact,
  roofSystem,
  roofId, // which of buildingId's roofs[] this work order is for — see DEV_NOTES.md
          // "Multiple roofs per building, part 2". null/omitted means the
          // building's first roof (implemented as currentRoofId in index.html).
          // Stays the PRIMARY roof (roofIds[0]) even when roofIds below is set,
          // for backward compat with every reader that only knows this field.
  roofIds, // optional array — every DISTINCT roof this work order's findings actually
           // touch (reportDistinctRoofIds() in index.html), null/absent for a single-
           // roof case. Originally Inspection-only (a multi-select checkbox picker,
           // currentRoofIds); generalized 2026-07-11 to ANY work order type since GPS
           // auto-assign (see "GPS auto-assign photos to roofs" in DEV_NOTES.md) can
           // give individual findings different roofIds regardless of type. A finding
           // covering more than one roof carries its OWN roofId (see findings below)
           // rather than sharing this work order's single roofId.
  roofLabels, // optional object {roofId: label} — denormalized alongside roofIds so
              // renderLeakReportDoc() (synchronous, no Firestore access mid-render)
              // can show real roof names in the report instead of raw ids. Sourced
              // from lastLookupRoofInfo, the last roofs[] lookup for this building.
  reportedArea, // Leak/Service intake field — hidden on the form for woType ===
                // "Inspection" (an inspection isn't triggered by a reported leak, per
                // Mark's "Inspection form overhaul"), field itself unaffected/still
                // present in the schema for older/other-type data.
  findings: [], // each: { id, condition, location, warranty, pin, roofId, roofIdAmbiguous }
                // — see DEV_NOTES.md. roofId (shipped 2026-07-11) is optional/per-finding.
                // Originally only set for a multi-select Inspection (pinSelectFindingRoof());
                // now primarily set AUTOMATICALLY by GPS auto-assign
                // (rmMaybeAutoAssignRoofForPin(), point-in-polygon against the photo's
                // own GPS the moment a finding gets auto-pinned) on ANY work order type,
                // one-tap correctable via the same pinSelectFindingRoof(). roofIdAmbiguous
                // (bool) flags a low-confidence auto-assignment (near a roof boundary, or
                // outside every traced roof) for the tech to confirm — cleared the moment
                // they pick anything via the picker, even if it's the same guess.
                // buildPinsForHistoryEvent() falls back to the work order's own singular
                // roofId when a finding has neither.
                // Not applicable/hidden on the form for woType === "Repair"/"Change
                // Order", but the field itself is unchanged — those types just keep
                // an empty/unused findings array. For woType === "Inspection", the
                // section is relabeled "Roofing Inspection Findings" but stays fully
                // present and manually-addable ("+ Add Finding" unchanged) — PLUS any
                // inspectionChecklist item rated below Good auto-creates/updates/
                // removes ONE entry here, tracked via that checklist item's
                // linkedFindingId (see inspectionChecklist below and
                // syncInspectionFinding() in DEV_NOTES.md). pin.source is
                // "device_gps" for a pin placed via "Use My Location" OR
                // auto-dropped from a camera-captured photo's GPS
                // (maybeAutoPinFinding(), see "Photo-capture rework" in
                // DEV_NOTES.md) — both write the identical shape, so nothing reading
                // a pin can tell which one it was.
  inspectionChecklist: [], // Inspection-only — each:
                // { id, key, rating, notes, linkedFindingId, pin }. key is one of the 8
                // fixed INSPECTION_CHECKLIST_COMPONENTS in index.html (membrane,
                // flashings, penetrations, drainage, equipment, perimeter, interior,
                // safety) — always exactly these 8, backfilled by
                // ensureInspectionChecklist() for old/new orders alike, not an
                // addable/removable list like repairItems. rating is one of Good |
                // Fair | Poor | Critical | N/A. linkedFindingId points at the
                // auto-surfaced entry in findings[] above when rating is below Good
                // (null when Good/N/A — nothing to surface). Each item can also carry
                // an optional photo — camera capture ONLY (no library add, no
                // CompanyCam import, per Mark — the tech photographs the exact
                // condition they're rating, right there), via the same generic
                // photo.finding_id "owning row id" mechanism a finding's photo uses.
                // pin ({lat,lng,x,y,source}, same shape as finding.pin) is
                // auto-dropped from the photo's GPS the moment a checklist item's
                // first photo is captured (maybeAutoPinInspectionItem(), never
                // overwrites an existing pin) — independent of linkedFindingId, so
                // it's set regardless of rating (even a "Good" condition gets a
                // location-anchored photo). Included in buildPinsForHistoryEvent()
                // alongside finding pins, so it shows on the building's Roof Map
                // like any other pin — the "before" half of before/after-at-a-pin
                // (see "Inspection checklist photo pinning" in DEV_NOTES.md and
                // ROADMAP.md).
  photos: [], // each: { caption, img (base64), w, h, finding_id, ccPhotoId }. gps
              // (optional: {lat,lng,accuracy}) is set either by a CompanyCam import
              // (photo's own EXIF-derived location) or by in-app camera capture
              // (device GPS at the moment of capture, see captureDeviceGps() in
              // DEV_NOTES.md) — a library-picked photo has no gps key at all.
              // pin (optional: {lat,lng,x,y,source}, same shape as finding.pin) is
              // Change Order-only — a Change Order has no findings to hang a pin
              // off of, so each of its photos carries its own instead, auto-set
              // from gps by maybeAutoPinPhoto(). Absent for every other work order
              // type. See "Photo-capture rework" in DEV_NOTES.md.
  repairs: [],
  warrantable, // Warranty Determination card -- hidden on the form for woType ===
               // "Change Order" and "Inspection" (an inspection isn't itself a
               // warranty determination, that's a separate downstream decision, per
               // Mark's "Inspection form overhaul"). Not enforced at the data level.
  nonWarrantable,
  mfgServiceNo, // free text, optional — manufacturer's work order / service number
                // for a warrantable leak (Mark: "~9 times out of 10" one exists).
                // Leak/Service-only field on the form (see onWoTypeChange() in
                // index.html), but not enforced at the data level — just never
                // populated for other types since the input is hidden.
  summary,
  // Change Order-only fields — blank/absent for every other type. Only
  // rendered/editable in the form when woType === "Change Order".
  woCost,           // free text, e.g. "1250.50" — not coerced to a number
  woManHours,       // free text, e.g. "8.5"
  woMaterials,      // free text, one item per line
  woDescription,    // free text — description of work performed
  woPONumber,       // free text, optional
  woDateCompleted,  // free text (same "M/D/YY" convention as serviceDate), optional
  changeOrderSignature: null, // Change Order-only. null until signed, else
                // { img (base64 PNG data-URL, drawn on-device), printName (typed
                // text), date ("M/D/YY", auto-set to today at signing time) }.
                // Captured via the reusable signature-pad component
                // (openSignaturePad()/sigPadState in index.html — canvas +
                // pointer events, PNG not JPEG since it's sparse ink strokes not
                // a photo) opened from "✍️ Get Signature" on the Change Order
                // form. Renders into all three Change Order outputs (PDF via
                // doc.addImage(), HTML preview, plain-text) as a real
                // Signature/Print Name/Date block when present, else the
                // original blank "Approved By ___ Date ___" line — fully
                // backward-compatible, absent/null on every pre-existing order.
                // Built reusable on purpose so other forms (e.g. leak/
                // non-warranty service-order signing) can call
                // openSignaturePad({title, existing, onSave}) later — see
                // "In-app signature capture" in DEV_NOTES.md.
  // Repair-only fields — blank/absent for every other type. Only rendered/
  // editable in the form when woType === "Repair".
  repairDescription, // free text — description of repair work performed
  repairItems: [],   // each: { type, qty, notes } — type is one of REPAIR_ITEM_TYPES
                      // in index.html (Curb, Pipe Boot / Flashing, Seam, Vent, Drain,
                      // etc. — worded to align with ROOF_ASSET_TYPES but not coupled
                      // to it, these are report line items, not map pins)
  status: "draft", // draft | completed | sent | archived
  companyCamProjectId,
  createdAt,
  updatedAt,
  completedAt
}
```

Notes:

- Consider keeping photos in a subcollection or separate `photos` collection.
- Existing `workorders` can remain until a careful migration is planned.
- `WARRANTY_GUIDELINES` in index.html is a display-only reference constant (two plain
  guideline lists for techs, shown in a collapsible section on the form) — not stored
  per work order, no data model impact. Leak/Service-only ("for leaks and leaks only"
  per Mark), same visibility gate as `mfgServiceNo` above. See DEV_NOTES.md.

### `reports`

Generated report records (download/share/email actions) **and manually logged
activities** (see "Manually logged activities" below) — both are "things that happened
to a building," so they share one flat log.

Example fields:

```js
{
  accountId,
  customerId,
  buildingId,
  workOrderId, // null for a manually logged activity — see below
  workOrderNo,
  workOrderType, // "Leak / Service" (default/legacy) | "Change Order" | "Inspection" |
                 // "Repair" | "Warranty" — snapshot of the work order's woType at the
                 // time this was logged. null/absent for a manually logged activity
                 // (activities aren't tied to a work order at all).
  roofId, // which of buildingId's roofs[] this is for — "roof_default" if predates this field
  reportType: "PDF Emailed", // or an activity type string, e.g. "Drone Flight"
  isActivity: false, // true for a manually logged activity, false for a real generated report
  notes, // free-text description — activities only; empty/absent for report entries
  date,
  technician,
  roofType,
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  companyCamUploadStatus, // "saved" | "failed" | "not_linked" | null (never attempted —
                          // e.g. a manually logged activity, or an entry logged before
                          // this field existed). Set by logReportAndHistoryEvent() from
                          // uploadLinkedPdfToCompanyCam()'s result; drives the persistent
                          // "☁️ Saved to CompanyCam" / "⚠️ Not saved to CompanyCam" badge
                          // in Building History and Reports. Sticky like emailSent — an
                          // action that doesn't attempt an upload preserves whatever was
                          // already recorded. See DEV_NOTES.md.
  companyCamUploadError, // free text, set only when companyCamUploadStatus === "failed"
  pdfRef: null,
  emailSent: true,
  emailRecipients: [],
  createdAt
}
```

Notes:

- Current app writes a flat `reports` log.
- `pdfRef` is reserved. Current PDF persistence uses CompanyCam documents rather than Firebase Storage.
- Current implementation detail worth preserving in any future migration: the current
  app writes the `reports` doc and the matching `building_history_events` doc with the
  **same Firestore document id** for a generated report (one id generated per report,
  reused across both collections, upserted going forward — see "One timeline entry per
  work order" in `DEV_NOTES.md`). This lets a single delete-by-id clean up both sides of
  the pair. If this collection is ever restructured, keep some equivalent way to delete
  a report and its timeline entry together.
- **Manually logged activities are the one exception to the upsert-by-id rule above** —
  each gets its own random id (`genId("act")`) and is never merged with another, even if
  logged seconds apart on the same building/roof, because two logged activities are
  genuinely two separate things that happened (unlike a retried Send/Share/Download of
  the same report). See "Manually logged activities" in `DEV_NOTES.md`.

### `photos`

Future normalized photo metadata collection.

Example fields:

```js
{
  accountId,
  customerId,
  buildingId,
  workOrderId,
  reportId,
  source: "companycam", // upload | companycam
  caption,
  companyCamProjectId,
  companyCamPhotoId,
  thumbUrl,
  fullUrl,
  storagePath,
  capturedAt,
  createdAt
}
```

Notes:

- Avoid storing large image bytes directly in top-level documents.
- CompanyCam photos should remain externally referenced when possible.

### `building_history_events`

Append-only event timeline for each building.

Example fields:

```js
{
  accountId,
  customerId,
  customerName,
  buildingId,
  buildingName,
  eventType: "report_generated",
  workOrderId,
  workOrderNo,
  workOrderType, // see "Work order type" in DEV_NOTES.md — null/absent for a
                 // manually logged activity
  reportId,
  date,
  technician,
  roofId, // which roof this report/event is for — see "Multiple roofs per building,
          // part 2" in DEV_NOTES.md. "roof_default" for anything predating this field.
          // Stays the PRIMARY roof (roofIds[0]) when roofIds below is set.
  roofIds, // optional array — mirrors the work order's own roofIds (generalized
           // 2026-07-11 beyond just Inspection, see "GPS auto-assign photos to roofs"
           // in DEV_NOTES.md). null/absent for a single-roof event. pins[] below
           // already carries the real per-pin roofId truth regardless of this field —
           // this is display-only, for Building History's timeline to state which
           // roofs were covered.
  roofLabels, // optional array of label strings, same order as roofIds, denormalized
              // for display (timelineEventHtml()) without a lookup.
  roofType,
  title,
  summary,
  isActivity: false, // true for a manually logged activity — see "Manually logged
                      // activities" in DEV_NOTES.md
  enteredAt, // number (Date.now()) — activities only (shipped 2026-07-11, see
             // "Retroactive backfill: back-dating" in DEV_NOTES.md). WHEN this
             // record was saved, always "now" at save time — deliberately kept
             // separate from `date` (WHEN the event actually happened, tech-
             // editable, may be well in the past). isBackdatedEvent() compares
             // the two to show a subtle "Added later" flag; absent for every
             // auto-generated report (logReportAndHistoryEvent()), which is
             // always entered the same day it happens by construction.
  enteredBy, // string — activities only, who actually did the backfilling (may
             // differ from `technician`, e.g. Mark entering a job on a tech's
             // behalf). Falls back to `technician` when left blank.
  notes, // free-text description, activities only
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  companyCamUploadStatus, // "saved" | "failed" | "not_linked" | null — same field/
                          // meaning as on `reports` above, written identically in the
                          // same batch. See DEV_NOTES.md.
  companyCamUploadError,
  pins: [], // denormalized from findings with a pin — see DEV_NOTES.md. Each pin also
            // carries its own roofId (same value as the event's, unless GPS auto-assign
            // gave it a different one — see "GPS auto-assign photos to roofs" in
            // DEV_NOTES.md), used by the Roof Map to show only the pins for the
            // currently-selected roof. roofIdAmbiguous (bool, shipped 2026-07-11) flags
            // a low-confidence auto-assignment for review; set/cleared by
            // rmAutoAssignExistingPinsToRoofs()'s retroactive pass or a live
            // pinSelectFindingRoof() correction.
  photos: [], // activities only (shipped 2026-07-11) — each: {img (base64 data URL)}.
              // Existing photos attached while backfilling a retroactive record
              // (attachActivityPhotos(), a device-library picker, not camera capture) —
              // see "Retroactive backfill: attaching existing photos" in DEV_NOTES.md
              // and the Vision Pillar entry in ROADMAP.md for what's NOT built yet
              // (drawings/documents/orthos as distinct artifact types).
  pdfRef: null,
  emailSent: false,
  emailRecipients: [],
  createdAt
}
```

Notes:

- This should power the roof history timeline. Implemented — see the Building History
  tab, `renderBuildingMap()` in `index.html`.
- Keep this append-only where practical so the building history remains auditable.
- `pins[]` (implemented, not just proposed) is built by `buildPinsForHistoryEvent()`
  each time a report is generated — one entry per finding that has a pin, shaped
  `{ finding_id, condition, warranty, lat, lng, x, y, source, work_order_id,
  work_order_no, service_date, photo_ids }`. Denormalized here specifically so the
  building-wide history map reads from one query across every report instead of
  walking every work order to find its findings' pins.

### `settings`

Account-level settings and integration configuration.

Example fields:

```js
{
  accountId,
  branding: {
    companyName,
    logoUrl,
    primaryColor
  },
  email: {
    defaultFrom,
    defaultRecipients: []
  },
  integrations: {
    firebaseProjectId,
    companyCamEnabled: true,
    resendEnabled: true
  },
  reportTemplates: {},
  createdAt,
  updatedAt
}
```

Notes:

- Secrets should not live in Firestore client-readable settings.
- API keys should remain in Netlify environment variables or a future secure backend secret store.

### `app_settings` (currently implemented — distinct from the proposed `settings` above)

A small, currently-real collection for app-wide settings that every client needs to
read on load — not the future account-level `settings` model above, which remains
proposed/unimplemented. Currently just one document.

```js
// app_settings/global
{
  photoSizePref, // "small" | "medium" | "large" — see "Global photo size setting"
                 // in DEV_NOTES.md. Read by every client on load
                 // (loadGlobalPhotoSizePref()); written only via
                 // netlify/functions/admin.js's set_photo_size_pref action
                 // (admin-PIN-gated, Admin SDK). Missing/unreadable defaults
                 // to "small" client-side — never a hard error.
  updatedAt
}
```

Notes:

- `firestore.rules` (reference file) allows open read, blocks all client-side write —
  the only write path is the Admin SDK in `admin.js`, same pattern as the
  delete-only-via-admin.js rule used for `buildings`/`reports`/etc. above.
- Deliberately not gated by `accountId` yet, since there's no multi-account model in
  production — a single global doc is intentional for now, not an oversight.

### `feedback` (currently implemented)

In-app Send Feedback submissions — the 💬 button reachable from every screen. See
"Send Feedback" in `DEV_NOTES.md`.

```js
// feedback/<genId("fb")>
{
  type,           // "praise" | "confusing" | "bug" | "feature" — internal key, one
                   // of FEEDBACK_TYPES in index.html
  typeLabel,       // "👍 Works great" | "🤔 Confusing" | "🐞 Bug" | "💡 Feature request"
                   // — emoji + label, pre-built client-side so the backlog view and
                   // the emailed subject line don't each re-derive it from `type`
  comments,        // free text, optional (a bare 👍 tap with no comment is valid)
  screen,          // friendly view name the tester was on when they tapped 💬 — e.g.
                   // "Inspection Form", "RoofMapper" — see FEEDBACK_VIEW_LABELS
  technician,      // best-available identity, auto-captured: the open work order's
                   // Technician field if one's open and non-empty, else the
                   // most-recently-remembered technician name (getFieldHistory
                   // ("technician")[0]) device-wide, else "". No real accounts yet,
                   // per Mark's own framing of the ask — this is the best available
                   // identifier, not a real user reference.
  adminMode,       // bool — was the submitter in admin mode at the time
  device,          // navigator.userAgent, truncated to 200 chars
  workOrderId,     // currentId if a work order was open (edit/preview view), else null
  workOrderJobName,// that work order's Job Name, else null
  screenshot,      // optional base64 JPEG data-URL, capped ~900px/quality 0.55 (via
                   // html2canvas capturing document.body, or a manually attached
                   // photo as a fallback) — same resize-before-store discipline as
                   // work order photos, just capped smaller since these are
                   // debugging aids, not documentation. null if not attached.
  createdAt        // Date.now() at submission
}
```

Notes:

- Client can `create` but never `read`/`update`/`delete` (`firestore.rules`) — the
  admin backlog view (Reports tab, admin mode) reads it exclusively through
  `netlify/functions/admin.js`'s `list_feedback` action (Admin SDK, PIN-gated,
  newest-first, capped at 200), the same pattern used for every other admin-only
  read/write in this file. **The rules change needs a manual apply in the Firebase
  Console** to take effect for reads, same as `app_settings` above — this repo file is
  reference-only, nothing deploys it automatically.
- Every submission is also emailed to Mark (`netlify/functions/send-feedback.js`, via
  Resend) independent of whether the Firestore write succeeds — the two are
  best-effort and independent, so a network hiccup on one doesn't silently lose the
  other. The email subject always starts with the stable `[RoofOps Feedback]` token
  (regardless of type) so a mail rule can file every one of these into one Outlook
  folder reliably.

### `ai_training_labels` (currently implemented — write path only, no callers yet)

The learning-model data foundation (shipped 2026-07-16, dev only — see "AI training
labels" in `DEV_NOTES.md`). Each doc is ONE tech-confirmed issue label on ONE photo —
a labeled training example for a future learning model. Mark's framing: once photos in
leak reports get identified, each identified leak becomes training data; this
collection exists so those examples start accumulating NOW instead of being thrown
away. Pure data plumbing — no AI call, no API key anywhere.

Written exclusively via `recordConfirmedLabel()` in `js/ailabels.js` (the flows that
own the confirm/correct interaction call it when they wire up — deliberately no
callers yet). One confirm/correct action writes one clean row.

```js
// ai_training_labels/<aiLabelGenId(), "ail_..." >
{
  schemaVersion: 1,
  source,          // "leak" | "inspection" | "workorder" — which flow confirmed it
  label,           // CONTROLLED-VOCABULARY key, e.g. "ponding_water" — one of
                   // AI_ISSUE_LABELS in js/ailabels.js (28 starter keys) plus the
                   // admin-extendable app_settings/ai_label_vocab doc's extraLabels.
                   // Keys are permanent once data exists against them; labels
                   // (display text) can be reworded freely. Free text is rejected.
  labelOther,      // free text, required iff label === "other" — the escape hatch
                   // still produces a searchable string to promote into a real key
  likelyCause,     // tech's short free-text cause, optional
  photo,           // REFERENCE, NEVER a URL (signed-URL discipline — the bucket is
                   // sealed, resolution to bytes/URLs happens server-side at read
                   // time). One of:
                   //   { kind:"storage"|"workorder_embedded", workOrderId, photoIndex }
                   //     (the same pair netlify/functions/photos.js builds paths from)
                   //   { kind:"companycam", companyCamPhotoId, companyCamProjectId }
  pin,             // { lat, lng, x, y } — exactly one pair set, other pair null; same
                   // convention as finding pins/roof assets. null if no location.
  roofId,          // "roof_default" fallback, same convention as everywhere else
  roofSystem,      // material snapshot if known ("" if not)
  roofAgeYears,    // number|null — from roof.profile installDate/estimatedAgeYears
  buildingId,      // REQUIRED — the STABLE stored building doc id (stable-identity
                   // fix, PR #120), NOT a slug recomputed from Bill To + Job Name
  customerId, workOrderId, findingId, // optional context ids, null when unknown
  confirmedByUid,  // rules-enforced == request.auth.uid — a label is the tech's own
                   // attestation, not writable on someone else's behalf
  confirmedByName, // display name snapshot, optional
  confirmedAt, createdAt // plain numbers (Date.now()), audit_logs convention
}
```

Notes:

- `firestore.rules`: any signed-in user can `create` (with field validation:
  uid match, source enum, bounded label/buildingId strings, photo is a map with a
  known kind); `read`/`update`/`delete` are denied to EVERY client including the
  owner — training data references customer roof photos and is sensitive. Reads are
  Admin SDK only (future export/labeling tooling). Rules need the usual manual
  Console apply.
- **Deletion cascade** (photos are customer property):
  `netlify/functions/lib/aiLabels.js` — `purgeLabelsForBuilding()` is wired into
  `admin.js`'s `delete_building` (runs BEFORE the building doc delete so a mid-delete
  failure keeps a retry path; count lands in the audit log as `deletedAiLabels`).
  `purgeLabelsForWorkOrder()`/`purgeLabelsForPhoto()` are the documented hooks for
  the work-order-delete and photo-delete flows to call when their owners wire them.
- Vocabulary admin seam: `app_settings/ai_label_vocab` `{ extraLabels: [{key,label}] }`
  — app_settings is already world-readable/server-write-only, so extending the list is
  a data change (future admin.js action or Console edit), never a code deploy.

## Migration Notes

- Keep current `workorders` behavior stable until Phase 2 data cleanup is complete.
- Add `accountId` fields before multi-account SaaS work.
- Preserve existing document IDs or store legacy IDs during migration.
- Build Firestore indexes alongside new dashboard queries.
- Update security rules whenever new collections become active.
