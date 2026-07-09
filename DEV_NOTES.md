# RoofOps Field — Developer Notes

This app (repo: `roofing-dashboard`) is **RoofOps Field**, the first module of a larger
planned product, RoofOps. The long-term vision is that every commercial roof/building
becomes a living historical record — work orders, leak locations, repairs, photos,
PDFs, emails, warranty decisions, CompanyCam history, and eventually drone/orthomosaic
map data, all tied to one building over its lifetime. Later modules (not yet started):
**RoofOps Dashboard**, **RoofOps Admin**, **RoofOps Customer Portal**.

This file documents the current architecture so future work extends it instead of
re-discovering it.

**Other docs in this repo** (kept in sync by whichever tool — Claude or Codex — is
working here): [`README.md`](README.md) (file/responsibility map), [`APP_OVERVIEW.md`](APP_OVERVIEW.md)
(user-facing workflow walkthrough), [`ROADMAP.md`](ROADMAP.md) (phased product
direction), [`DATA_MODEL.md`](DATA_MODEL.md) (proposed future Firestore shape). This
file is the one for implementation-level detail and gotchas; the others cover
structure, workflow, and direction. Update the relevant doc(s) in the same session as
any change that shifts behavior.

## Architecture at a glance

- **Single-page app**: everything is in [`index.html`](index.html) — vanilla JS, no
  build step, no framework. Deployed as a static site.
- **Hosting/CI**: Netlify. `netlify.toml` publishes the repo root and treats
  `netlify/functions/` as serverless functions. Any push to the connected GitHub
  branch auto-deploys.
- **Serverless functions** (`netlify/functions/`):
  - `companycam.js` — proxy to the CompanyCam API. Keeps `COMPANYCAM_TOKEN` server-side.
  - `send-workorder.js` — sends the generated PDF via Resend. Keeps `RESEND_API_KEY`
    server-side.
- **Database**: Firebase Firestore (project `watkins-service-orders`), initialized
  client-side with the public web config in `index.html` (safe to expose — access is
  controlled by Firestore security rules, not by hiding the config).
- **PDF generation**: jsPDF + jsPDF-AutoTable, entirely client-side.
- **PDF persistence**: intentionally *not* Firebase Storage — CompanyCam (via
  `uploadPdfToCompanyCam()`, when a project is linked) is the system of record for
  saved PDFs. `pdfRef` on a history event is therefore always `null`; it's kept in the
  schema in case that changes later.

## Firestore collections

| Collection | Purpose | Added |
|---|---|---|
| `workorders` (+ `photos` subcollection per doc) | The original, still-primary work order store. One doc per work order; photos live in a subcollection to keep the parent doc small. | pre-existing |
| `customers` | Derived automatically from the "Bill To" field. Doc id: `cust_<slugified name>`. | this phase |
| `buildings` | Derived automatically from the "Job Name" field, linked to a customer. Doc id: `bld_<slugified customerId_jobName>`. Carries roof-map/leak-location placeholder fields (see below) and, once linked, `companyCamProjectId`. | this phase |
| `reports` | Flat, append-only log of every generated report (download / email / share). Same payload shape as `building_history_events`; exists so a future dashboard can query "all reports" without walking every building. | this phase |
| `building_history_events` | Per-building timeline. Same payload as `reports`, queried by `buildingId`. Powers the new **Building History** tab. | this phase |
| `companycam_projects` | Lightweight sync cache: CompanyCam project metadata + photo *metadata only* (ids, thumb/full URLs, captured_at) for a linked project. Populated by "Sync CompanyCam History". Never stores image bytes. | this phase |

**Customer/building linkage is automatic, not a new required UI step.** The existing
work order form is unchanged; `ensureCustomerAndBuilding()` runs quietly whenever a
report is generated or emailed, keyed off fields the user already fills in (Bill To,
Job Name, Location). This was a deliberate choice to satisfy "preserve the current
work order workflow" while still building the history foundation. If/when a real
customer/building picker UI is added, wire it into the same function.

