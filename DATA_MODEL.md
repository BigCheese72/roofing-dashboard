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
  lightweight, client-side "admin mode" (a PIN prompt, `ADMIN_PIN` constant in
  `index.html`, session-scoped via `sessionStorage`) that gates a few destructive
  actions (unlink CompanyCam, delete building/timeline records) from field techs. This
  is explicitly not real security — the PIN is visible in public JS — and should be
  replaced by this `users`/`role` model rather than extended, once real auth exists.

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
  roof_base_map_type: null, // drone | satellite | plan | sketch
  roof_base_map_url: null,
  roof_section: null,
  map_pin_x: null,
  map_pin_y: null,
  createdAt,
  updatedAt
}
```

Notes:

- Current app derives buildings from Job Name and Bill To.
- The building should become the anchor for long-term roof history.

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
  findings: [],
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
  pdfRef: null,
  emailSent: false,
  emailRecipients: [],
  createdAt
}
```

Notes:

- This should power the roof history timeline.
- Keep this append-only where practical so the building history remains auditable.

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
