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

### Roof map: base maps + location pins (shipped)

Built from a written spec (see git history / PR description around the commits titled
"Roof map Phase 1–4"). Three design decisions worth knowing before touching this code:

1. **Lat/lng is authoritative; x/y is a fallback for non-georeferenced maps.** A pin
   survives a future base-map swap (e.g. a drone orthomosaic replacing satellite)
   because it's stored as real coordinates, not a position on an image. x/y (normalized
   0..1) only applies to `roof_plan`/`sketch` base maps, which have no real-world
   coordinate system.
2. **Pins attach to findings, not photos.** `findings[]` and `photos[]` used to be
   unrelated arrays. Every finding now has a stable `id` (`genId("fnd")`, survives
   reordering/removal); every photo has a `finding_id` (`null` = general/context photo).
   A dropdown under each photo's caption sets the link.
3. **GPS is an initial guess, never trusted blind.** A pin's `source` field records
   provenance: `"tech_placed"` (no GPS available), `"photo_gps"` (seeded from a linked
   CompanyCam photo's GPS, saved untouched), `"gps_corrected"` (seeded from photo GPS,
   then dragged), `"device_gps"` (tech tapped "Use My Location" in the pin modal —
   `navigator.geolocation`, satellite mode only, not offered on a custom base map since
   x/y pixel coords have no real-world position for device GPS to land on). Reopening an
   already-corrected pin never downgrades its source.
4. **A pin is never final — dragging is always available.** Once a finding has a pin,
   its "Place on Map" button becomes "📍 Pinned — move" and reopens the same modal with
   the existing location, draggable/tappable to correct. Pins are denormalized onto
   `building_history_events` at report-generation time (`buildPinsForHistoryEvent()`),
   but a plain Save also patches the *location* (lat/lng/x/y/source only) on any
   existing report(s) that already reference that finding — `saveOrder()` calls
   `syncPinCorrectionsToHistory()` after every successful cloud save, so a tech doesn't
   need to re-issue a PDF just to fix a pin's GPS accuracy. It never adds a pin to a
   report that didn't already have one for that finding, and never touches anything
   else about a report (summary text, warranty, photo_ids) — only location moves.
5. **The Building History roof map is read-only by design** (it's an aggregate across
   every past report, not one editable thing), but every pin's popup now has an
   "Adjust Pin" button next to "View Work Order" so that expectation doesn't dead-end.
   `jumpToAdjustPin(workOrderId, findingId)` sets `pendingPinFindingId` and calls
   `loadOrder()`; `showView()` checks that flag once the edit view is showing and
   auto-opens `openPinModal()` for that finding. Kept as a `showView()` hook rather than
   threading a callback through `loadOrder()`'s several async branches, since every one
   of them already ends in `fill(o); showView("edit")`.

**Finding shape**: `{ id, condition, location, warranty, pin }`. `pin` is `null` or
`{ lat, lng, x, y, source }` — exactly one of `{lat,lng}` or `{x,y}` is populated,
never both, depending on which kind of base map it was placed on.

**Photo shape adds**: `finding_id` (link, see above) and `gps` (`{lat,lng}` or absent —
only present on CompanyCam-imported photos that had GPS; see `companycam.js` below).

**Building doc adds**:
```
roof_base_map_type: null | "roof_plan" | "sketch" | "drone_ortho",
roof_base_map_url:  null | string,   // a CompanyCam document URL — see below
roof_base_map_bounds: null | { north, south, east, west },  // drone_ortho only
roof_base_map_updated_at: number | null
```
(The older placeholder fields this replaced — `leak_location_label`, `leak_latitude`,
`leak_longitude` on findings, `map_pin_x`/`map_pin_y` on buildings — were always `null`
with no UI ever built, so they were removed outright rather than kept alongside the
real schema. `roof_section` was also dropped; nothing uses it.)

