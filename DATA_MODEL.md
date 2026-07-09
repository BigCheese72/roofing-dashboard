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

Example fields:

```js
{
  accountId,
  customerId,
  name,
  slug,
  address,
  roofSystem,
  companyCamProjectId,
  companyCamProjectName,
  roof_base_map_type: null, // "roof_plan" | "sketch" | "drone_ortho"
  roof_base_map_url: null,  // a CompanyCam document URL when set — see DEV_NOTES.md
  roof_base_map_bounds: null, // { north, south, east, west } — drone_ortho only
  roof_base_map_updated_at: null,
  roof_assets: [], // permanent roof features (drains, HVAC units, hatches, etc.) — see below
  createdAt,
  updatedAt
}
```

**`roof_assets[]` item shape** (implemented, not just proposed — see "Roof assets" in
`DEV_NOTES.md`):

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

Generated report records, including download/share/email actions.

Example fields:

```js
{
  accountId,
  customerId,
  buildingId,
  workOrderId,
  workOrderNo,
  reportType: "PDF Emailed",
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
  **same Firestore document id** (one id generated per report, reused across both
  collections). This lets a single delete-by-id clean up both sides of the pair. If
  this collection is ever restructured, keep some equivalent way to delete a report
  and its timeline entry together.

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
  roofType,
  title,
  summary,
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  pins: [], // denormalized from findings with a pin — see DEV_NOTES.md
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
