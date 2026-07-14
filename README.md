# RoofOps Field / Watkins Work Order App

RoofOps Field is a lightweight commercial roofing field work order app for Watkins Roofing service work. Field users can create leak work orders, document roof investigation findings and repairs, attach or import job photos, generate PDF reports, email finished reports, and keep a growing building/site history.

The current app is intentionally simple: it is a single static page with Netlify Functions for server-side API calls. Do not rebuild or replace working behavior without a clear migration plan.

## Start Here If You're an AI Coding Assistant

This repo is developed across multiple AI coding sessions (Claude and Codex, so far) —
you are picking up where the other left off, not starting fresh. Before making any
change:

1. Read, in order: this file, [`APP_OVERVIEW.md`](APP_OVERVIEW.md) (user-facing
   workflow), [`DEV_NOTES.md`](DEV_NOTES.md) (implementation details, gotchas, API
   quirks), [`ROADMAP.md`](ROADMAP.md) (what's shipped vs. planned), and
   [`DATA_MODEL.md`](DATA_MODEL.md) (Firestore schema).
2. Confirm your understanding of current state before proposing changes.

Ground rules while working here:

- This is a working field app in daily use. Preserve the existing work order
  workflow (job info → findings → repairs → warranty → photos → PDF →
  email/share) — never rebuild or redesign it wholesale.
- Extend the existing single-file architecture (`index.html` + `netlify/functions/`)
  rather than introducing a framework, build step, or new architecture, unless
  explicitly asked.
- Field techs should not have access to destructive actions (unlink, delete). Admin
  mode gates these — PIN verified server-side in `netlify/functions/admin.js`, actual
  deletes enforced by `firestore.rules` blocking client-side deletes (see
  `DEV_NOTES.md`) — this is the current pattern for that; don't bypass it, don't add
  a new client-side-only check, and don't add new destructive Firestore operations
  without routing them through `admin.js` the same way.
- Firebase Storage is intentionally not used for PDFs — CompanyCam is the system of
  record. Don't reintroduce Storage without checking with the user first.
- Test against production Firebase/CompanyCam carefully: use clearly-labeled test
  data (e.g. "DELETE ME" in job/customer names) and clean it up after verifying,
  since there's no separate staging environment.
- After any change that shifts behavior, update the relevant doc(s) above in the
  same session — these docs are the shared handoff mechanism between tools, and
  they go stale fast if only code changes.

## Current Structure

```text
index.html
README.md
APP_OVERVIEW.md
DEV_NOTES.md
ROADMAP.md
DATA_MODEL.md
package.json         # firebase-admin, for admin.js
firestore.rules       # reference only — apply manually in Firebase Console
netlify.toml
netlify/
  functions/
    companycam.js
    send-workorder.js
    admin.js
tools/
  geotiff_to_webmap.py    # standalone — NOT part of the deployed app
  update_roof_base_map.py # interactive wrapper around --upload, also standalone
  Update Roof Base Map.bat # double-click launcher for the above
```

## Main Responsibility Map

| Area | Main file(s) | Notes |
|---|---|---|
| Work order form and UI | `index.html` | The edit, preview, saved work orders, building history, photo documentation, and CompanyCam modal UI all live in this file. The main work order form starts in the Edit view markup. |
| Work order state and save/load | `index.html` | Functions such as `collect()`, `saveOrder()`, `loadOrder()`, `cloudSaveOrder()`, and `cloudFetchOrder()` handle form state, local storage fallback, and Firestore sync. Each photo's `finding_id`/`ccPhotoId`/`gps` round-trip through the `photos` subcollection along with `caption`/`img`/`w`/`h` — see `DEV_NOTES.md` for a bug fixed here. |
| Local storage quota safety | `index.html` | `stripPhotoBytes()`/`pruneCachedPhotoDrafts()` keep the `localStorage` offline cache (~5–10MB browser quota) from filling up — only the actively-edited draft and the 10 most-recently-saved drafts keep full photo bytes locally; merely viewing a report never caches its photos. See "Local work order cache" in `DEV_NOTES.md`. |
| Firebase connection | `index.html` | Firebase compat scripts are loaded from CDN. `FIREBASE_CONFIG` initializes Firestore for project `watkins-service-orders`. |
| Firebase data writes | `index.html` | Work orders write to `workorders` with a `photos` subcollection. Customer, building, report, and building history records are created by `ensureCustomerAndBuilding()` and `logReportAndHistoryEvent()`. `logReportAndHistoryEvent()` upserts one `reports`/`building_history_events` doc per work order (id `"evt_" + workOrderId`) — a resend/reshare/resave updates that same entry rather than adding a new one. See "One timeline entry per work order" in `DEV_NOTES.md`. |
| Building/customer picker | `index.html` | `openBuildingPicker()` — a searchable modal listing existing `buildings` docs; `bpSelectBuilding()` fills Job Name/Bill To/Location/Roof System from the picked building's stored values. Purely additive UX on top of `ensureCustomerAndBuilding()`'s existing derive-from-text-fields id scheme — doesn't change it. See `DEV_NOTES.md`. |
| CompanyCam connection | `index.html`, `netlify/functions/companycam.js` | Browser code calls `/.netlify/functions/companycam`; the function proxies CompanyCam API requests so API tokens never reach the browser. |
| CompanyCam photo import | `index.html`, `netlify/functions/companycam.js` | `openCC()`, `ccLoadProjects()`, `ccLoadPhotos()`, and `ccImport()` support project search, photo listing, server-side image fetch, and client-side compression/import. `applyCompanyCamProjectDetail()` also fills Job Name/Location from the linked project (fill-if-empty-or-upgrade-partial, never clobbers a different manual entry). |
| CompanyCam history sync | `index.html`, `netlify/functions/companycam.js` | `syncCompanyCamHistory()` stores project/photo metadata in Firestore collection `companycam_projects`. |
| PDF generation | `index.html` | `generatePdf()` uses jsPDF and jsPDF-AutoTable from CDN to build the work order PDF in the browser. |
| PDF download/share | `index.html` | `downloadPdf()` and `sharePdf()` generate, save, share, and log report events. |
| Email/report sending | `index.html`, `netlify/functions/send-workorder.js` | `sendEmailNow()` generates the PDF, posts it to `send-workorder` (including `jobNo`), and the Netlify Function sends through Resend from a per-job `WO<jobnumber>@<domain>` address (falls back to `FROM_EMAIL` if no job number) with a `reply_to` safeguard pointed at a real monitored inbox. On success, `markWorkOrderEmailed()` merge-patches `lastEmailedAt`/`lastEmailedTo` onto the `workorders` doc, surfaced as "📧 Emailed …" in the Saved tab; `logReportAndHistoryEvent()` separately logs the durable report/timeline entry (now including `emailSubject`). See "Per-job From address" and "Visible email-sent record" in `DEV_NOTES.md`. |
| PDF save-back to CompanyCam | `index.html`, `netlify/functions/companycam.js` | `uploadLinkedPdfToCompanyCam()` uploads the PDF as a CompanyCam project document whenever a project is linked — after Send Email Now, Share, or Download, not just email. |
| Admin mode | `index.html`, `netlify/functions/admin.js`, `firestore.rules` | `toggleAdminMode()` verifies the PIN server-side (`ADMIN_PIN` env var, never shipped to the browser). Unlocks `unlinkCC()` on the CompanyCam banner, per-building/per-event delete, and roof base-map upload/clear in Building History; all of those run through `admin.js` using the Firebase Admin SDK. `firestore.rules` blocks client-side deletes on the affected collections entirely — see DEV_NOTES.md for required manual setup. |
| Roof map / location pins | `index.html`, `netlify/functions/companycam.js`, `netlify/functions/admin.js`, `tools/geotiff_to_webmap.py` | Leaflet (CDN) + free Esri satellite tiles + free Nominatim geocoding. `openPinModal()` places a pin per finding — satellite/lat-lng by default, x/y on a roof-plan/sketch base map, or lat-lng with a georeferenced drone-orthomosaic overlay; also supports device GPS ("Use My Location") and drag-to-correct, with corrections synced onto any existing report(s) via `syncPinCorrectionsToHistory()`. `renderBuildingMap()` shows every pin for a building at once in the Building History tab, always visible even with zero pins, plus every permanent roof asset (drains, HVAC units, hatches, etc. — `openAssetModal()`, `ROOF_ASSET_TYPES`). RoofMapper can trace from OSM, manual map taps, walked corners, plain PNG/JPG orthos, georeferenced GeoTIFFs, and KMZ/KML GroundOverlay orthomosaics. `tools/geotiff_to_webmap.py` is a standalone script (not deployed) that converts a raw drone GeoTIFF into what the orthomosaic upload needs. See "Roof map", "Roof assets", and "KMZ/KML GroundOverlay import" in `DEV_NOTES.md` for the full design. |
| Duplicate report detection | `index.html` | `flagDuplicateEvents()` flags timeline entries with the same work order + report type created within 5 minutes of each other (double-click/retry protection), shown with a badge; admin can delete flagged entries. |
| Timeline filters | `index.html` | `renderTimelineList()`/`filterTimelineEvents()` filter the Building History timeline by date range, roof area, technician, warranty status, and report type — entirely client-side over the events already fetched by `openBuildingHistory()`, no new query/index. Dropdown options (`populateTimelineFilterOptions()`) are derived from the values actually present on that building's own timeline. See `DEV_NOTES.md`. |
| Duplicate building detection | `index.html` | `flagPossibleDuplicateBuildings()`/`buildingsLikelyDuplicate()` flag buildings that share the same customer and a very similar name (badge in Building History). Detection only — merging is designed but not built, explicitly shelved pending sign-off since it's a destructive live-data write. See `DEV_NOTES.md`. |
| RoofMapper (Phase 1) | `index.html` | New tab (`#view-roofmapper`) — GPS-locate the tech, query free OpenStreetMap/Overpass building footprints nearby, tap the correct one, generate a clean roof outline, save it to a building's `roof_outlines[]` (or locally) and/or export SVG/PNG/PDF. `rmGeom*` (geometry), `rmGeoRequest()` (GPS), `rmFetchNearbyBuildings()` (Overpass), `rmExport*()` (export), `rm*` view/state functions. No API keys, no build step. See "RoofMapper" in `DEV_NOTES.md`. |
| All Reports view | `index.html` | `renderReportsList()`/`rpRenderList()` — a read-only, filterable list of every report across every building (search text, date range, roof area, technician, warranty status, report type), reading the `reports` collection for the first time. `rpJumpToBuilding()` opens the report's building in Building History. See `DEV_NOTES.md`. |
| Netlify functions | `netlify/functions/companycam.js`, `netlify/functions/send-workorder.js` | Serverless API boundary for CompanyCam and Resend credentials. |
| Netlify deployment | `netlify.toml` | Publishes the repo root and points Netlify Functions at `netlify/functions`. |

## Firebase Usage

Firebase Firestore is used for cloud sync and early building history foundations. The app initializes Firestore in `index.html` using the public Firebase web config. The config values are safe to keep client-side; access control belongs in Firestore security rules.

Current and foundation collections used by the app:

| Collection | Purpose |
|---|---|
| `workorders` | Primary saved work order documents. Large photo payloads are stored in a `photos` subcollection per work order. |
| `workorders/{id}/photos` | Photo data and captions for a work order. |
| `customers` | Derived from the Bill To field for future customer/building organization. |
| `buildings` | Derived from customer and Job Name fields. Used by the Building History view. |
| `reports` | Flat log of generated/downloaded/emailed/shared reports. |
| `building_history_events` | Timeline events for building/site history. |
| `companycam_projects` | Lightweight CompanyCam project/photo metadata cache. Does not store image bytes. |

The app also keeps a local storage fallback so field work can still be saved on-device if cloud sync is unavailable.

## CompanyCam Usage

CompanyCam is integrated through `netlify/functions/companycam.js`, not directly from the browser. This keeps CompanyCam tokens in Netlify environment variables.

Supported actions:

| Action | Method | Purpose |
|---|---|---|
| `projects` | `GET` | Search/list CompanyCam projects. |
| `project_detail` | `GET` | Load one project's metadata. |
| `photos` | `GET` | Load paginated photo metadata for a project. |
| `image` | `GET` | Server-side fetch of one CompanyCam image URL, returned as a data URL for import. |
| `upload_document` | `POST` | Upload a generated work order PDF back to a linked CompanyCam project. |

Imported CompanyCam photos are compressed client-side before being added to the work order. The app stores `ccPhotoId` on imported photos so future report/history records can reference the CompanyCam source.

## PDF And Report Flow

PDFs are generated in the browser from the current form data and photo list. The app can:

- download the PDF locally;
- open native sharing/email fallback flows;
- send the PDF directly through Resend using `netlify/functions/send-workorder.js`;
- log report events to Firestore;
- upload the emailed PDF back to a linked CompanyCam project.

Firebase Storage is not currently the system of record for PDFs. CompanyCam is the preferred external record for saved report PDFs when a CompanyCam project is linked.

## Netlify Deployment

This repo is configured for Netlify in `netlify.toml`:

```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

There is no frontend build step. Netlify serves `index.html` from the repository root and deploys the functions in `netlify/functions/`. The connected Netlify site should auto-deploy when commits are pushed to the connected GitHub branch.

## Environment Variables

Set these in Netlify project environment variables:

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `COMPANYCAM_TOKEN` | Yes | `netlify/functions/companycam.js` | Read token for CompanyCam project, photo, and image actions. |
| `COMPANYCAM_WRITE_TOKEN` | Optional | `netlify/functions/companycam.js` | Used for `upload_document`. Falls back to `COMPANYCAM_TOKEN` if unset. Recommended if write permissions should be separately scoped. |
| `COMPANYCAM_USER_EMAIL` | Optional | `netlify/functions/companycam.js` | Adds `X-CompanyCam-User` for document upload attribution. |
| `RESEND_API_KEY` | Yes | `netlify/functions/send-workorder.js` | Sends direct PDF emails. |
| `FROM_EMAIL` | Optional | `netlify/functions/send-workorder.js` | Defaults to `Watkins Roofing Work Orders <workorders@watkinsroofing.net>`. |
| `ADMIN_PIN` | Yes, for admin mode | `netlify/functions/admin.js` | The actual admin PIN check — not present in `index.html`. |
| `FIREBASE_SERVICE_ACCOUNT` | Yes, for admin mode | `netlify/functions/admin.js` | Entire JSON contents of a Firebase service account key (Firebase Console → Project Settings → Service Accounts). Full project access — never commit it. |

Firebase web config is currently hard-coded in `index.html`. Firestore access is controlled with Firebase security rules — see `firestore.rules` (repo root) and DEV_NOTES.md for what's in place and what still needs to be manually applied.

## Local Development

Because this is a static app with Netlify Functions, the closest local environment is Netlify CLI:

```bash
netlify dev
```

Opening `index.html` directly can show the UI, but direct email and CompanyCam calls require the Netlify Functions routes.

## Documentation

- `APP_OVERVIEW.md` walks through the main user-facing workflow end to end.
- `DEV_NOTES.md` contains implementation notes for the current architecture, including
  things that aren't obvious from reading the code (API quirks, known limitations,
  what's intentionally *not* built yet).
- `ROADMAP.md` lays out phased product direction.
- `DATA_MODEL.md` proposes future Firebase collections for the broader RoofOps platform.

These five docs (including this one) are maintained by whichever tool (Claude or
Codex) is working in this repo at the time — when you make a change that shifts
behavior, update the relevant doc(s) in the same session rather than letting them
drift, since the other tool relies on them for context in its next session.