**Map rendering**: Leaflet (CDN, `unpkg.com/leaflet@1.9.4`, no build step) + Esri World
Imagery tiles (`server.arcgisonline.com/.../World_Imagery/...`, free, no API key) for
satellite. Non-georeferenced base maps use `L.CRS.Simple` + `L.imageOverlay` with a
virtual coordinate space matching the uploaded image's actual pixel dimensions (fetched
via a plain `Image()` preload at pin-placement time — not stored anywhere, so it's
always correct even if the underlying image is replaced).

**Geocoding**: Nominatim (OpenStreetMap, free, no API key) geocodes the job address to
center the satellite map. Results are cached in-memory per session
(`geocodeCache`) — not persisted to Firestore, so it re-geocodes each new session. That
was a deliberate scope cut: persisting it would mean writing to a building doc during
plain editing (before `ensureCustomerAndBuilding()` would otherwise run), which changes
when customer/building records get created. Fine to revisit if Nominatim call volume
ever becomes a real concern (it won't, at this usage scale).

**Photo GPS from CompanyCam**: `companycam.js`'s `photos` action passes through
CompanyCam's `coordinates.lat`/`coordinates.lon` as `gps: {lat, lng}` on each photo —
note CompanyCam uses `lon`, everything else in this app (and Leaflet) uses `lng`;
mapped once at the source so nothing downstream has to remember the discrepancy.

**Building-wide history map** (`renderBuildingMap()`, in the Building History tab):
aggregates `pins[]` from every `building_history_events` doc for a building onto one
map — denormalized at report-generation time (`buildPinsForHistoryEvent()`) so this
reads from the events already being fetched for the timeline, no extra query. Color:
green = warrantable, red = non-warrantable, amber = undetermined/mixed. Always
renders, even with zero pins — satellite geocoded to the building's address (or a
generic fallback center) by default, so the map exists as soon as a building does, not
only once something's been pinned.

**Two kinds of custom base map — admin-only, needs a linked CompanyCam project either
way**, uploaded via CompanyCam's existing `upload_document` action (same one used for
PDF-back-to-CompanyCam) rather than Firebase Storage, per this repo's storage policy.
CompanyCam's document-creation response includes a `url` field ("the URL where the
document can be downloaded/viewed from" — confirmed against their API docs) stored as
`roof_base_map_url`.

1. **`roof_plan` / `sketch`** — no real-world coordinates. Uses `L.CRS.Simple` +
   `L.imageOverlay` with a virtual coordinate space matching the uploaded image's
   actual pixel dimensions (fetched via a plain `Image()` preload at pin-placement
   time — not stored anywhere, so it's always correct even if the image is replaced).
   Pins are normalized `x`/`y` (0..1).
2. **`drone_ortho`** — real georeferenced coordinates (`roof_base_map_bounds`). Treated
   as a higher-detail image layer drawn on top of the normal lat/lng satellite map
   (Esri tiles underneath, the ortho overlaid within its bounds) rather than a separate
   coordinate mode — pins on it are plain lat/lng, exactly like a satellite pin, so no
   new pin-source logic was needed for this case. Getting the bounds is the hard part —
   see `tools/geotiff_to_webmap.py` below.

A building shows **one map** overall — either the satellite/drone_ortho lat/lng view,
or a roof_plan/sketch x/y view, never both, since x/y and lat/lng can't merge onto one
Leaflet CRS without the manual anchoring the spec explicitly excludes from this phase.
Pins placed on satellite before a roof_plan/sketch base map existed won't show up once
one is set (drone_ortho doesn't have this problem — it uses the same lat/lng pins as
satellite, so switching between "no custom map" and "drone_ortho" never loses pins).

Setting **and clearing** a base map (either kind) both go through
`netlify/functions/admin.js`'s `set_building_roof_map` action (real PIN + Admin SDK,
same pattern as the delete actions) rather than a plain client-side Firestore
`update` — it's a shared, building-wide setting that affects every future report's pin
placement and the history map, not per-work-order draft data, so it gets the same
treatment as the destructive admin actions even though Firestore rules would
technically allow any client to `update` a building doc. If a building has no linked
CompanyCam project yet, the upload UI is replaced with guidance to link one first.