### `building_history_events` / `reports` document shape

```
{
  buildingId, buildingName,        // building/site name
  customerId, customerName,        // customer name
  workOrderId, workOrderNo,        // work order number
  date,                            // date of service (string, as typed in the form)
  technician,
  roofType,                        // roof system
  reportType,                      // "PDF Downloaded" | "PDF Emailed" | "PDF Shared"
  conditionsSummary,                // findings, joined, truncated to 600 chars
  repairsSummary,                   // repairs, joined, truncated to 600 chars
  warrantyStatus,                   // "Warrantable" | "Non-warrantable" | "Mixed" | "Undetermined"
  companyCamProjectId,
  companyCamPhotoIds: [...],        // CompanyCam photo ids actually used in this report
  pdfRef: null,                     // reserved — currently always null, PDFs live in CompanyCam instead
  emailSent: bool,
  emailRecipients: [...],
  createdAt
}
```

### Building document — roof map / leak location foundation (Phase 1, no UI yet)

Per the future roof-map feature, every building doc is seeded once (on first
creation) with:

```
roof_base_map_type: null,   // will become "drone" | "satellite" | "plan" | "sketch"
roof_base_map_url:  null,
roof_section:        null,
map_pin_x:           null,
map_pin_y:           null,
```

Every **finding** (roof investigation entry) also carries `leak_location_label`,
`leak_latitude`, `leak_longitude` (all `null` today). These are placeholders only —
`addFinding()` in `index.html` sets the keys so a future map feature never needs a
data migration. No input UI exists for any of these yet, by design (see task spec:
"prepare the data structure for it," not the feature itself).

### ⚠️ Firestore security rules

New collections (`customers`, `buildings`, `reports`, `building_history_events`,
`companycam_projects`) need rules that allow the app's reads/writes, the same way
`workorders` already does. If rules aren't updated, writes to the new collections will
fail *silently from the user's perspective* — history logging is deliberately
non-blocking (wrapped in try/catch, never interrupts the PDF action) so a rules
problem won't break the core workflow, but history also won't be recorded until
fixed. Check Firebase Console → Firestore → Rules. (Confirmed working against the
production `watkins-service-orders` project as of this writing.)

### ⚠️ Firestore composite index

`openBuildingHistory()` queries `building_history_events` with
`.where("buildingId","==",id).orderBy("createdAt","desc")`, which needs a composite
index. Firestore returns an error containing a direct "create it here" link the first
time this runs — click it once in the Firebase console and the query works from then
on.

## CompanyCam integration points

All CompanyCam calls go through `netlify/functions/companycam.js` (token never
reaches the browser). Actions:

- `GET ?action=projects&q=` — search/list projects.
- `GET ?action=project_detail&project_id=` — single project metadata. *(new)*
- `GET ?action=photos&project_id=&page=` — paginated photo metadata (id, thumb/full URL,
  captured_at). No image bytes here.
- `GET ?action=image&url=` — fetches one photo's bytes server-side and returns it as a
  data URL (used only when the user actually imports a photo into a work order).
- `POST {action:"upload_document", project_id, name, attachment}` — uploads a document
  (used for PDF-back-to-CompanyCam). *(new)*

### Linking a work order to a CompanyCam project

Opening a project in the "Import from CompanyCam" modal (`ccOpenProject`) sets
`ccLinkedProjectId` / `ccLinkedProjectName` for the *current* work order — this is
what "a CompanyCam project is selected for a report" means in practice. It's saved on
the work order (`companyCamProjectId`/`companyCamProjectName`) and shown/undoable via
the green link banner under Photo Documentation. Photos imported from CompanyCam are
tagged with `ccPhotoId` so `building_history_events.companyCamPhotoIds` can record
exactly which CompanyCam photos ended up in a given report.

### "Sync CompanyCam History" (`syncCompanyCamHistory()`)

