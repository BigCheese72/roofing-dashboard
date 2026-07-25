# RoofOps Database Schema

RoofOps Field currently uses Firebase Firestore for work orders, building history, reports, app settings, roles, users, audit logs, and integration caches.

This file summarizes the current working schema. `DATA_MODEL.md` remains the deeper current/future design document.

## Important Rules

- Firestore is shared by the app and Netlify Functions.
- Some legacy collections are intentionally more open than the future security model wants, because production compatibility has mattered during the auth migration.
- Large binary files should not be stored in top-level Firestore documents.
- CompanyCam is the preferred external record for job photos and generated report PDFs when linked.
- Generated report records and matching building history events should remain linked by stable ids where possible.

## Core Collections

### `workorders`

Primary work order documents.

Common fields include:

```js
{
  jobName,
  location,
  serviceDate,
  jobNo,
  billTo,
  technician,
  roofSystem,
  roofId,
  roofIds,
  woType,
  findings: [],
  inspectionChecklist: [],
  repairs: [],
  materials: [],
  photos: [],
  amendments: [],
  warrantable,
  nonWarrantable,
  mfgServiceNo,
  summary,
  companyCamProjectId,
  companyCamProjectName,
  status,
  createdAt,
  updatedAt,
  completedAt
}
```

Work order types:

- `Leak / Service`
- `Change Order`
- `Inspection`
- `Repair`
- `Warranty`

Type-specific fields may exist on the same document shape. Visibility is mostly controlled by UI display gating, not separate document types.

### `workorders/{workOrderId}/photos`

Photo subcollection for work orders.

Common fields:

```js
{
  caption,
  img,
  w,
  h,
  finding_id,
  amendment_id,
  ccPhotoId,
  ccFeedPhotoId,
  gps,
  storageRef,
  thumb,
  pin
}
```

The code must preserve photo metadata during cloud save/fetch round trips.

### `workorders/{workOrderId}/changeorder_approvals`

Server-only approval state for Change Orders. Client writes are blocked by rules. Writes go through `netlify/functions/changeorders.js`.

### `customers`

Customer or bill-to records derived from work order fields and future explicit customer workflows.

### `buildings`

Physical site/building records.

Common fields:

```js
{
  customerId,
  customerName,
  name,
  slug,
  address,
  location,
  companyCamProjectId,
  companyCamProjectName,
  roofs: [],
  geoCache,
  archived,
  archivedAt,
  createdAt,
  updatedAt,

  // legacy single-roof compatibility fields
  roofSystem,
  roof_base_map_type,
  roof_base_map_url,
  roof_base_map_bounds,
  roof_base_map_synthetic,
  roof_assets,
  roof_outlines
}
```

### `buildings.roofs[]`

One building can have multiple roofs.

Common roof shape:

```js
{
  id,
  label,
  roofSystem,
  roof_base_map_type,
  roof_base_map_url,
  roof_base_map_bounds,
  roof_base_map_synthetic,
  roof_assets: [],
  roof_outlines: [],
  roof_markups: [],
  profile: {},
  labelPos,
  createdAt,
  updatedAt
}
```

### `roof_assets[]`

Permanent physical roof features attached to a roof.

```js
{
  id,
  type,
  label,
  notes,
  lat,
  lng,
  x,
  y,
  createdAt,
  updatedAt
}
```

Exactly one coordinate mode should be used: `{lat,lng}` or `{x,y}`.

### `roof_outlines[]`

RoofMapper outlines attached to a roof. Includes geometry, dimensions, provenance, labels, and optional holes/cutouts.

### `roof_markups[]`

Bluebeam-style roof annotations.

```js
{
  id,
  type,
  points,
  color,
  text,
  count,
  author,
  createdAt,
  period,
  roofId
}
```

## Report And History Collections

### `reports`

Flat cross-building report/activity log.

Common fields:

```js
{
  customerId,
  customerName,
  buildingId,
  buildingName,
  workOrderId,
  workOrderNo,
  workOrderType,
  roofId,
  roofIds,
  roofLabels,
  reportType,
  isActivity,
  notes,
  date,
  technician,
  roofType,
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  companyCamUploadStatus,
  companyCamUploadError,
  pdfRef,
  emailSent,
  emailRecipients: [],
  emailSubject,
  createdAt
}
```

### `building_history_events`

Per-building timeline events.

Common fields:

```js
{
  customerId,
  customerName,
  buildingId,
  buildingName,
  eventType,
  workOrderId,
  workOrderNo,
  workOrderType,
  reportId,
  date,
  enteredAt,
  enteredBy,
  technician,
  roofId,
  roofIds,
  roofLabels,
  roofType,
  title,
  summary,
  isActivity,
  notes,
  conditionsSummary,
  repairsSummary,
  warrantyStatus,
  companyCamProjectId,
  companyCamPhotoIds: [],
  companyCamUploadStatus,
  companyCamUploadError,
  pins: [],
  photos: [],
  pdfRef,
  emailSent,
  emailRecipients: [],
  createdAt
}
```

`pins[]` is denormalized from findings/checklist/photo pins so Building History maps do not need to walk every work order.

## Integration Collections

- `companycam_projects`: CompanyCam project/photo metadata cache. Does not store image bytes.
- `foundation_jobs`: cached active Foundation jobs.
- `foundation_sync_meta`: last-run summary for Foundation sync.
- `feedback`: in-app feedback submissions.
- `ai_training_labels`: tech-confirmed issue labels for future AI training.
- `warranty_review_queue`: server-only review queue for warranty/inspection report ingestion.
- `ingested_email_attachments`: server-only idempotency ledger for processed email attachments.
- `secrets`: server-only secrets storage.
- `invites`: server-only hashed invite-token records.

## Auth And Admin Collections

### `users`

Privilege mirror and user display/query record. Not authoritative.

### `roles`

Data-driven role definitions seeded through `netlify/functions/auth.js`.

### `audit_logs`

Immutable audit log written by server functions only.

### `app_settings`

App-wide settings. Known docs include:

- `app_settings/global`
- `app_settings/auth_bootstrap`
- `app_settings/roof_types`
- `app_settings/ai_label_vocab`

## Future SaaS Direction

The future schema should add `accountId` as the tenant boundary before multi-company SaaS work.

Do not retrofit account scoping casually inside ordinary feature work.