**`tools/geotiff_to_webmap.py`** — a standalone script, deliberately *not* part of the
app. Drone orthomosaic GeoTIFFs are typically hundreds of MB and use a projected
coordinate system (almost always WGS84 UTM, auto-selected by the photogrammetry
software based on GPS location) — parsing that reliably in a phone browser would be a
much bigger, riskier undertaking than anything else in this feature, for a case that's
inherently rare (most work orders have no drone flight). Instead: run this script
locally, once per orthomosaic, and it outputs (a) a small JPG well under CompanyCam's
~30MB limit, extracted from one of the GeoTIFF's own pre-baked pyramid overview levels
rather than downscaling the full image, and (b) the four corner GPS coordinates
(North/South/East/West), computed via standard UTM inverse formulas — paste both into
the admin "Drone Orthomosaic" upload form. Requires ExifTool (reads the GeoTIFF's
georeferencing tags — more reliable than hand-parsing the TIFF spec) and Pillow.
Verified against a real 293MB production orthomosaic (OpenDroneMap output, UTM zone
15N) — computed coordinates matched independent verification, and the extracted
preview was a correct, undistorted crop of the real roof.

`--upload` mode does the conversion **and** the upload/set-base-map in one command
(needs `--building-id`, `--company-cam-project-id`, `--pin`), for buildings flown
regularly (weekly, say) where retyping coordinates by hand every time doesn't scale.

**`tools/update_roof_base_map.py`** + **`tools/Update Roof Base Map.bat`** — an
interactive wrapper around `--upload` for exactly that repeat-use case: double-click
the `.bat` (or drag a `.tif` onto it), pick a building from a remembered list or add a
new one inline, optionally save the PIN, done. Not tied to any specific building —
`buildings_config.json` (gitignored — it holds the PIN) grows as buildings get added.
Uses plain `input()` for the PIN rather than `getpass.getpass()` deliberately:
`getpass` reads directly from the Windows console regardless of stdin redirection and
hangs instead of failing in some environments (found this via testing); the PIN is a
shared admin convenience gate, not a real secret, so losing the input masking isn't a
meaningful tradeoff for a wizard that reliably works everywhere.

Supported coordinate systems: WGS84 UTM (any zone/hemisphere) and plain geographic.
Anything else — a different projection entirely — prints a clear error rather than
silently computing wrong coordinates.

3-point manual anchoring for non-georeferenced maps (to recover real coordinates from
a roof_plan/sketch after the fact) is explicitly excluded per the spec, as are
roof-section labels/filters on the history map.

### Roof assets: permanent roof features (shipped)

A finding `pin` and a roof asset marker look similar on the map but mean opposite
things: a pin is **historical** — tied to one report, frozen-but-fixable (see the pin
correction section above). A roof asset is **permanent** — a physical feature of the
roof itself (drain, HVAC unit, hatch, skylight, safety hazard, etc.) that exists
independent of any work order, and is expected to be added/moved/removed over time as
the roof itself changes, not as reports get generated. This is the vision's "living
blueprint of the building" — the roof's own inventory, not its repair history.

- **Data**: `roof_assets[]` array directly on the building doc (see `DATA_MODEL.md`).
  No admin gating on create/update/reposition — `firestore.rules` already allows any
  client to `update` a building doc (only `delete` on the whole doc is blocked), and
  unlike the base map (a shared setting that affects every future report), an asset
  marker is closer in spirit to a finding pin: something any tech should be able to
  place or nudge without needing the admin PIN. Removing an asset is implemented as an
  `update` with a filtered array, not a Firestore `delete`, so it doesn't need
  `admin.js` either.
- **UI**: `openAssetModal(buildingId, assetId)` — a dedicated modal (`#asset-modal`),
  deliberately not sharing state with the finding-pin modal (`#pin-modal`) even though
  the map setup logic (satellite vs. `L.CRS.Simple` custom base map, draggable marker,
  click-to-place) closely mirrors `openPinModal()`'s. Kept separate rather than
  unifying to avoid entangling two features with different persistence targets
  (building doc vs. finding) and different gating rules — a shared abstraction here
  would have made both harder to reason about for a modest amount of duplication.