Beginning of the CompanyCam history sync feature. Pulls project metadata + *all*
photo metadata (paginating up to 20 pages / ~600 photos as a safety cap) and writes it
to `companycam_projects/{projectId}`. Intentionally stores references (ids, URLs)
rather than re-downloading full images, per the task spec ("do not duplicate huge
files unnecessarily").

**Known CompanyCam API limitation**: v2 exposes Projects, Photos, and Documents, but
no general activity/audit log. That means this app can reconstruct "what photos and
documents exist and when they were captured/uploaded," but not a fuller history like
who changed what, deleted items, or comments/annotations. If CompanyCam later exposes
an activity/webhooks API, `syncCompanyCamHistory()` and `companycam.js` are the places
to extend.

### PDF-back-to-CompanyCam (`uploadPdfToCompanyCam()`)

After a successful **Send Email Now**, if the work order has a linked CompanyCam
project, the generated PDF is base64-encoded and POSTed to CompanyCam's
`/v2/projects/{id}/documents` endpoint (confirmed against CompanyCam's own API
reference — JSON body `{document:{name, attachment}}`, base64, ~30MB limit), using
`COMPANYCAM_WRITE_TOKEN` if set (falls back to `COMPANYCAM_TOKEN` otherwise). Success
and failure both produce a distinct toast. If the CompanyCam upload fails (network,
permissions, endpoint changes), the user still has the PDF from "Send Email Now" and
can retry — there's no separate app-side backup copy, by design (see "PDF
persistence" above).

CompanyCam's document endpoint accepts an optional `X-CompanyCam-User` header
(email of the user to attribute the upload to). Set the `COMPANYCAM_USER_EMAIL`
Netlify environment variable if you want uploads attributed to a specific user;
otherwise the header is omitted and CompanyCam attributes it to the API token owner
(exact behavior depends on your CompanyCam account setup — verify once in a test
project).

## Netlify environment variables

| Variable | Used by | Required |
|---|---|---|
| `COMPANYCAM_TOKEN` | `companycam.js` — read actions (projects, project_detail, photos, image) | yes |
| `COMPANYCAM_WRITE_TOKEN` | `companycam.js` — write action only (`upload_document`, PDF-back-to-CompanyCam). Falls back to `COMPANYCAM_TOKEN` if unset. | optional, recommended if your CompanyCam token setup separates read/write scopes |
| `COMPANYCAM_USER_EMAIL` | `companycam.js` (document upload attribution) | optional |
| `RESEND_API_KEY` | `send-workorder.js` | yes |
| `FROM_EMAIL` | `send-workorder.js` | optional (has a default) |
| `ADMIN_PIN` | `admin.js` | yes, for admin mode to work | The real PIN check — not present anywhere in `index.html` anymore. |
| `FIREBASE_SERVICE_ACCOUNT` | `admin.js` | yes, for admin mode to work | Entire JSON contents of a Firebase service account key. Full project access — treat as a secret, never commit it. |

## Admin mode

Field techs should not be able to unlink a CompanyCam project or delete a building's
history. This started as a client-side-only PIN check (a UI convenience, not real
security) — testing found that anyone could bypass it entirely by calling the
Firestore SDK directly from devtools, since the underlying data had no protection at
all regardless of what the UI showed. It's now a real, two-layer gate:

1. **Client (UX only)**: the "Admin" toggle in the header (`toggleAdminMode()`)
   prompts for a PIN and sends it to `netlify/functions/admin.js` for verification
   (`action: "check_pin"`). On success, `isAdmin` flips true and the PIN is kept in
   `sessionStorage` (not in this source file) so later admin actions don't re-prompt.
   This layer only controls which buttons render — it enforces nothing by itself.
2. **Server (actual enforcement)**: `netlify/functions/admin.js` checks the PIN
   against the `ADMIN_PIN` environment variable — never shipped to the browser — and
   only then performs the delete, using the Firebase Admin SDK (which bypasses
   Firestore security rules entirely, by design). `firestore.rules` (repo root, a
   reference file you must apply yourself in Firebase Console — nothing here deploys
   it automatically) blocks `delete` on `customers`/`buildings`/`reports`/
   `building_history_events`/`companycam_projects` for every client, no exceptions.
   The only way to delete those documents is through this function.

What's admin-gated:
- **Unlink** on the CompanyCam link banner (`unlinkCC()`) — this one stays
  client-only since it just clears in-memory state on the *current, unsaved* work
  order and never issues its own Firestore write; there's nothing for the server to
  protect.
- **Delete (admin)** per building in the Building History tab (`deleteBuildingAdmin()`
  → `action: "delete_building"`) — removes the building doc plus its
  `reports`/`building_history_events`, but does **not** touch the underlying
  `workorders`.
- **Delete (admin)** per timeline entry (`deleteHistoryEventAdmin()` →
  `action: "delete_history_event"`) inside a building's "View Timeline" panel.
  `reports` and `building_history_events` docs for the same report share one
  Firestore id (set in `logReportAndHistoryEvent()`), so one delete removes both.
- **Duplicate flagging** (`flagDuplicateEvents()`, `DUP_WINDOW_MS = 5 min`): when a
  building's timeline loads, entries with the same `workOrderId` + `reportType`
  created within 5 minutes of another entry are marked `_dup` and shown with a red
  "Possible duplicate" badge — this is almost always a double-click or a retried
  Send/Share/Download, not two real reports. It's a visual flag only; admin uses the
  per-entry Delete button to act on it.

**Known, separate, pre-existing gap left alone on purpose**: the "Delete" button on a
saved work order in the Saved tab (`deleteOrder()`) is unrelated to any of this — it
predates the admin mode work, is not PIN-gated, and every field tech can still delete
their own saved work orders directly, same as before. Locking that down too is a
real option but a different UX conversation (techs legitimately delete their own
drafts today), not something folded into this change.

**Manual setup required for the server-side enforcement to actually work** (nothing
here takes effect until you do this):
1. In Netlify, set `ADMIN_PIN` to whatever PIN techs should enter (this **replaces**
   any PIN previously hardcoded in `index.html` — there isn't one anymore).
2. Generate a Firebase service account key: Firebase Console → Project Settings →
   Service Accounts → "Generate new private key". This downloads a JSON file with
   **full admin access to your Firebase project — treat it like a master password,
   never commit it to the repo.** In Netlify, set `FIREBASE_SERVICE_ACCOUNT` to the
   *entire contents* of that JSON file (paste it as-is, as one env var value).
3. In Firebase Console → Firestore Database → Rules, paste the contents of
   `firestore.rules` (repo root) and Publish. Until you do this step, the delete
   protection is still just the PIN — the underlying collections remain writable by
   any client, same as before.
4. Redeploy (Netlify needs a fresh build to pick up the new `package.json`
   dependency and env vars).

Longer-term, real fix if this ever needs actual user accounts instead of a shared
PIN: the `users`/`role` model already sketched in `DATA_MODEL.md`, paired with
Firebase Auth and rules keyed to `request.auth`. This PIN + server-function approach
is a deliberately smaller step that fits the existing "keep secrets in Netlify
functions" pattern already used for CompanyCam/Resend, at no additional cost.

## Roadmap (not built yet, foundation only)

- **RoofOps Dashboard**: cross-building reporting, search, filters — reads from
  `buildings` / `reports` / `building_history_events` rather than `workorders`
  directly.
- **Roof map**: render `roof_base_map_type`/`roof_base_map_url` (drone orthomosaic >
  Google satellite > uploaded plan > manual sketch, in that preference order) with
  pins from `map_pin_x`/`map_pin_y` and per-finding `leak_latitude`/`leak_longitude`.
- **Explicit customer/building picker UI** in the Edit tab, replacing the current
  implicit derive-from-text-fields approach, while keeping the same Firestore shape.
- **CompanyCam activity/webhooks**, if CompanyCam's API adds them, to enrich building
  history beyond photos/documents.
- **RoofOps Admin / Customer Portal**: separate modules, out of scope for this repo
  for now.
