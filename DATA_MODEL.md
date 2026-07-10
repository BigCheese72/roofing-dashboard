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

### `users`

Application users and role metadata.

Example fields:

```js
{
  accountId,
  email,
  displayName,
  role: "admin", // admin | manager | technician | viewer
  active: true,
  createdAt,
  updatedAt,
  lastLoginAt
}
```

Notes:

- Authentication provider details can live here or in a related auth profile.
- Role names should map to Firestore security rules.
- **Interim state**: the current app does not have real user accounts yet. It ships a
  PIN-based "admin mode" — the PIN itself is verified server-side
  (`netlify/functions/admin.js`, `ADMIN_PIN` env var) and destructive Firestore
  operations run through that function via the Firebase Admin SDK, with
  `firestore.rules` blocking client-side deletes on the affected collections
  entirely. It's real enforcement, just not real *identity* — there's one shared PIN,
  not per-user accounts, so it can't tell techs apart or produce a real audit trail of
  who deleted what. Replace with this `users`/`role` model (paired with Firebase Auth
  and rules keyed to `request.auth`) rather than extending the PIN approach further,
  once per-user accounts are worth the added complexity.

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
  createdAt,
  updatedAt,

  // LEGACY fields — kept for backward compatibility, see "Multi-roof backward
  // compatibility" below. Never read these directly in new code; always go
  // through getBuildingRoofs()/saveBuildingRoofs() in index.html.
  roofSystem,
  roof_base_map_type: null,
  roof_base_map_url: null,
  roof_base_map_bounds: null,
  roof_assets: [],
  roof_outlines: []
}
```

**`roofs[]` item shape**:

```js
{
  id,       // "roof_default" for a synthesized/first roof, or genId("roof")
  label,    // "Roof 1" by default, editable, e.g. "East Wing"
  roofSystem,
  roof_base_map_type: null, // "roof_plan" | "sketch" | "drone_ortho"
  roof_base_map_url: null,
  roof_base_map_bounds: null,
  roof_assets: [],   // same shape as before, now per-roof — see below
  roof_outlines: [], // same shape as before, now per-roof — see below
  createdAt,
  updatedAt
}
```

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

**`roof_outlines[]` item shape** (implemented, not just proposed — see "RoofMapper" in
`DEV_NOTES.md`). Also lives on each roof in `roofs[]` now, not directly on the building:

```js
{
  id,             // genId("rmo")
  ring,           // [{lat,lng}, ...] closed polygon (first point repeated last)
  center,         // {lat,lng} centroid
  areaSqFt,
  perimeterFt,
  source,         // "osm" (Phase 1 — always OpenStreetMap/Overpass)
  osmId,          // e.g. "way/12345"
  osmType,        // "way" | "relation"
  tags,           // raw OSM tags at capture time (name, building, addr:*, ...)
  isSiteBoundary, // true if this was a fallback property/site polygon, not a
                  // real building footprint — see "RoofMapper" in DEV_NOTES.md
  createdAt
}
```

A building can have more than one — re-surveyed later, multiple roof sections, a
correction — the array is append-only; the newest entry is the current one. Always
real lat/lng (from Overpass), same as a finding pin or roof asset in satellite mode;
not rendered on a building's custom `roof_plan`/`sketch` base map for the same
coordinate-system reason pins/assets aren't (see `DEV_NOTES.md`).

Notes:

- Current app derives buildings from Job Name and Bill To.
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
  jobName,
  location,
  serviceDate,
  technician,
  siteContact,
  roofSystem,
  roofId, // which of buildingId's roofs[] this work order is for — see DEV_NOTES.md
          // "Multiple roofs per building, part 2". null/omitted means the
          // building's first roof (implemented as currentRoofId in index.html).
  reportedArea,
  findings: [], // each: { id, condition, location, warranty, pin } — see DEV_NOTES.md
  repairs: [],
  warrantable,
  nonWarrantable,
  summary,
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
  reportId,
  date,
  technician,
  roofId, // which roof this report/event is for — see "Multiple roofs per building,
          // part 2" in DEV_NOTES.md. "roof_default" for anything predating this field.
  roofType,
  title,
  summary,
  isActivity: false, // true for a manually logged activity — see "Manually logged
                      // activities" in DEV_NOTES.md
  notes, // free-text description, activities only
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  pins: [], // denormalized from findings with a pin — see DEV_NOTES.md. Each pin also
            // carries its own roofId (same value as the event's), used by the Roof Map
            // to show only the pins for the currently-selected roof.
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

## Migration Notes

- Keep current `workorders` behavior stable until Phase 2 data cleanup is complete.
- Add `accountId` fields before multi-account SaaS work.
- Preserve existing document IDs or store legacy IDs during migration.
- Build Firestore indexes alongside new dashboard queries.
- Update security rules whenever new collections become active.