- **Icons**: `ROOF_ASSET_TYPES` maps each of the 14 types (drain, scupper, hvac,
  pipe_flashing, vent, hatch, expansion_joint, skylight, curb, penetration, core_cut,
  test_cut, safety_hazard, other) to an emoji + color, rendered as an `L.divIcon`
  (rounded square) so asset markers are visually distinct at a glance from finding pins
  (circular, colored by warranty status via `warrantyColor()`).
- **Rendering**: `renderBuildingMap()` takes `assets`/`buildingId` params and draws
  asset markers on the same map as finding pins, in whichever coordinate mode the
  building is already in (lat/lng satellite/drone_ortho, or x/y roof_plan/sketch) —
  same one-map-per-building constraint as pins, for the same CRS-mixing reason.
  `openAssetModal()` also shows other existing assets as faint (opacity 0.55) reference
  markers while placing/editing one, for spatial context (e.g. "where's the nearest
  drain relative to this hatch").
- **Not built**: leak/repair locations are deliberately *not* an asset type — those are
  already findings with pins, tracked per-report on purpose. Adding them here would
  create two competing representations of the same kind of location.

### Building picker (explicit selection, shipped)

The Phase 2 roadmap item "explicit customer/building picker UI in the Edit tab" is a
thin UX layer on top of `ensureCustomerAndBuilding()`, not a schema or behavior change —
it deliberately doesn't touch `ensureCustomerAndBuilding()`, the `customers`/`buildings`
doc shapes, or the doc-id derivation at all.

- **`openBuildingPicker()`**: a modal (`#bp-modal`) listing every building
  (`fdb.collection("buildings").orderBy("updatedAt","desc").limit(200)`, same cap style
  as `renderHistoryList()`), filtered client-side as you type (`bpFilter()`, matches
  building name / customer name / location — no server round-trip, the whole list is
  already in memory as `bpCache`).
- **`bpSelectBuilding(buildingId)`** fills `jobName`/`billTo`/`location`/`roofSystem`
  with the exact text already stored on that building doc. Because
  `ensureCustomerAndBuilding()` derives `customers`/`buildings` doc ids by slugifying
  those same two fields (`billTo`, `jobName`), filling them with a building's *own*
  stored values reproduces that exact same doc id on save — the picker doesn't need its
  own notion of "the selected building," it just makes sure the text fields say what
  they already said last time, instead of relying on a tech re-typing them from memory.
  This is also why it's safe to leave `ensureCustomerAndBuilding()` itself untouched.
- **Additive, not a replacement**: the Job Name / Bill To / Location / Roof System
  inputs stay exactly as they were — typing a brand-new job/customer still works
  unchanged. The picker only exists to reduce typo-created duplicate
  buildings/customers (e.g. "Frontier Middle" vs. "Frontier Middle School" would
  otherwise silently become two different building docs).
- **No new Firestore reads/writes beyond what already existed** — it's a read-only
  `buildings` query, gated the same as everything else in the app (no admin PIN needed,
  matches `firestore.rules`' existing open `read` on `buildings`).

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

`applyCompanyCamProjectDetail()` also pulls the linked project's real street address
into the Location field — but only when Location is empty or is already a substring of
the fuller CompanyCam address (e.g. a tech typed just "Fulton" before linking the
project). It deliberately never overwrites a Location that doesn't match, so a
technician's own, possibly-more-correct manual entry is never clobbered.

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
- ✅ **Roof map / location pins**: shipped — see the dedicated section above, including
  georeferenced drone orthomosaics (`tools/geotiff_to_webmap.py`). Still missing:
  manual anchoring for non-georeferenced maps (excluded by spec), roof-section
  labels/filters.
- ✅ **Explicit customer/building picker UI**: shipped — see "Building picker" above.
  Additive alongside the existing derive-from-text-fields approach (same Firestore
  shape, same doc-id derivation) rather than replacing the text fields outright.
- **CompanyCam activity/webhooks**, if CompanyCam's API adds them, to enrich building
  history beyond photos/documents.
- **RoofOps Admin / Customer Portal**: separate modules, out of scope for this repo
  for now.
