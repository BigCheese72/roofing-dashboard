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
  emailSubject,                     // added — see "Visible email-sent record" below
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

**Fixed 2026-07-09**: `cloudSaveOrder()`/`cloudFetchOrder()` were silently dropping
`finding_id`, `ccPhotoId`, and `gps` on every cloud round-trip — their `photos`
subcollection `.set()`/reconstruction only carried `caption`/`img`/`w`/`h`. Found while
scoping the "durable references to photo source records" roadmap item: it meant a
photo's pin-link, its CompanyCam source id, and its GPS guess all reset to
null/absent the moment a work order was saved to the cloud and reloaded from it (a
different device, or the same device after this session's local-cache changes) — which
in turn meant `companyCamPhotoIds` on `building_history_events`/`reports` (the
existing "durable reference" mechanism for CompanyCam photos) silently went empty for
any report generated after a cloud round-trip, undermining the very thing that roadmap
item was asking for. Now includes all three fields on both sides — verified against an
in-memory mock Firestore client (not real production Firestore) that
`finding_id`/`ccPhotoId`/`gps` all survive a real `cloudSaveOrder()` → `cloudFetchOrder()`
round trip through the actual functions. Forward-only fix — doesn't touch/backfill any
already-saved cloud photo docs that already lost these fields.

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

**Satellite resolution for pin placement on large roofs (shipped)** — field feedback:
placement is accurate, but a large roof has to be zoomed out to fit on screen, and at
that zoom the Esri imagery looks blurry/coarse, making precise tapping hard. (Manual
roof-tracing was floated as a fix and explicitly paused/declined — not built.)

Researched free options before touching anything:
- **Raising `maxZoom`/adding `maxNativeZoom` on the existing Esri layer** — the fix
  actually shipped. Esri's `World_Imagery` service schema declares LODs up to zoom 23,
  but its own service description says that depth is "select metropolitan areas"
  only. Verified directly against live tiles (not just the schema) at a real
  non-major-metro job site: fetched actual tile bytes at zoom 16–23 and hashed them —
  19 and 20 were genuinely distinct real imagery, 21/22/23 came back **byte-identical**
  (same tile served three times), proving 20 is that location's true resolution
  ceiling and anything requested beyond it is a wasted network round-trip for no new
  detail. Set `maxNativeZoom: 20` (shared top-of-file constant `SAT_MAX_NATIVE_ZOOM`,
  used by the pin modal, asset modal, and building-history roof map — all three
  satellite-mode Esri layers) with `maxZoom: 22` (was 21, uniformly, with no
  `maxNativeZoom` at all). Leaflet now stops re-fetching the network past zoom 20 and
  instead CSS-enlarges that last real tile for 21–22 — confirmed live: at map zoom 22
  the browser only requested the `tile/20/...` URL, and it rendered visually 4x larger
  (256px tile laid out at 1024px). Bigger on-screen targets for touch tapping on a big
  roof, zero information-theoretic sharpening (can't invent detail that was never
  photographed), zero added network cost, zero risk to existing pin accuracy (pin
  coordinates are still real lat/lng, unaffected by tile display scale).
- **A separate "Clarity" Esri layer** — Mark's instinct going in. Checked Esri's REST
  catalog directly: there is no separate free/no-key tile endpoint for this. "Clarity"
  is Esri's marketing name for periodic high-res updates *within* `World_Imagery`
  itself — already the layer in use, nothing to switch to.
- **USGS National Map imagery** (`basemap.nationalmap.gov`, free, no key, US-only) —
  tested at the same coordinates and zoom levels: 404s, no coverage there. Esri
  remains the better and already-integrated free option.
- **A paid tile provider** (Mapbox Satellite, Google, Bing) was considered and
  rejected — all require an API key/account, which conflicts with the standing "free,
  no paid/keyed services" constraint for this app.
- **The uploaded/drone-orthomosaic base map path already exists as the real "sharp"
  answer** for a roof where even over-zoomed Esri imagery genuinely isn't enough — see
  above in this section. It's intentionally admin-gated (shared, building-wide,
  affects every future report — same reasoning as the rest of that gating, not
  changed here). Not touched by this fix; still the right escalation path for a
  chronically-troublesome large roof, just not something a field tech sets up
  in-the-moment from a job site.

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

### RoofMapper: GPS + Overpass roof outline capture (Phase 1, shipped)

A new top-level tab (`showView('roofmapper')`, `#view-roofmapper`) letting a tech stand
at a building, find its footprint from GPS, tap the correct outline, then save it to
that building's record or export it. Built as a genuinely new RoofOps module, not a
separate app — same tab-bar/`showView()` pattern, same `.card`/`.btn`/CSS variables,
same Firestore instance (`fdb`), same `esc()`/`toast()`/`genId()`/`ensureCustomerAndBuilding()`
helpers everything else in the file already uses.

The task that specced this asked for a component/hook/service folder layout
(`components/RoofMapper`, `hooks/useGeolocation`, `services/overpassService`,
`services/exportService`, `types/roofMapperTypes`, `utils/geometry`) — this app has no
build step or framework, so that structure was adapted into clearly delimited comment
sections inside `index.html`'s single `<script>` block instead of real files, in the
same order, right before `/* ================= init ================= */`:

- **`utils/geometry` → `rmGeom*`**: haversine distance, a flat-earth local
  meters projection (fine at building scale), shoelace polygon area, perimeter, and
  `rmGeomCleanRing()` (dedupes near-duplicate Overpass nodes, force-closes the ring).
- **`hooks/useGeolocation` → `rmGeoRequest()`**: thin wrapper around
  `navigator.geolocation.getCurrentPosition` (high accuracy, 20s timeout), mapping
  each `GeolocationPositionError` code to a friendly message (denied / no signal /
  timeout) rather than reusing `useMyLocationForPin()`'s pin-modal-specific code —
  same underlying browser API as the existing "Use My Location" pin feature, kept as
  a separate function since RoofMapper's caller/UI is unrelated to the pin modal.
- **`services/overpassService` → `rmFetchNearbyBuildings()`**: POSTs an Overpass QL
  query to the public `overpass-api.de` endpoint, falling back to the
  `overpass.kumi.systems` mirror on failure. Free, no API key, matches the "no paid
  add-ons" constraint. Relations are handled naively — every `outer`-role member's
  geometry is concatenated into one ring, correct for the common single-outer-way
  case; complex multi-outer relations may render approximately. Not a real bug for
  Phase 1 (single commercial buildings are almost always a plain `way`), just a known
  limitation if it's ever revisited.
  - **Search radius (fixed after a real field test)**: the first shipped version
    fixed the radius at 60–150m and queried `way["building"]`/`relation["building"]`
    only. A field test at St. Joseph Hospital (Lake Saint Louis, MO) returned "no
    buildings found" standing in the parking lot. Root-caused to **two** separate
    problems, not just radius:
    1. **Radius too tight.** A hospital campus building can be 100m+ from where a
       tech parks. Fixed with `RM_RADIUS_STEPS = [150, 300, 500]` (meters — roughly
       500ft/1000ft/1600ft) plus `rmPickInitialRadiusIndex()`, which picks the first
       step that already covers the GPS fix's own accuracy radius (`accuracy * 2.2`)
       so a poor fix doesn't produce a false empty result. A **"🔎 Search Wider"**
       button steps through the ladder without re-requesting GPS, showing the radius
       actually used in the status text either way.
    2. **Query too narrow — the real cause of this specific case.** The hospital's
       actual OSM footprint (`way/590977492`) has **no `building=*` tag at all** —
       only `amenity=hospital`/`healthcare=hospital`. A building-only filter misses
       it at *any* radius. This is a common OSM pattern: a mapper tags a structure by
       what it *is* rather than adding a redundant `building=*` on top. Fixed by
       broadening `rmOverpassQuery()` to also match `way["amenity"]` (excluding
       ground-level amenity values that aren't a roof — `parking`, `parking_space`,
       `bicycle_parking`, etc.), `way["healthcare"]`, `way["shop"]`, `way["office"]`,
       and `way["leisure"]` (excluding `park`/`pitch`/`garden`/etc.), plus the
       `relation` equivalent for `amenity`. `rmSelectFootprint()`'s "Type:" line
       falls back through `building → healthcare → amenity → shop → office →
       leisure` so the tech still sees what kind of structure they picked.
    - **Verified against the real failure case** (not just in theory): queried
      Overpass directly at 38.8029745, -90.7755764 (the field-test coordinates) —
      0 results at 150m/300m with the old building-only query; 1 result (the
      hospital itself, 98m away) at 150m with the broadened query — found on the
      very first radius step once the query was fixed, without even needing to
      widen. Confirmed the White House test case from Phase 1's original
      verification still returns results with the broadened query (53 vs. 8
      before — expected, not a regression, since more tag types now match).
  - **Site/campus polygons vs. real building footprints (second field test, same
    location)**: the radius+query fix above found a footprint at St. Joseph
    Hospital, but a screenshot from the field showed the generated "roof outline"
    tracing the *entire hospital campus* — parking lots, grounds, a waterfront inlet
    — at ~969,000 sq ft. Investigated directly against Overpass at the exact
    coordinates (38.8029745, -90.7755764):
    - A pure `way["building"]`/`way["building:part"]` query within 500m returns only
      two unrelated small businesses (a Hardee's and a gas station canopy, 380–440m
      away) — **zero** building-tagged footprints anywhere near the hospital itself.
    - A query for *any* tagged way (building/amenity/healthcare/leisure/shop/office)
      within 200m returns exactly **one** element: the hospital's own
      `amenity=hospital`/`healthcare=hospital` polygon, 79–98m away — confirming
      OpenStreetMap genuinely has no individual building footprint mapped for this
      site at all, only the property-level polygon. (What Mark saw as "building
      rectangles" on the tile was almost certainly this one polygon's own
      right-angled corners, rendered at a zoom level where they read as separate
      structures — the polygon has 25 vertices wrapping several wings of the
      campus.) This is a real, common OSM data gap (no bulk building-footprint
      import for this parcel), not a bug in the query — but the app still needs to
      not hand a tech a "roof" that's actually the whole property.
    - **Fix — classify, don't just fetch.** `rmParseOverpassElements()` now flags
      each footprint `isSite: true` when it has **no** `building`/`building:part` tag
      **and** its area exceeds 200,000 sq ft (~4.6 acres) — generous enough to not
      misflag a real huge building (a big-box store, an airport terminal) that *is*
      tagged `building=*`, but catches exactly this campus-polygon case.
      `rmSearchBuildings()` then prefers real (non-site) footprints whenever any
      exist, and only falls back to showing site-classified ones when nothing else
      was found nearby — the tech should never have to choose between "the roof"
      and "the whole property" if a real footprint exists at all.
    - **When there's genuinely nothing better** (this exact case): the site polygon
      is still shown — an approximate reference beats nothing — but visibly
      different at every step: dashed amber outline on the map instead of solid
      gray, a warning line in the footprint info panel, the "Generate Roof Outline"
      button relabels to "⚠️ Use Site Boundary Anyway (Not a Roof)" (danger-styled,
      not primary), the outline panel gets a persistent warning banner, the
      exported/saved title is prefixed "⚠ Site Boundary — ", and saving (to a
      building or locally) requires confirming a `confirm()` prompt that repeats the
      warning. `roof_outlines[]` entries carry the `isSiteBoundary` flag (see
      `DATA_MODEL.md`) so it also surfaces later in the Building History popup via
      `rmOutlineTitle()`.
    - **Re-verified against the field-test coordinates after the fix**: search
      correctly returns the hospital's site polygon flagged `isSite: true` (no real
      building footprint exists to prefer instead) with the full warning UI; the
      White House case (which does have real `building=*` footprints) returns 53
      real buildings, 0 sites, no warnings, normal save behavior — confirms the
      classifier doesn't misfire on the happy path.
- **`services/exportService` → `rmExport*()`**: fully client-side, no paid rendering
  service. `rmBuildOutlineSvg()` projects the lat/lng ring to local feet and draws an
  SVG with a title, area/perimeter, and a scale bar — this SVG is the source of truth.
  PNG rasterizes that same SVG via an offscreen `<canvas>` so the two always match.
  PDF uses the jsPDF instance already loaded for work-order PDFs (`window.jspdf.jsPDF`,
  same access pattern as `generatePdf()`), drawing the polygon with `doc.lines()`.
- **`components/RoofMapper` → `rm*` state/view functions**: `rmState` holds the map,
  GPS fix, candidate footprints, and the currently generated outline. The map itself
  uses real **OpenStreetMap tiles** (`tile.openstreetmap.org`), deliberately different
  from the Esri satellite tiles the rest of the app uses for pins/assets — the task
  spec called for OSM tiles specifically for this Phase 1 flow, and Overpass data is
  naturally OSM-flavored (tags like `addr:housenumber`, `building=*`) so it reads
  consistently paired with OSM basemap tiles.

**Flow**: `rmUseMyLocation()` → `rmSearchBuildings()` (Overpass) → tap a footprint
polygon (`rmSelectFootprint()`) → `rmGenerateOutline()` cleans the selected footprint's
ring and computes area/perimeter → save and/or export.

**Save target — additive, non-admin-gated, same pattern as roof assets**: generated
outlines write into `roof_outlines[]` on the `buildings` Firestore doc (see
`DATA_MODEL.md`), via `.set({ roof_outlines: [...] }, { merge: true })` so it works
whether or not the building doc already exists. Any tech can save one — no PIN, no
`admin.js` round-trip — same reasoning as roof assets: `firestore.rules` already allows
client `update` on a building doc, and this is closer in spirit to a finding pin/asset
marker (anyone should be able to add one) than to the shared, admin-gated base map
setting. Two save paths from `#rm-save-modal`:
  - **Link to an existing building** — reuses the same building-list fetch pattern as
    `openBuildingPicker()` (kept as a separate `rmBpCache`/`rmBpRender()` rather than
    sharing `bpCache`, since that picker's click handler fills the Edit form's text
    fields — a different job than saving an outline).
  - **Create a new building** — calls the existing `ensureCustomerAndBuilding()`
    directly with just Job Name/Bill To, so a RoofMapper-created building lands on the
    exact same slugified customer/building id a work order for the same
    name/customer would later derive — no duplicate-building risk, no new id scheme.
- **Local-only fallback**: `rmSaveLocally()` pushes into a `localStorage` array
  (`roofmapper-local-outlines-v1`, capped at 50) for the no-signal/no-building-yet
  case — mirrors the app's existing local work-order cache philosophy (cloud is
  preferred, local is a safety net, never the only copy by choice). The "Saved On This
  Device" panel lists these with Load/Delete; Load re-draws the outline and re-opens
  the save/export actions so a locally-saved outline can be linked to a building later
  once there's a connection.

**Building History integration**: `renderBuildingMap()` gained an `outlines` parameter
(both call sites in `openBuildingHistory()` now pass `bld.roof_outlines`) and draws any
saved outline as an orange polygon alongside existing pins/assets — additive only,
the existing pin/asset code paths are untouched. Same one-map-per-building,
lat/lng-only tradeoff as pins/assets: an outline won't appear on a building that's
switched to a custom `roof_plan`/`sketch` base map, since there's no coordinate system
to convert real lat/lng into that image's pixel space (documented, not a bug — see
"Roof map: base maps + location pins" above for the identical tradeoff on pins).

**Not built (Phase 1 scope, intentionally)**: editing/adjusting a generated outline's
vertices by hand (it's exactly what Overpass returned, cleaned of duplicate nodes,
nothing more); merging multiple `roof_outlines[]` entries into one "current" outline
(newest-first is left to whoever reads the array); anything from the "future
expansion" list in the task spec (drains/HVAC/scuppers/pipe penetrations/dimensions/
CompanyCam photos/drone orthomosaic overlays) — deliberately out of scope, but
`roof_outlines[]`'s shape (a plain array on the building doc, same convention as
`roof_assets[]`) is meant to extend the same way roof assets did, not be replaced.

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

### Timeline filters (shipped)

Phase 3 roadmap item. Filters the Building History timeline by date range, roof area
(`roofType`), technician, warranty status, and report type — **entirely client-side**,
no new Firestore query, no new index, no data model change. `openBuildingHistory()`
already fetches every event for a building in one query (`limit(50)`); filtering is
just re-rendering that same in-memory array.

- **`historyEvents`/`historyBuildingId`**: module-level state set by
  `openBuildingHistory()`, read by the filter functions so they don't need the
  building id threaded through every call.
- **`populateTimelineFilterOptions()`** builds each dropdown (Roof Area, Technician,
  Warranty Status, Report Type) from the *distinct values actually present* on this
  building's own events (`tlDistinctSorted()`), not a hardcoded list — a filter option
  never returns zero results, and a building that's only ever seen one technician
  doesn't show a dropdown full of other buildings' names.
- **`filterTimelineEvents()`** is a plain array `.filter()`, ANDing every active filter
  together. **Date range filters on `createdAt`** (when the report was generated/logged),
  *not* the `date` field — `date` is free text as typed into "Date of Service" (see the
  `building_history_events` shape above) and isn't reliably parseable, so it can't
  safely back a date-range comparison. This is called out directly in the UI (a hint
  line above the filter row) since the two dates are usually close but not guaranteed
  identical.
- **`renderTimelineList()`** re-renders `#timeline-list` only — the Roof Map and its
  pins/assets are untouched by timeline filters (the roadmap wording is specifically
  about filtering the timeline, not what's on the map).
- Wired via plain `onchange` handlers (no debounce needed — filtering an in-memory
  array of at most 50 events is effectively instant).

### Duplicate building detection (shipped, detection only — merge is a separate decision)

Phase 2 roadmap item: "decide how to handle duplicate building names." Ships the
*detection* half now; the *merge* half (an admin action that deletes a building and
reassigns its history) is a live-data-write capability and is being held for explicit
product sign-off before it's built — see the note at the bottom of this section.

- **`buildingsLikelyDuplicate(a, b)`**: deliberately conservative. Only flags a pair if
  they share the exact same normalized `customerName` — different customers with
  similar building names are out of scope (an admin can still spot those by eye); a
  wrong flag is just an unnecessary badge, but the *merge* this is meant to lead into
  is destructive, so false positives are worth avoiding more than false negatives.
  Within the same customer, flags an exact normalized-name match, a substring
  containment (`"Frontier Middle"` vs. `"Frontier Middle School"`), or a Levenshtein
  distance ≤25% of the longer name's length (`dupLevenshtein()`, a plain DP
  implementation — no library, matching this repo's no-build-step constraint).
- **`flagPossibleDuplicateBuildings(list)`** runs over the same `buildings` list
  `renderHistoryList()` already fetches (`limit(100)`, existing query, no new
  Firestore read) — O(n²) pairwise comparison, fine at this scale.
- Flagged buildings get a red left-border (matching the existing duplicate-*report*
  badge convention from `flagDuplicateEvents()`) and a "Possible duplicate" badge.
  `lastBuildingList` caches the flagged list in memory for the not-yet-built merge
  action to reference without re-fetching.
- **Why merge isn't in this increment**: an admin-side `merge_buildings` action
  (reassign the loser's `reports`/`building_history_events` to the survivor, merge
  `roof_assets`, fill in blank survivor fields from the loser, delete the loser) was
  designed and drafted, matching the existing `delete_building`/`set_building_roof_map`
  pattern in `admin.js`. It was intentionally **not** committed — deploying it means
  any admin clicking it on the `dev` branch-deploy performs a real, irreversible delete
  against the same live Firestore project production reads from (see the dev/prod
  Firestore-sharing note earlier in this file). That crosses "write to live data,"
  which needs explicit sign-off before shipping, not just a sound code-level call.
  **Status: explicitly shelved per product decision** — do not build the merge action,
  or any other feature that mutates/deletes existing buildings/records, without new
  sign-off. The design above is kept only as a reference for when that sign-off happens.

### All Reports view (shipped, read-only)

Phase 4 "Dashboard" seed. `reports` is a flat, append-only collection that's been
written on every report since early in this project (`logReportAndHistoryEvent()`) but
was never read by anything until now — this is that first read.

- **Single query, no composite index needed**: `fdb.collection("reports")
  .orderBy("createdAt","desc").limit(200)` — no `.where()`, so unlike
  `building_history_events`'s per-building query (which needs a composite index, see
  below), this works with zero Firestore console setup. If a `.where()` clause is ever
  added here (e.g. server-side building/customer filtering instead of the current
  client-side text search), that's the point to revisit indexing.
- **Filtering is entirely client-side** over that one fetch — a text search box
  (matches `buildingName`/`customerName` substring) plus the same four
  distinct-values-from-the-data dropdowns as the timeline filters (`rpDistinctSorted()`,
  same pattern as `tlDistinctSorted()`) plus a date range on `createdAt`. Read-only, no
  admin gating — same reasoning as the timeline filters.
- **Tapping a report** (`rpJumpToBuilding()`) switches to Building History and opens
  that report's building via the existing `openBuildingHistory()` — no new navigation
  code, just reuses the tab-switch + detail-load that already exists.
- **A report with no linked building** (`buildingId` missing/null) renders as
  "(unknown building)" and tapping it toasts instead of navigating, rather than
  throwing — found this exact case in production while testing (see below).
- **Known pre-existing data inconsistency, found (not caused) by building this** — see
  the dedicated writeup below ("`reports`/`building_history_events` ID-mismatch,
  investigated").

### `reports`/`building_history_events` ID-mismatch (investigated, read-only — root cause found, not fixed)

Investigated 2026-07-09, read-only (no writes made). Full production state at the time:
**4 docs in `reports`, 2 docs in `building_history_events`** (the entire collection —
confirmed by fetching it unfiltered, not just querying by a specific id/workOrderId).

**Root cause, high confidence — a since-fixed ID bug, not an ongoing one.** The very
first version of `logReportAndHistoryEvent()` (commit `04166dd`, 2026-07-08 18:42)
called `fdb.collection("reports").doc()` and
`fdb.collection("building_history_events").doc()` **separately**, each generating its
own independent random Firestore auto-id. Both docs were still written together in one
atomic `batch.commit()` (so no partial-write data loss from this alone), but under
**different, unrelated ids** — meaning "look up the history event by the report's id"
silently returns nothing for anything written this way, even when the sibling exists.
Commit `0928b51` (2026-07-09 04:17, "Flag duplicate timeline entries and let admin
delete individual ones") fixed this — it generates **one** id
(`fdb.collection("reports").doc().id`) and reuses it for both `.set()` calls — but only
because the new per-entry admin-delete feature needed a shared id to delete both sides
together. Nothing about the bug itself had been noticed before that.

**Confirmed against the real timestamps** — every one of the 4 real `reports` docs was
created within the same ~16-hour window this whole feature was first being built and
iterated on (2026-07-08 18:42 → 2026-07-09 04:17 → later that morning):

| Report | `reportType` | `createdAt` (local) | Relative to the 04:17 fix | Sibling in `building_history_events`? |
|---|---|---|---|---|
| `QHfSr0Gy…` | PDF Downloaded | 7/9 10:47 | **after** | ✅ same id (`QHfSr0Gy…`) — correctly paired |
| `wHALC1qZ…` | PDF Shared | 7/8 20:13 | before | ✅ found under a **different** id (`dox2XWfDW…`) — same `reportType`, same exact `createdAt`, same (null) `buildingId`. Data intact, just unjoinable by id. |
| `RP2XlBAO…` | PDF Shared | 7/8 20:16 | before | ❌ none anywhere in the collection |
| `ePEKp4cE…` | PDF Shared | 7/8 20:22 | before | ❌ none anywhere in the collection |

The one post-fix report is correctly paired. Of the three pre-fix reports, one has its
true sibling sitting under an unrelated id (exactly what the bug predicts), but two have
**no** sibling anywhere — confirmed by dumping the entire (2-doc) collection, not just a
targeted query, so this isn't a query/join artifact.

**That last part doesn't fully resolve on code history alone.** Firestore's
`batch.commit()` is atomic — if the bug alone were the whole story, every pre-fix report
should have *a* sibling somewhere (mismatched id, but present), the way `wHALC1qZ…` does.
Two reports having *no* sibling at all is a step further than the id-mismatch bug
explains by itself. Best working hypothesis: those two were most likely produced during
the same evening's active development/testing of this brand-new feature (both are
Westminster "PDF Shared" actions six minutes apart, right in the middle of the commits
that touched this exact function — `b67fd15` at 19:00, `879fa14` at 19:27) rather than
routine field use — e.g. manual testing against production while iterating on the
feature, possibly under a locally-modified/uncommitted state of the code at that moment.
Couldn't be confirmed further without either error logs from that session or asking
whoever was driving it.

**Is it still happening? No** — high confidence. `logReportAndHistoryEvent()` is the
*only* place in `index.html` that writes to either collection (confirmed by search), it's
the only version that's ever run in production since the 04:17 fix, and the one report
created after that fix is correctly paired. Every new report going forward should pair
correctly.

**Blast radius, right now: small.** Only 4 report docs exist in all of production (this
feature is about a day old). Practical effect: Westminster's Building History timeline
currently shows 1 event where `reports` shows 3 separate report-generation actions for
the same work order — the timeline/roof-map/duplicate-detection features are all quietly
under-counting for that one building until this is addressed. No evidence of a wider or
ongoing problem.

**Recommended fix (not implemented — would write to live data, needs sign-off)**:
1. Nothing needed for new reports going forward — already fixed.
2. For the id-mismatched-but-intact pair: either leave as-is (the only thing it actually
   breaks today is the per-entry admin delete silently no-op'ing on the `reports` side
   for that one legacy pair — low-risk) or re-key it under a shared id.
3. For the two genuinely orphaned reports: their `reports` doc already has the complete
   payload (`reports` and `building_history_events` are supposed to be identical
   payloads) — recreating the missing `building_history_events` sibling from the
   existing `reports` doc's own data is a mechanical, low-risk backfill.
4. Given the volume (2 affected docs, one still-new feature), a one-time reviewed backfill
   script run once by a human — matching this repo's existing `tools/` pattern
   (standalone, not part of the deployed app) — fits better than new in-app logic for a
   problem this small and this unlikely to recur.

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

`applyCompanyCamProjectDetail()` also pulls the linked project's real name and street
address into **Job Name** and **Location** (shipped 2026-07-09, extending what was
originally Location-only) — but only when the field is empty or its current value is
already a substring of the fuller CompanyCam value (e.g. a tech typed just "Fulton"
before linking the project, or the building picker filled in a shorter name from an
older record). Both fields use the identical rule, and it deliberately never overwrites
a Job Name/Location that doesn't match, so a technician's own manual entry — or the
building picker's explicit pick — is never silently clobbered by opening a CompanyCam
project afterward. `mapProject()`'s own `"(unnamed project)"` fallback (for a CompanyCam
project with no real name) is explicitly excluded from ever filling Job Name. One
combined toast ("CompanyCam Job Name & Location added", or just whichever one actually
changed) rather than two separate ones.

**"Job Name" vs. "Building Name" — there is no separate field.** Checked explicitly
(2026-07-09) after Mark asked for the CompanyCam name to fill "Building Name" instead of
"Job Name": `FIELD_IDS` (the full list of editable work-order fields) has no
`buildingName` entry — `jobName` (labeled "Job Name" in the UI) is the *only* field for
this, and it's already the literal source of the building's identity:
`ensureCustomerAndBuilding()` sets `buildings.name` straight from `o.jobName`. So
filling `jobName` from the CompanyCam project's name *is* "populate the building name
from CompanyCam" — same field, just labeled "Job Name" on screen. No field-targeting
change was needed; strengthened the code comment in `applyCompanyCamProjectDetail()` to
say this explicitly, so the next person reading it doesn't have to re-derive it.

Verified against real project data (St. Mary's Hospital - St. Louis, id `54362584`),
twice — once when this shipped and again after the "Building Name" clarification:
empty fields fill correctly with the real name/address; a field already holding an
unrelated value (e.g. "My Own Building Label") is left untouched; a field holding a
substring of the real value (e.g. "St. Mary's") upgrades to the full value; the
`"(unnamed project)"` fallback never lands in Job Name. Read-only against the real
`project_detail` response — no Firestore or CompanyCam writes.

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

**"No photos load when importing" investigation (2026-07-09)** — a real field report
(clicking "St. Mary's Hospital - St. Louis" showed zero photos). Investigated
extensively: called the `photos` action for **all 25 real projects** in the account, on
both `dev` and `main` — every one returned photos correctly, including the specific
project Mark named (30 photos, both branches). Ruled out a token/scope problem, a
CompanyCam response-shape change, and a dev-vs-production config difference. Along the
way, checked a suspected HTML-escaping typo in `ccLoadProjects()` — turned out to be a
misread during that investigation, not a real bug (git blame confirms that line has
always been correct). **Conclusion: not a reproducible bug** — most likely a transient
network hiccup on the reporting device at that moment. One real, small gap fixed
regardless: the `photos` action's error handling now matches `projects`/
`project_detail` — includes CompanyCam's actual response body on a non-2xx response
instead of just the bare status code, so if this ever does happen again for a real
reason, the toast will say why. Verified against a live invalid-project-id request
(real CompanyCam 403): `{"error":"CompanyCam said: 403 {\"errors\":[\"Forbidden\"]}"}` —
confirmed the body now comes through.

### Push app-added photos to CompanyCam — DECIDED: not doing this (2026-07-09)

**Closed, not just parked.** Mark's call: not willing to pay for photo hosting at this
time. The integration stays **pull-only** — import photos FROM CompanyCam, as it works
today (see "Push app-added photos to CompanyCam — investigation" below for why this
isn't a small feature and won't quietly get built as a side effect of some other
change). Don't resurface this as an open roadmap item; if it's ever revisited, it's a
new product decision, not a continuation of this one.

**Why**: CompanyCam's photo-upload API requires a publicly-fetchable URL for every
photo (confirmed via their own docs — see below), and this app deliberately has no
photo hosting that produces a public URL (no Firebase Storage, by design). Making this
feature work would mean paying for and standing up a hosting layer — Storage or
equivalent — purely to support this one feature. Mark decided that cost isn't
justified right now. The existing pull path (import photos FROM CompanyCam into a work
order) already covers the common case and needs no hosting at all.

**If this is ever revisited**, the matching-strategy decisions already made are still
good and don't need re-litigating:
- Match by CompanyCam project **name** only, never auto-create a project.
- If no name match, skip/prompt rather than create (exact UX was flagged as needing
  more thought — exact vs. fuzzy match, case sensitivity, what "the job's name" means
  before a project is linked).
- Dedupe by `ccPhotoId` — already reliable today.
- Push at send/finalize time, not on every photo add.

The rest of the original investigation (API requirements, why it's a bigger change than
it looks) is preserved below for reference only.

#### Push app-added photos to CompanyCam — investigation (superseded, scoped 2026-07-09)

**Trigger**: a real field report — Mark added phone photos to a work order and expected
them to appear in the matching CompanyCam project, but they didn't; he had to add them
to CompanyCam manually.

**Diagnosis, confirmed by reading every line of `companycam.js` and every photo-add
code path in `index.html`**: the integration is **pull-only**, with exactly one
exception. `companycam.js` supports `projects` / `project_detail` / `photos` / `image`
(all reads) and `upload_document` (the one write — PDFs only, to
`/v2/projects/{id}/documents`). There is **no code path anywhere, client or function,
that uploads a photo to CompanyCam.** `addPhotosFromFiles()` (the "+ Add Photos"
camera/file button) purely compresses the image client-side and pushes it into the
local `photos` array — no CompanyCam awareness at all, regardless of whether the work
order has a linked project. This isn't a bug in existing code; the capability simply
was never built.

**API requirements, researched against CompanyCam's live API reference
(`companycam.readme.io`)**:
- **Add Photo**: `POST /v2/projects/{project_id}/photos`, body `{ photo: { uri,
  captured_at, coordinates?, description?, tags? } }`. **Confirmed 2026-07-09 (was a
  hedge before, now definitive)**: CompanyCam's own changelog example for this exact
  endpoint shows `"uri": "https://m.media-amazon.com/images/M/MV5B.../V1_.jpg"` — a
  real, publicly-accessible external URL, not base64 or multipart. This is corroborated
  by the sibling `upload_document` endpoint (which this app already uses successfully)
  explicitly documenting its `attachment` field as **"Base64 encoded file contents"** —
  a completely different field name and format from `uri`. **CompanyCam's photo API
  requires a publicly-fetchable URL; it does not accept embedded image bytes.**
- **This means**: app-added photos are stored as base64 with no public URL anywhere
  (deliberately — no Firebase Storage, per this repo's own ground rules). Pushing them
  to CompanyCam **requires** *some* public-URL hosting
  step — which either means reintroducing Storage (explicitly gated behind checking
  with the user first) or some other public-hosting mechanism. **This could turn "add
  a photo-upload API call" into "stand up a hosting layer," a materially bigger and
  riskier change than it first looks.**
- **Create Project**: `POST /v2/projects`, body `{ name, address?, coordinates?,
  primary_contact? }` — real capability, would be needed for the "or create one" half
  of "match/create project by job name."
- **Auth**: both are Bearer-token endpoints, same scheme as the existing
  `upload_document` write. Whether the current `COMPANYCAM_TOKEN`/
  `COMPANYCAM_WRITE_TOKEN` actually carries write scope for photos/projects (not just
  documents) is **unverified** — CompanyCam tokens are typically account-wide rather
  than narrowly scoped, so it likely does, but that's an assumption, not a confirmed
  fact, and checking it means either a live write or looking at the token's scopes in
  CompanyCam's own dashboard.

**Dedupe strategy — already solved, low-risk**: every CompanyCam-imported photo already
carries a stable `ccPhotoId` (and, since the recent `cloudSaveOrder()`/`cloudFetchOrder()`
fix, that id now reliably survives cloud round-trips). The rule is simply: only push
photos where `ccPhotoId` is falsy. No new field needed.

**Final status**: decided against, see the closed-decision summary at the top of this
section. Not built, not planned.

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

## Local work order cache (localStorage) — quota fix (shipped)

`loadDb()`/`saveDb()` (`index.html`) keep a local offline fallback of saved work
orders in `localStorage` under `STORE_KEY`, separate from — and in addition to —
the Firestore `workorders` collection. `localStorage` has a hard **~5–10MB
per-origin quota** with no tier/upgrade; `saveDb()` catches `QuotaExceededError`
and shows "Storage is full — delete some old saved work orders…".

**Root cause (found 2026-07-09, from a real user report on production `main`)**:
every locally-cached work order embedded its photos as base64 **directly** in the
cached JSON blob (`photos[].img`), and — critically — `loadOrder()`'s cloud-fetch
paths wrote the **full** fetched order (photos included) back into `localStorage`
purely from *opening/viewing* a report, not just from an explicit Save. A single
real photo-heavy work order can be ~3MB of base64 by itself (confirmed against
production: Westminster's 10-photo report is ~3MB) — so simply opening a couple of
old reports on a device that already has some local history was enough to blow
past the quota, exactly matching the reported repro (opening an old report, not
saving one, triggered the error).

**Fix, both pieces pure client-side — no Firestore/data-model change, no live-data
writes**:
1. **Viewing ≠ caching.** `loadOrder()`'s two cloud-fetch branches now cache via
   `stripPhotoBytes(o)` instead of the raw fetched order — every field is kept
   (job info, findings, repairs, photo captions/finding links) *except*
   `photos[].img`. The lightweight `db.index` entry (used by the Saved-tab list)
   is still updated normally. Only an explicit **Save** on the order currently
   open in the Edit tab (`saveOrder()`) caches full photo bytes — that path is
   deliberately untouched, so offline editing of the *active* draft still works
   exactly as before.
2. **Bounded safety net.** `pruneCachedPhotoDrafts()`, called from `saveOrder()`
   right before `saveDb()`, keeps only the `MAX_CACHED_PHOTO_DRAFTS` (10)
   most-recently-saved drafts with their photo bytes intact; older ones get
   `stripPhotoBytes()`'d automatically. The draft currently open (`currentId`) is
   always excluded from pruning regardless of its save age, so a long active
   editing session never loses its own photos out from under it. Nothing is
   lost — Firestore always has the full photos (in the `photos` subcollection,
   already scoped small per `cloudSaveOrder()`); this only bounds what's
   available for offline re-editing *without* a network round-trip.

**Deliberately left untouched**: `exportOrder()`'s cache write still caches full
photo bytes when fetching from cloud. It's a rare, explicit "give me the full
file" user action (not passive viewing), and needs the full data to produce a
valid export anyway — out of scope for this fix.

**Known tradeoff**: a report that was only *viewed* (not saved) now shows without
its thumbnails if reopened later while fully offline (no network to re-fetch) —
job info, findings, repairs, and captions still display correctly, just not the
images themselves, until back online. This is the intended tradeoff — it's what
stops the quota problem — not a bug.

**Verified against production data (read-only Firestore reads; zero writes)**:
using the real 10-photo/~3MB Westminster report, with `localStorage`
pre-filled to ~4.5MB to simulate a realistic near-full device: opening it via
`loadOrder()` completed with "Loaded from cloud ✓" (no quota error), all 10
photo entries cached with `img` stripped but captions/other fields intact, and
the on-screen/in-memory photos remained fully visible (10/10 thumbnails
rendered) — only the local cache write was affected. `saveOrder()`'s full-photo
local caching (with `fdb` temporarily nulled out to guarantee zero risk of a
Firestore write during the test) was confirmed unchanged. `pruneCachedPhotoDrafts()`
was verified directly against synthetic in-memory data (15 fake drafts → correctly
keeps the 10 most recent, strips the rest, always protects the currently-open
draft regardless of age). Zero console errors throughout.

### Visible email-sent record (shipped)

**The problem this fixes**: `sendEmailNow()` always did log a durable record on success
(`logReportAndHistoryEvent(o, "PDF Emailed", {sent:true, to:addrs})`, written to both
`reports` and `building_history_events`) — but that record was easy to miss. The only
way to see it was Building History → the right building → scroll the timeline → spot a
small "Emailed ✓" tag among several others. Confirmed via a real production incident
(2026-07-09): a real send (to `charlottew@watkinsroofing.net`, for the "Planet fitness"
work order) **had** logged correctly end-to-end — `reports` doc, paired
`building_history_events` doc, `buildings` doc, all present and correct — but neither
the office nor the tech who sent it could find any record of it. Not a data-loss bug;
a pure discoverability gap. (Also added `emailSubject` to the logged payload while here
— it wasn't being captured at all before.)

**Fix, two complementary pieces, both additive — no restructuring of `reports` /
`building_history_events` / `workorders`:**
1. **`markWorkOrderEmailed(workOrderId, addrs)`** — called from `sendEmailNow()` right
   after a successful send (fire-and-forget, never blocks the send confirmation, a
   failure here doesn't mean the email didn't send — `logReportAndHistoryEvent`'s
   history entry is still the record of record either way). Merge-patches
   `lastEmailedAt`/`lastEmailedTo` directly onto the `workorders/{id}` doc (`.set(...,
   {merge:true})` — every other field on that doc is untouched), and mirrors the same
   two fields onto the local `db.index` entry and `cloudIndexCache` entry so the Saved
   tab updates immediately without a refetch. `cloudFetchIndex()` now also selects
   these two fields, so a fresh load (a different device, or after a reload) shows it
   too.
2. **Surfaced in the two places someone would actually be looking:**
   - **Saved tab** (`drawSaved()`): "📧 Emailed *[timestamp]*" appended to a work
     order's meta line whenever `lastEmailedAt` is set — this is the list both office
     and techs already use to find a work order, so it's the most discoverable
     location, no digging into Building History required.
   - **Building History timeline** (`timelineEventHtml()`) and the **Reports tab**
     (`rpReportItemHtml()`): upgraded the existing small "Emailed ✓" tag with a
     dedicated `"📧 Emailed to <recipients>"` row, so it's an explicit, readable
     confirmation with *who* it went to, not just a checkmark.

**Design choice, not asked back to the user**: surfaced in both places (Saved list +
existing timeline/reports views) rather than picking one exclusively, since neither
forecloses anything — no new collection, no new view, nothing that would need
undoing if a dedicated "sent emails" log is ever wanted later.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**: `logReportAndHistoryEvent()` with a subject correctly wrote
`emailSubject`; `markWorkOrderEmailed()` correctly merge-patched `lastEmailedAt`/
`lastEmailedTo` onto a pre-existing mock `workorders` doc without touching its other
fields (`jobName`/`billTo`/`savedAt` all survived unchanged); the local-only path (`fdb`
nulled) correctly patched `db.index` and rendered the "📧 Emailed …" marker into the
Saved tab DOM; `timelineEventHtml()`/`rpReportItemHtml()` both render the new recipient
row with correct HTML-escaping (tested with a deliberately hostile email string
containing `<s>`, confirmed no injection leak). Zero console errors. Real end-to-end
verification (an actual send through the deployed dev app) is for Mark to run himself,
per the standing testing discipline.

### One timeline entry per work order (shipped 2026-07-09)

**The bug**: Building History sometimes showed multiple timeline entries for the same
work order. Root cause, confirmed by reading every place `logReportAndHistoryEvent()`
is called (`downloadPdf()`, `sendEmailNow()`, all three branches of `sharePdf()`):
every single call generated a **brand-new random Firestore auto-id**
(`fdb.collection("reports").doc().id`) with no concept of "this work order already has
an entry." Resending to a different recipient, resharing, or resaving all independently
called this function again, each time inserting a whole new `reports` +
`building_history_events` doc pair. This was the *original* design intent, not a
regression — `flagDuplicateEvents()` (a 5-minute-window "possible duplicate" badge, see
below) exists specifically because this was expected to happen occasionally from
double-clicks/retries. What wasn't anticipated: genuinely resending the same job to
several different people over hours, which the 5-minute window doesn't catch and which
produced real, lasting duplicate timeline entries rather than an occasional near-instant
retry artifact.

**Confirmed in production data (read-only count, 2026-07-09)**: 10 total
`building_history_events` docs across 5 distinct work orders — **2 of those 5 work
orders have duplicates** (one with 4 entries, one with 3; the other 3 work orders
correctly have exactly 1 each). Timestamps on the duplicate groups span from ~10 seconds
apart up to ~4 hours apart, consistent with a mix of quick retries and genuine later
resends — exactly the reported symptom. **Cleanup performed 2026-07-09 — see below.**

**Fix**: `logReportAndHistoryEvent()`'s doc id is now deterministic —
`"evt_" + workOrderId"` — instead of random, so every subsequent call for the same work
order **upserts the same doc** instead of inserting a new one. This is also race-safe:
even two near-simultaneous sends resolve to the same id, so the outcome is still exactly
one document (last-write-wins on whichever fields raced), never two. To keep an upserted
entry meaningful rather than just "whatever the latest action happened to be":
- `createdAt` is preserved from the *first* time a work order is logged (read-before-write:
  fetches the existing doc, if any, and carries its `createdAt` forward) — so the
  timeline entry doesn't jump to "just now," and re-sort to the top, every time it's
  resent. A new `updatedAt` field always reflects the latest action.
- `emailRecipients` **accumulates** every distinct address this report has ever been
  emailed to (deduped), rather than the latest send overwriting the list — "resent to 3
  different people" now means the entry shows all 3, not just the last one.
- `emailSent` is sticky-true: once a work order's report has been emailed, it stays
  `true` even if a later action on the same work order is a Share or Download.
- Everything else (`reportType`, findings/repairs summaries, warranty, pins, CompanyCam
  refs) is a plain snapshot of the most recent action — matches how a technician would
  expect "the current state of this report" to read, and avoids inventing a full
  per-field audit history that wasn't asked for.

**Cleanup log (2026-07-09)** — Mark approved cleaning up the 2 affected work orders.
Client-side `create`/`update` on `reports`/`building_history_events` is allowed by
`firestore.rules`; `delete` is not (`allow delete: if false` for every client) — the only
sanctioned delete path is the admin-PIN-gated `delete_history_event` action in
`netlify/functions/admin.js`. I could not verify/use the admin PIN myself (correctly
blocked, and did not attempt to route around it), so the cleanup was split into a safe
part I could do directly, and a manual part left for Mark:

- **wo_1783623513874 ("Planet fitness")** — read all 4 duplicate docs, computed the
  merge (union of `emailRecipients`, earliest `createdAt`, latest `updatedAt`,
  `emailSent` true since at least one send occurred), and wrote it to the canonical id
  `evt_wo_1783623513874` in both `reports` and `building_history_events`. Merged
  recipients: `charlottew@watkinsroofing.net`, `MarkE@watkinsroofing.net`,
  `Chrisg@Watkinsroofing.net`. The 4 old docs were left in place (not deleted) — **Mark
  needs to delete these 4 old ids** via Admin mode → Building History → that building →
  View Timeline → Delete (admin): `5PPAV7KhSHadDdcUPRW2`, `7YYtjwFHvHycIZTwlIOD`,
  `V4obeTd5WY62Vy1SEyMr`, `iqSgMjoJOIXx7c3dOs48`. Do **not** delete
  `evt_wo_1783623513874` — that's the merged survivor.
- **wo_1783627175735 ("St. Mary's Hospital - St. Louis")** — originally had 3 duplicate
  docs. Two of them (`n7bfUGjxDK6BF3eRicTv`, `vrta02ezozxxKYf1avjt`) were deleted
  (apparently manually, via the app's own Delete (admin) button, mid-cleanup) before I
  wrote the merge, leaving only `UsZ7RmCZ7rsWBdjwb8gr`. Its data was written to the
  canonical id `evt_wo_1783627175735` in both collections — recipients:
  `charlottew@watkinsroofing.net`, `MarkE@watkinsroofing.net`. (`Chrisg@watkinsroofing.net`,
  if it was ever on one of the 2 already-deleted docs, is no longer recoverable — that
  data was gone before the merge ran. The email itself was already sent at the time;
  this only affects the historical "who was this emailed to" record.) **Mark needs to
  delete this 1 remaining old id**: `UsZ7RmCZ7rsWBdjwb8gr`. Do **not** delete
  `evt_wo_1783627175735`.
- Verified read-only afterward: both canonical docs exist in `reports` and
  `building_history_events` with the expected merged `emailRecipients`. Once Mark deletes
  the old ids listed above, both work orders will have exactly 1 entry each, matching the
  other 3 unaffected work orders. No data was lost except the one recipient noted above,
  which was already gone before this cleanup touched anything.

**Follow-up: `reports`-only orphans (2026-07-09)** — a broader read-only sweep of the
`reports` collection (prompted by checking whether the Reports tab had the same
duplication) found a third, separate case: **wo_1783535195243 ("Westminster")** had 3
`reports` docs but only 1 `building_history_events` doc — 2 of its `reports` docs
(`RP2XlBAODDwetYLOmcee`, `ePEKp4cEhbq1OEv2Anty`) had no matching timeline entry at all,
so they weren't reachable from Building History's "Delete (admin)" and the Reports tab
has no delete control of its own — genuinely stuck data, unrelated to the two work
orders above. Mark explicitly authorized deleting exactly those 2 doc ids and provided
the admin PIN for that one operation. Re-confirmed read-only immediately beforehand that
both were the Westminster orphans with no paired timeline entry, deleted both via
`delete_history_event`, then verified read-only afterward: both ids no longer exist,
Westminster now has exactly 1 `reports` doc and 1 `building_history_events` doc (same id,
`QHfSr0GyrCLnGnOtlf0W`), and every other work order's `reports`/`building_history_events`
counts are unchanged (Planet fitness still 5/5, St. Mary's still 2/2, the other two
singles still 1/1 — nothing else was touched).

**Cleanup completed (2026-07-09)** — Mark finished the cleanup himself and authorized
deleting the remaining old duplicate ids for the 2 originally-affected work orders.
Re-confirmed read-only beforehand that each id was an old duplicate for the right work
order (not one of the canonical `evt_` docs), then deleted via `delete_history_event`:
- Planet fitness (`wo_1783623513874`): `5PPAV7KhSHadDdcUPRW2`, `7YYtjwFHvHycIZTwlIOD`,
  `V4obeTd5WY62Vy1SEyMr`, `iqSgMjoJOIXx7c3dOs48`.
- St. Mary's (`wo_1783627175735`): `UsZ7RmCZ7rsWBdjwb8gr`.

Verified read-only afterward: all 5 ids no longer exist in either collection; the
canonical `evt_wo_1783623513874` and `evt_wo_1783627175735` docs remain, with their
merged recipients intact. Full-collection sweep confirms **all 5 work orders now have
exactly 1 `reports` doc and 1 `building_history_events` doc each** (10 total docs across
both collections, one pair per work order) — the duplicate-timeline issue is fully
cleaned up in production, with the forward fix preventing recurrence.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**: first save+send for a work order creates exactly one entry; a resend to 2
more recipients + a reshare + a resave all against the *same* work order still leaves
exactly one entry, with `emailRecipients` correctly grown to all 3 addresses,
`emailSent` staying `true` after a non-email action, `createdAt` unchanged across all 4
calls, and `updatedAt` advancing each time; a different work order gets its own,
separate single entry, confirming no cross-contamination between work orders. Zero
console errors.

### Multiple roofs per building, part 1: data model (shipped 2026-07-10)

**The goal**: move from "a building has one roof" to "a building has one or more
roofs," each with its own roof system, base map, permanent assets, and outlines — the
foundational data-model step toward the full RoofOps vision (see the gap analysis
delivered 2026-07-09). This is the highest-risk item so far this project: dev and
production share one live Firestore, and production's code only ever reads the old
singular building fields — so this had to be additive and backward-compatible from the
first commit, never a big migration.

**Schema**: a new `roofs[]` array field directly on the `buildings` doc (not a
subcollection — no `firestore.rules` changes needed, and every existing read site
already fetches the building doc once). Each roof carries what used to be
building-level fields: `id`, `label`, `roofSystem`, `roof_base_map_type/url/bounds`,
`roof_assets[]`, `roof_outlines[]`. Full shape and rationale in `DATA_MODEL.md`
("Multi-roof backward compatibility").

**Backward compatibility mechanism** — two adapter functions in `index.html`:
- `getBuildingRoofs(bld)` — pure read-time function, never writes. A building with a
  real `roofs[]` array uses it as-is; any other building (untouched by this feature, or
  brand new) gets one virtual roof synthesized from its existing legacy fields, `id:
  "roof_default"`, `label: "Roof 1"`. Every existing building, unless someone
  deliberately adds a second roof, renders identically to before this shipped.
- `saveBuildingRoofs(buildingId, roofs)` — always writes `roofs[]`, and additionally
  mirrors `roofs[0]` back onto the legacy singular fields whenever a building still has
  exactly one roof — so production (which only reads those legacy fields) keeps seeing
  correct data for every still-single-roof building. Once a building gets a second real
  roof, the legacy fields stop updating for that building specifically — an accepted,
  called-out limit, not an oversight (flagged to Mark before implementation; he
  confirmed proceeding on this basis).

**What shipped in this first increment**:
- The two adapters above, plus `getRoofById(bld, roofId)`.
- `ensureCustomerAndBuilding()` (runs on every work order save) now also syncs
  `roofSystem` into `roofs[0]` whenever a building still has exactly one roof — this is
  what lazily creates a real `roofs[]` array on existing buildings the first time they're
  touched after this ships, with zero visible change.
- `openBuildingHistory()` is roof-scoped: a roof selector (`<select>`) only renders when
  a building has more than one roof; "+ Add Roof" (`promptAddRoof()`) is always
  available and starts a new roof empty (no base map, assets, or outlines). The Roof
  Map, roof assets, and base map all read/write the *selected* roof via the adapters.
- The asset modal (`openAssetModal`/`saveAssetFromModal`/`deleteAssetFromModal`) takes an
  explicit `roofId` and reads/writes that specific roof's `roof_assets[]`.
- RoofMapper's save-to-building (`rmSaveOutlineToBuilding`) was retrofit to go through
  `getBuildingRoofs`/`saveBuildingRoofs` instead of writing `roof_outlines` straight onto
  the building doc — that direct write would have silently stopped working for any
  building that already picked up a real `roofs[]` array (which happens automatically on
  its next work-order save, per the point above), so this was a real bug caught and
  fixed during this same pass, not shipped broken.
- The admin "Roof Base Map" card (`renderBaseMapAdminCard`) is disabled — with an
  explanatory message, not silently — for the whole building once it has more than one
  roof. Reason: `netlify/functions/admin.js`'s `set_building_roof_map` still only writes
  the legacy singular fields, which stop being read once a building has a real
  `roofs[]`; making it roof-aware is a follow-up server-side change, not done here.

**Known follow-up gaps** (documented in `DATA_MODEL.md`, not hidden):
- Work orders/finding pins aren't roof-scoped yet — the Roof Map's pins still show for
  every roof regardless of which one is selected; only the base map/assets/outlines are
  roof-scoped so far.
- The pin modal (`lookupProspectiveBuildingBaseMap`) always targets the building's first
  roof — no roof picker there yet.
- The building picker and Building History's building list still show the legacy
  `roofSystem` field for their one-line summary (display-only, prefill convenience) —
  accurate for single-roof buildings, may go stale for a multi-roof building.
- `admin.js` isn't roof-aware yet (see above) — custom base maps are single-roof-only
  for now.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**: a legacy-shaped mock building (only the old singular fields, no `roofs[]`)
renders through `getBuildingRoofs` as exactly one roof, "Roof 1", with all its existing
assets/outlines/base map intact — confirming zero visual regression for every existing
building. A mock building with a real 2-roof `roofs[]` array renders its roof selector,
switches roofs correctly, and adding assets to one roof doesn't affect the other.
`saveBuildingRoofs` correctly mirrors to legacy fields for a 1-roof building and stops
mirroring once a second roof is added, confirmed by direct reads of the mock store.

### Multiple roofs per building, part 2: pins, work orders, RoofMapper, admin base map (shipped 2026-07-10)

**Goal**: finish what part 1 left as known gaps — finding pins, work orders, RoofMapper's
outline save, and the admin base-map card all needed to become roof-aware, not just the
Building History browsing UI. Same rules as part 1: additive, backward-compatible,
mock-tested only, no production writes, `main` untouched.

**Work orders now record which roof they're for.** A new `roofId` field on the work
order object (`currentRoofId` module-level state in `index.html`, wired through
`collect()`/`fill()` exactly like `ccLinkedProjectId`). One work order's findings/pins
all share the SAME roof — a tech visits one roof per job, not several at once — so this
is one field per work order, not one per finding. Default (`null`/omitted) means "the
building's first roof," so every existing work order and every still-single-roof
building behaves identically to before this shipped; verified a legacy work order with
no `roofId` at all still resolves correctly.

**Pin modal is roof-scoped.** A new `lookupProspectiveBuildingRoofInfo()` (shared by the
base-map lookup and the new picker) resolves the current work order's prospective
building and its full `roofs[]`. `openPinModal()` now calls a new
`renderPinRoofPicker()` first: if the building has more than one roof, a small "Roof"
dropdown appears above the map (in a `#pin-roof-picker` container added to the pin
modal's markup); picking one sets `currentRoofId` and reopens the modal so the map
reflects that roof's base map. A single-roof building never sees this picker at all —
`renderPinRoofPicker()` clears the container and returns immediately. Verified: picking
a roof correctly changes which custom base map loads, and a pin placed while a
non-default roof is selected saves with that roof's id.

**Pins carry `roofId`, and the Roof Map filters by it.** `buildPinsForHistoryEvent()`
tags every pin with the work order's `roofId` (defaulting to `"roof_default"` for a
pin/work order predating this field — always the correct id for a building's first/only
roof, per the same convention as part 1). `logReportAndHistoryEvent()`'s payload also
carries `roofId` at the event level. `openBuildingHistory()`'s pin aggregation now
filters `allPins` by `(p.roofId || "roof_default") === historySelectedRoofId` — closing
the gap flagged in part 1 where every pin showed regardless of which roof was selected.
For a single-roof building, `historySelectedRoofId` is always `"roof_default"` and every
pin (tagged or untagged) matches, so this is a no-op there — verified with a mock
3-event building (one `roof_default` pin, one `roof_east` pin, one untagged legacy pin):
selecting Roof 1 shows 2 pins (the roof_default one + the legacy one), selecting East
Wing shows 1 (only its own), switching back shows 2 again.

**RoofMapper's save-to-building targets the selected roof.** `rmBpRender()`'s "Save
Here" button now calls a new `rmChooseBuildingForSave(buildingId)` instead of saving
directly: for a single-roof building (the common case) it saves immediately, zero extra
tap, identical to before. For a multi-roof building, it renders a small roof picker
(`#rm-roof-picker`, added to the save modal's markup) before saving.
`rmSaveOutlineToBuilding(buildingId, roofId)` now takes the target roof id, defaulting
to the first roof when omitted (new-building-creation path). Verified: saving to a
specific non-first roof only adds the outline to that roof's `roof_outlines`, leaving
others untouched; the single-roof path still writes with zero friction.

**Admin base-map upload/clear is roof-aware again**, closing the gap from part 1 where
it was disabled outright for any building with more than one roof.
`netlify/functions/admin.js`'s `set_building_roof_map` action gained an optional
`roofId` param — omitted (every call before this change) targets the first roof, exactly
as before; passed, it targets that specific `roofs[]` entry instead. Mirrors the same
dual-write rule as the client's `saveBuildingRoofs()`: still writes the legacy singular
fields too whenever the building has exactly one roof, so production keeps working
unmodified for the common case. `renderBaseMapAdminCard()` no longer disables itself for
multi-roof buildings; `uploadRoofBaseMap`/`clearRoofBaseMap` now pass the currently
selected roof's id through. **Not tested against the real deployed function or the admin
PIN** (per the standing rule not to use the PIN against production) — verified instead
by copying the exact same algorithm into a standalone script and running it against a
plain-JS mock store (4 scenarios: single-roof dual-write, multi-roof targeting a
specific roof, omitted-roofId defaulting to the first roof, and clearing) — all 10
assertions passed. The real admin.js file was cross-checked line-for-line against the
tested copy to confirm they match.

**Also fixed in this pass**: `historySelectRoof()` wasn't returning
`openBuildingHistory()`'s promise, so a caller couldn't reliably await the re-render
after switching roofs — caught via a flaky-looking test result, not a reported bug.

**Known remaining gap**: the building picker and Building History's building list still
show the legacy `roofSystem` field for their one-line summary (display-only, prefill
convenience) — accurate for single-roof buildings, may go stale for a multi-roof
building. Not fixed in this pass; low-stakes since it's just a summary line, not
authoritative data.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)** across all of the above — legacy-shaped and multi-roof buildings, pin
roof-picker rendering and base-map switching, roof-tagged pin round-tripping through
`collect()`/`fill()`, Building History's per-roof pin filtering, RoofMapper's
roof-targeted save (both single- and multi-roof paths), and the admin.js roof-merge
logic (via the standalone mirror script above). Zero console errors throughout.

### Manually logged activities (shipped 2026-07-10)

**Goal**: let a building history timeline entry exist without a generated PDF report
behind it — a service call, a drone flight, a customer phone conversation — directly
serving the core "every activity creates history" mission. Second gap closed from the
2026-07-09 vision gap analysis, building on the multi-roof work.

**Activity types** (`ACTIVITY_TYPES` in `index.html`, easy to extend): Service Call,
Leak Investigation, Repair, Roof Replacement, Warranty Inspection, Drone Flight,
Thermal Scan, Moisture Survey, Customer Conversation, Note/Other.

**How it works**: "+ Log Activity" appears in Building History's Timeline card (both
the empty-timeline and normal cases) — no admin gate, any tech can log one, same
philosophy as roof assets. The modal (`openActivityModal`/`saveActivityFromModal`)
captures: activity type (dropdown), date (defaults to today), technician/author
(optional free text), and notes (free text). It logs to whichever roof is currently
selected on the Building History page (`historySelectedRoofId`, defaulting to the
building's first roof) — a small hint ("Logging for: East Wing") only appears once a
building actually has more than one roof, so a single-roof building's modal stays as
simple as everything else in this app.

**Reused the existing `reportType` field rather than adding a new "activity type"
field** — an activity's type string (e.g. "Drone Flight") is just another value in the
same field PDF actions already use ("PDF Downloaded"/"PDF Emailed"/"PDF Shared"). This
was a deliberate simplification: the timeline and Reports tab's "Report Type" filter
dropdowns (`populateTimelineFilterOptions`/`populateReportsFilterOptions`) already
derive their options dynamically from whatever values actually appear in real data — so
the moment an activity is logged, its type automatically shows up as a filter option on
both pages, with zero filter-code changes needed.

**Deliberately NOT part of the evt_`<workOrderId>` upsert/dedup model.**
`logActivityEvent()` is a new, separate function from `logReportAndHistoryEvent()` — an
activity gets its own random id (`genId("act")`) and is simply inserted, never merged
with another entry. This is intentional per the spec: two activities logged close
together (e.g. a Drone Flight then a Thermal Scan two minutes later) are genuinely two
separate things that happened, unlike a retried Send/Share/Download of the same report,
which should still dedup exactly as before. `isActivity: true`/`false` marks which is
which on every entry going forward (existing report entries retroactively read as
`isActivity: false` once resaved; older entries with no `isActivity` field at all are
implicitly reports too, since activities are new as of this ship).

**Caught and fixed one real bug while building this**: `flagDuplicateEvents()`'s
"possible duplicate" heuristic matched on `workOrderId` — since every activity has
`workOrderId: null`, two unrelated activities of the same type logged within the 5-minute
window would have incorrectly matched each other (`null === null`) and been flagged as
"possible duplicate," which is wrong for genuinely separate logged activities. Fixed by
requiring a truthy `workOrderId` before the comparison runs at all — existing report
entries (always a real `workOrderId`) are completely unaffected; activities can never
false-positive against each other via this heuristic now.

**Written to both `reports` and `building_history_events`** (same pairing convention as
generated reports), so activities show up in the per-building timeline AND the
cross-building Reports tab/its filters — e.g. "every Warranty Inspection logged this
month, across every building" is now a real question the Reports tab can answer.
`admin.js`'s `delete_history_event` (deletes both by shared id) already works unchanged
for cleaning up a mis-logged activity, since it doesn't care what kind of entry it's
deleting.

**Rendering guards**: the warranty-status tag in both the timeline card
(`timelineEventHtml`) and the Reports tab card (`rpReportItemHtml`) was previously
unguarded (`e.warrantyStatus || ""`) — harmless before, since every real report always
had a real warranty status, but would have rendered a visible empty pill for an
activity (which has none). Fixed to only render the tag when non-empty; existing report
entries are unaffected since they always have a non-empty value. Both cards also gained
a guarded `notes` row. The existing `pdfRef` guard (`e.pdfRef && e.pdfRef.url`) already
handled the "no broken PDF link" requirement correctly with zero changes needed.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**: logging an activity on a legacy single-roof building writes correctly to
both collections with `roofId` defaulting to `"roof_default"`; two distinct activities
logged seconds apart are correctly NOT flagged as duplicates; logging to a specific
non-default roof on a multi-roof building (both via direct call and via the full
modal-open → fill → save UI flow) tags the right `roofId` and shows the correct
"Logging for: <roof>" hint; the timeline's "Report Type" filter dropdown picks up new
activity type values from real data with no code changes; rendering both card types
produces no empty warranty pill and no broken PDF link, with notes showing correctly;
and — the most important regression check — the existing report dedup behavior (3 calls
to `logReportAndHistoryEvent` for one work order still collapsing to exactly 1 entry,
with correctly merged recipients) is completely unaffected, confirming this feature is
fully additive. Zero console errors throughout.

### Admin roof-profile fields (shipped 2026-07-10)

**Goal**: give each roof a permanent, admin-editable profile — age/install date, health
score, condition, warranty, manufacturer, deck/insulation type, drainage notes,
customer contacts, internal notes, replacement history, estimated remaining life.
Third gap closed from the 2026-07-09 vision gap analysis, building directly on the
multi-roof work — every field lives on the roof it describes, not the building.

**Fields** (`roof.profile`, full shape in `DATA_MODEL.md`): install date, estimated age
(years), health score (0-100), condition (dropdown: Excellent/Good/Fair/Poor/Critical),
manufacturer, deck type, insulation type, warranty provider, warranty expiration,
warranty status (dropdown: Active/Expired/Unknown), drainage notes, customer contacts,
internal notes, replacement history, estimated remaining life (years). Roof system
itself is NOT duplicated under `profile` — the Roof Profile card edits the existing
top-level `roof.roofSystem` field directly, reconciling with rather than replacing it.
`ROOF_PROFILE_FIELDS`/`ROOF_CONDITION_OPTIONS`/`ROOF_WARRANTY_STATUS_OPTIONS` in
`index.html` make the list easy to extend later.

**Where it lives**: a new "Roof Profile" card in Building History, scoped to whichever
roof is currently selected (same pattern as the Roof Map and base-map cards) — sits
between the base-map admin card and the Roof Map. Visible to everyone, always; every
field falls back to a muted "Not set" so a roof with no profile yet (all of them, until
an admin fills one in) renders cleanly, never blank or broken. Reads are a plain client
Firestore read, same as every other roof field — no admin gate on viewing.

**Editing is admin-only, and — the key design decision — routes through
`netlify/functions/admin.js` rather than a direct client write**, even though
`firestore.rules` already permits client updates to `buildings`. This matches the
existing custom base-map precedent (`set_building_roof_map`) rather than the looser
roof-assets precedent (any tech, no gate): a roof's age/warranty/condition are
consequential, shared, building-wide facts worth a server-enforced gate, not
quick field-day data entry. The new `set_roof_profile` action:
- Takes `buildingId`, an optional `roofId` (omitted = first roof, same convention as
  `set_building_roof_map`), a `profile` object, and an optional `roofSystem` string.
- **Allow-lists profile field names server-side** before writing — an arbitrary client
  payload can't add unexpected keys to a roof, even though the whole action is already
  PIN-gated.
- Writes `profile` only into the matching `roofs[]` entry — there's no legacy
  building-level equivalent to mirror it into (production's old code never had a notion
  of a roof profile at all, so nothing there could ever read it regardless of where
  it's stored). `roofSystem`, which predates `roofs[]`, still gets the usual
  single-roof-only mirror to the legacy field for production parity, exactly like
  `set_building_roof_map` already does.
- **Not tested against the real deployed function or the admin PIN** (per the standing
  rule) — verified by copying the exact algorithm into a standalone script and running
  it against a plain-JS mock store (single-roof dual-write, multi-roof targeting a
  specific roof without touching others, and allow-list stripping of an injected
  unexpected field) — all 9 assertions passed, and the real `admin.js` file was
  cross-checked line-for-line against the tested copy.

**Quick fact surfaced where it's cheap**: the roof picker's `<option>` labels append
the roof's condition when set (e.g. "East Wing — Critical"), so a tech scanning the
dropdown sees roof health at a glance without opening the profile card — the only
"nicety" built per the spec's "don't over-scope" guidance.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**, covering the full UI path (not just the underlying functions): a
non-admin sees the profile card with "Not set" everywhere and no Edit button, and
`openRoofProfileModal` refuses to open at all without admin mode; an admin sees an
Edit Profile button, and the full modal-open → prefill → edit → save →
re-render round-trip correctly updates the card (condition, manufacturer, health
score, warranty status, internal notes, and roof system all verified). On a multi-roof
building, editing one specific roof's profile leaves the other roof's profile
completely untouched (confirmed via direct mock-store reads, not just HTML string
matching, since the roof picker itself shows every roof's condition — a crude string
check false-failed here before a more precise read confirmed the isolation was
correct), and the legacy `roofSystem` field correctly stays unmirrored once a building
has two real roofs, matching the established dual-write-stops-at-two-roofs rule. A
building with both a real report entry and a manually logged activity, plus the new
profile card, all rendered together with no regressions. Zero console errors
throughout.

### Old map visible behind a modal's placement map on mobile (fixed 2026-07-10)

**Symptom (reported by Mark)**: opening a map to place something — "+ Add Roof
Feature," a finding pin, RoofMapper's save flow — showed the new placement map, but
the OLD map underneath (Building History's Roof Map, or whatever the background page
was showing) stayed visible "in the way," as if two maps were overlapping and
interfering with placing the new item. Reported after the multi-roof/activity/profile
work, suspected regression.

**Investigation**: reproduced against a mock Firestore at a mobile (375×812) viewport.
Direct DOM inspection (`elementsFromPoint` at the new map's coordinates) showed the
z-index stacking was actually correct — the modal's own map sat on top, with Building
History's card properly stacked behind it via the modal's `position:fixed;z-index:40`.
So this was never a Leaflet z-index/stacking-context bug, and no duplicate/orphaned
Leaflet map instance was found either (`renderBuildingMap()`'s existing
`if(buildingMap){buildingMap.remove();...}` cleanup was already correct).

**Root cause**: every full-screen modal in the app (pin, asset, activity, roof
profile, RoofMapper's save-to-building, the building picker) is a dimmed
(`rgba(0,0,0,.55)`, not opaque) `position:fixed` overlay — by design, so the page
doesn't feel like it vanished. But **nothing ever locked the page behind it from
scrolling** — checked the full git history, this was never implemented for any modal,
in this app's entire history. `position:fixed` only affects the modal's own layout; it
does nothing to stop the `<body>` behind it from still responding to touch-scroll. On
mobile, a touch near the modal's edges (or even a slightly imprecise tap while trying
to place a pin) could scroll the page underneath, and since the backdrop is only 55%
opaque, that moving background — including its own Roof Map — stayed visibly, and
confusingly, present through the dim overlay.

This bug always existed, but became far more likely to actually trigger now: the new
Roof Profile card (previous entry above) added significant height above the Roof Map,
making the background page much taller/more scrollable than before, and
`openBuildingHistory()` now re-renders far more often (every roof switch, asset save,
activity log, and profile save all trigger a full re-render) — more opportunities for
the background to visibly shift while a modal happens to be open on top of it.

**Fix**: `lockBodyScroll()`/`unlockBodyScroll()` (reference-counted, not a plain
boolean, so one modal's close can't prematurely re-enable scrolling if another modal
is — or ever becomes — open at the same time) set `document.body.style.overflow` and
are called from every full-screen modal's open/close pair: `openPinModal`/
`closePinModal`, `openAssetModal`/`closeAssetModal`, `openActivityModal`/
`closeActivityModal`, `openRoofProfileModal`/`closeRoofProfileModal`,
`openRmSaveModal`/`closeRmSaveModal`, `openBuildingPicker`/`closeBuildingPicker`.
One wrinkle handled specifically: `pinSelectRoof()` reopens the pin modal (to redraw
for a different roof's base map) *without* closing it first, so `openPinModal()`
only locks if the modal wasn't already displayed — otherwise switching roofs twice
in the pin modal would have locked twice but only unlocked once, leaving scroll
stuck locked after closing.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**, mobile viewport: every modal listed above correctly sets
`document.body.style.overflow` to `"hidden"` on open and back to `""` on close, with
the lock counter confirmed balanced (including the pin-modal roof-switch-without-close
case, checked by switching roofs twice in a row and confirming the counter never
exceeds 1 and returns to 0 on close). Confirmed no regression to actual placement:
saving a roof asset through the modal after this change still writes the correct
type/label/coordinates. Zero console errors throughout.

**Follow-up (2026-07-10, same day) — Mark confirmed the scroll-lock fix above wasn't
enough for "+ Add Roof Feature" specifically**: the underlying Building History roof
map was still visibly showing through the asset-placement modal. Re-investigated with
Mark's narrower repro. Direct DOM inspection (`elementsFromPoint` at the new map's
exact coordinates, mobile viewport) confirmed the z-index stacking was correct — the
scroll-lock genuinely wasn't the (whole) story here.

**Real root cause**: Leaflet's tile panes use `transform: translate3d(...)` heavily
for pan/zoom. On some mobile browsers, an element using `transform` can end up
compositing on its own GPU layer that renders *above* a `position:fixed` ancestor
despite a lower z-index — a known Leaflet/mobile-Safari stacking-context quirk. The
underlying `buildingMap` (Building History's Roof Map, sitting directly behind the
asset modal) is exactly this kind of element, so its compositing layer could bleed
through the modal's backdrop regardless of correct z-index math. This is a real
mobile-rendering behavior, not something a desktop-Chrome DOM inspection alone would
necessarily catch.

**Fix**: rather than trying to out-z-index a GPU-compositing quirk, `openAssetModal()`
now destroys the underlying map outright (`buildingMap.remove(); buildingMap = null`)
the moment the modal opens — no compositing layer left to bleed through at all, not
just a z-index fix. `closeAssetModal()` was restructured to always call
`openBuildingHistory(buildingId)` itself (captured before the modal's state is reset)
regardless of *how* the modal closes — Save, Delete, Cancel, the header Close button,
or tapping the dimmed backdrop — so the roof map is reliably rebuilt every time, not
just after a successful save. `saveAssetFromModal()`/`deleteAssetFromModal()`'s
previously-separate `openBuildingHistory(buildingId)` calls were removed as redundant
now that `closeAssetModal()` always does it.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**, mobile viewport: confirmed `buildingMap` is `null` (fully destroyed, not
just hidden) the moment the asset modal opens, and the `elementsFromPoint` stack at
the new map's coordinates is clean; confirmed the Cancel/Close path (no save) still
correctly rebuilds the roof map (previously would have been a real regression risk
introduced by only handling the save path); confirmed the Save path still works end
to end (asset written with correct type/label/coordinates, map rebuilds after); ran
several rapid open/close cycles with no orphaned Leaflet instances, no "already
initialized" errors, and `scrollLockCount` returning to 0 every time; confirmed the
(untouched) pin modal still opens/closes/locks scroll correctly, unaffected by this
change. Zero console errors throughout. The pin modal shares the same
transform-compositing risk in principle (same kind of map, same kind of fixed modal on
top) but wasn't touched in this pass, per Mark's explicit "focus the fix" instruction
for the roof-asset flow specifically — worth applying the same pattern there if he
reports it's affected too.

### Modal-behind-the-map — the real, universal root cause (fixed 2026-07-10)

**Mark's sharper report**: the "old map in the way" bug wasn't limited to "+ Add Roof
Feature" — editing the Roof Profile showed the popup window rendering *behind* the
Building History roof map/pins. That ruled out the transform-compositing theory above
as the *whole* story (the roof profile modal has no map of its own, and I hadn't
applied the "destroy the underlying map" workaround there) and pointed at something
simpler and more universal.

**Actual root cause**: every modal overlay in the app (`pin-modal`, `asset-modal`,
`activity-modal`, `profile-modal`, `rm-save-modal`, `bp-modal`, `cc-modal`) used
`z-index:40`. Leaflet's own internal panes/controls use z-index values from 200
(tiles) up through 600 (markers), 700 (popups), and 1000 (zoom controls/attribution) —
and Leaflet's `.leaflet-container` is only `position:relative` with no explicit
z-index of its own, which means it does **not** establish a containing stacking
context. Per the CSS stacking spec, that lets its high-z-index internal panes escape
upward into whatever the nearest actual stacking-context ancestor is — which, walking
up from `#building-map` through `.card` → `#history-detail` → `#view-history` →
`.wrap` → `body`, is effectively the document root, the same context the `position:
fixed` modal itself is placed into. Once both are competing in that same shared
context, plain ascending z-index order applies: 200/600/700/1000 (Leaflet) is greater
than 40 (the modal), so Leaflet's tiles/markers/popups/controls legitimately painted
*above* the modal — a real, spec-correct, browser-independent CSS outcome, not a
mobile-only rendering quirk. This fully explains both reports with one mechanism.

**Fix**: bumped every modal's z-index from `40` to `9999` — comfortably above
Leaflet's highest internal value (1000) — in one pass across all 7 modal overlays.
Left the earlier "destroy `buildingMap` while `asset-modal` is open" workaround in
place too (harmless, and a reasonable extra defense layer for any remaining
mobile-specific compositing edge case), but it's no longer load-bearing — the pin
modal, which never got that workaround, is confirmed fixed by the z-index change
alone.

**Verified against an in-memory mock Firestore client (never touched real production
Firestore)**, mobile viewport, on a building with a real map and a visible pin:
scrolled the page so the pin was on-screen, then opened the Roof Profile modal and
confirmed via `elementFromPoint` at the *exact* former pin-marker pixel that a modal
form field is now on top (previously would have been the map/pin). Repeated the same
check for the asset modal (still correct) and, critically, the **pin modal** — which
never had the buildingMap-destroying workaround — confirming the z-index fix alone is
suf­ficient and is the true general-purpose fix. Zero console errors throughout.

### Admin base-map empty state was confusing for a non-developer (fixed 2026-07-10)

**Problem (reported by Mark, with a screenshot)**: the "Roof Base Map (admin)" card's
empty state led with the raw building ID and a `tools/geotiff_to_webmap.py --upload`
CLI reference — before explaining what a base map even is, and even though that CLI
tool is only ever needed for ONE of the two supported base map paths (Drone
Orthomosaic). Roof Plan and Sketch have always been a plain in-app image upload with
no external tool required at all — the old copy didn't make that distinction, so it
read as if every base map needed the Python script.

**Fix** (`renderBaseMapAdminCard()`, `toggleBaseMapBoundsFields()`) — no functional
change, no new backend action, purely clearer copy and reordering:
- Leads with a plain-language explanation: pins default to a live satellite photo;
  a custom base map replaces that with your own image, useful when satellite detail
  isn't good enough.
- The Type dropdown's own option labels now say which path is which: "Roof Plan —
  upload an image, ready to use," "Sketch — upload an image, ready to use," "Drone
  Orthomosaic — needs an extra step first, see below."
- Selecting Roof Plan/Sketch shows a short "just upload the image, no extra tools
  needed" hint. Selecting Drone Orthomosaic swaps to an explanation of *why* that one
  needs the companion script, then the CLI/building-ID/bounds-paste instructions —
  previously always shown regardless of which type was even selected.
- The "no CompanyCam project linked yet" state now explains *why* (the image is
  stored as a CompanyCam document, same as generated PDF reports) and exactly what to
  do (import photos from any work order for the building) instead of a bare
  instruction with no reasoning.

**Verified against an in-memory mock Firestore client**: confirmed the empty state no
longer shows any CLI/geotiff text up front; confirmed the CompanyCam-project-required
explanation states the reason; confirmed the type-select toggle correctly swaps
between the "simple upload" hint and the drone/CLI instructions in both directions;
confirmed the already-has-a-base-map state (unchanged functionality) still renders
correctly. Zero console errors.

### CompanyCam project names with apostrophes couldn't be opened (fixed 2026-07-10)

**Symptom (reported by Mark)**: tapping the "St. Mary's Hospital" folder in Import
from CompanyCam did nothing — every other project opened fine.

**Root cause, confirmed exactly as hypothesized**: `ccLoadProjects()` built each
project's folder button as `onclick="ccOpenProject('<id>', '<name>')"`, with the name
run through `esc()` (HTML-escaping, so `'` → `&#39;`) plus a redundant second
`.replace(/'/g, "&#39;")` that no longer had anything left to match. The bug: an
`onclick="..."` attribute's value is HTML-*decoded* by the browser before being
handed to the JS parser as the inline handler's source — so `&#39;` decodes right back
to a literal `'` at exactly the point it's read as JavaScript, not the point it's read
as HTML. For "St. Mary's Hospital," that produced effective JS source
`ccOpenProject('54362584', 'St. Mary's Hospital...')` — the apostrophe in "Mary's"
closes the second string literal early, leaving trailing garbage after it. The inline
handler fails to parse at all, so the tap does silently nothing. Any project without
an apostrophe/quote in its name never hit this, which is why it looked like only one
folder was broken.

Grepped for the same anti-pattern (a name manually `.replace(/'/g, ...)`'d before
being dropped into an inline `onclick`) and found one more, identical case:
`deleteBuildingAdmin`'s button in the Building History list, one line away from the
building-picker code fixed under "Multiple roofs per building." Fixed both in the same
pass.

**Fix — stopped interpolating names into `onclick="..."` at all**, rather than trying
to find the "correct" escaping (there isn't a clean one for HTML-attribute-then-JS
double-decoding without resorting to something like `JSON.stringify` + further
escaping, which is exactly the kind of fragile approach worth avoiding):
- `ccLoadProjects()` now caches the loaded list in `ccProjectsCache` and renders each
  button as `onclick="ccOpenProjectAt(<index>)"` — a plain integer, never
  user-controlled data. `ccOpenProjectAt(i)` looks the real project object back up
  from the cache and calls `ccOpenProject(p.id, p.name)` with the actual, unescaped
  values as real JS arguments (not string-interpolated at all).
- `deleteBuildingAdmin`'s button now passes only `b.id`; the function looks the
  building's name up from `lastBuildingList` (already cached by `renderHistoryList()`)
  instead of receiving it as a parameter.
- The *displayed* text (`<b>` + `esc(p.name)`) was always fine and is unchanged — this
  was only ever about the `onclick` attribute specifically.

**Verified against a mocked `ccApi`/`callAdminApi`** (never touched real CompanyCam or
production Firestore): rendered a project list including `id: "54362584", name: "St.
Mary's Hospital - St. Louis"` and confirmed the rendered HTML has no raw name in any
`onclick` attribute at all; called the resulting `onclick` handler directly and
confirmed the project actually opens (`ccProjId` set correctly, title set correctly,
photos loaded into the grid) — previously this exact case would have failed to parse.
Spot-checked a normal project name (still works) and a deliberately hostile one
(`Bob's "Best" Roofing & Sons` — apostrophe, double quotes, and an ampersand together)
— displays and opens correctly. Confirmed `deleteBuildingAdmin` with an
apostrophe-containing building name now shows the correct confirm-dialog text with no
broken handler. Zero console errors throughout.

### Photo reorder + enlarge (shipped 2026-07-10)

**Goal (from Mark)**: let a tech rearrange a work order's uploaded photos, with the
new order flowing into the generated PDF, and let tapping a thumbnail open it
enlarged. Both had to work for device-uploaded and CompanyCam-imported photos alike —
true by construction, since `addPhotosFromFiles()` and `ccImport()`/`ccCompress()`
both push the exact same shape (`{caption, img, w, h, finding_id}`, +`ccPhotoId`/`gps`
for CompanyCam) into the same `photos[]` array, rendered by the same `renderPhotos()`.

**Reorder**: `movePhoto(i, dir)` swaps `photos[i]` with its neighbor and re-renders.
Whole photo objects swap together, so caption/finding/`ccPhotoId` never get separated
from their image. New ▲/▼ buttons per photo card are the primary control — tap-to-move
was prioritized over drag-and-drop per Mark's explicit direction, since HTML5
drag-and-drop is unreliable on iOS touch. Buttons disable at the top/bottom of the
list rather than silently no-oping. Desktop drag-and-drop (`draggable="true"` +
`dragstart`/`dragover`/`drop`) was added as the requested "bonus" — splices the
dragged photo to its drop position — but is a pure addition on top of the tap
buttons, not a replacement; touch browsers that don't fire native HTML5 DnD events
just never trigger it, leaving ▲/▼ as the only path there, exactly as intended.

**Nothing downstream needed to change for the reorder to reach the PDF** —
`buildText()`, the PDF builder, and `filledPhotos()` (used by both) all already just
iterate the `photos[]` array in whatever order it's in. A reorder in the form *is* a
reorder in the report, automatically.

**Enlarge**: a new `#photo-lightbox` overlay (`position:fixed;inset:0;z-index:10000` —
intentionally above the `9999` every other modal uses now, since this needed to sit
above literally everything per the spec, including the reorder controls). Tapping a
thumbnail (`onclick="openPhotoLightbox(i)"` on the `<img class="thumb">` element
specifically, not the row) shows that photo full-size; tapping the dark backdrop or
the **✕ Close** button dismisses it (backdrop check is `event.target===this`, same
pattern as every other modal in the app, so tapping the enlarged image itself doesn't
close it). Reuses the existing `lockBodyScroll()`/`unlockBodyScroll()` from "Modal
z-index bug" above, so the page behind can't shift underneath it either.

**No conflict between enlarge and the move/delete/caption controls, by construction**
rather than by event-handling trickery: the thumbnail's click handler is on the `<img>`
element alone; the ▲/▼ buttons, ✕ delete button, and caption input are separate
sibling elements in the same row, so a tap on any of them never touches the image at
all — no bubbling, no `stopPropagation()` needed.

**Verified against seeded photo data at a mobile (375×812) viewport** (no production
writes — this feature has no Firestore/network dimension to it at all, purely
client-side form state): `movePhoto()` correctly swaps caption+image+`ccPhotoId`
together and updates the disabled states on the boundary buttons; `collect()`'s
`o.photos` and `filledPhotos()` both reflect the new order immediately after a move;
the desktop drag-and-drop functions (`photoDragStart`/`photoDrop`) correctly reorder
too; the lightbox opens with the right image, sits above everything (`elementFromPoint`
confirmed it's the topmost element, above the surrounding form), closes on a backdrop
tap but *not* on a tap on the image itself, and correctly locks/unlocks body scroll;
clicking the move/delete buttons and editing the caption input all work normally and
never open the lightbox. `.photo-row` gained `flex-wrap:wrap` so the two new ▲/▼
buttons don't cram the row on a narrow phone screen — confirmed the row wraps to
multiple lines at 375px width rather than squeezing the caption input unusably
narrow. Zero console errors throughout.

### Work order type (shipped 2026-07-10)

**Goal (from Mark)**: let a work order be tagged with a type — Leak/Service (today's
only implicit type), Change Order, Inspection, Repair, Warranty — with Change Order
getting extra fields (cost, man-hours, materials, description, PO number, date
completed), the type flowing into the timeline/filters, and into the PDF.

**Types**: `WORK_ORDER_TYPES` in `index.html` — a plain array, easy to extend.
`"Leak / Service"` is first and is the load-bearing default: `collect()`/`fill()` both
explicitly fall back to `WORK_ORDER_TYPES[0]` rather than relying on the `<select>`'s
own default-option behavior, which turned out not to be reliable here — setting a
`<select>`'s `.value` to an unmatched string (e.g. `undefined` coerced to `""` for a
work order saved before this field existed) deselects everything rather than falling
back to the first `<option>`. The explicit fallback is what actually guarantees every
existing work order reads as "Leak / Service" with zero behavior change.

**Change Order fields** (`woCost`, `woManHours`, `woMaterials`, `woDescription`,
`woPONumber`, `woDateCompleted`) are plain entries in `FIELD_IDS`, so they round-trip
through `collect()`/`fill()` exactly like every other simple form field — blank/absent
for every other type, no special handling needed there. The **`#wo-changeorder-card`**
is a plain hidden-by-default card, shown/hidden by `onWoTypeChange()` on the type
select's `onchange` (and re-synced by `fill()` after loading an existing work order,
so a loaded Change Order shows its card immediately, not just after a manual type
change). Cost/Man-Hours are `type="number"` inputs for a better mobile keyboard, but
stored as plain strings like every other field in this app (`serviceDate` isn't
coerced to a real date either) — no new type-handling convention introduced.

**Doesn't touch the roof-scoping or dedup mechanics at all** — `woType` and the
Change Order fields are purely new, additive fields on the work order object and on
`logReportAndHistoryEvent()`'s payload (`workOrderType`, a snapshot of `o.woType`).
The `evt_<workOrderId>` upsert, `roofId`/multi-roof scoping, and the report/activity
split are all unchanged; `workOrderType` just rides along as one more field on the
same payload.

**Timeline/Reports tab**: `workOrderType` is now a full filter dimension, mirrored in
both places exactly like `reportType`/`roofType`/etc. already are —
`populateTimelineFilterOptions`/`filterTimelineEvents`/`timelineFiltersHtml` in
Building History, and the parallel `populateReportsFilterOptions`/`filterReports` +
a new `rp-wotype` field in the Reports tab. Both card renderers
(`timelineEventHtml`/`rpReportItemHtml`) show the type as a chip — but *only* when
it's not the default "Leak / Service," so the timeline/Reports list looks completely
unchanged for the common case; a Change Order (or Inspection/Repair/Warranty) entry
stands out with an amber-tinted chip instead.

**PDF/preview/email text — originally shipped as an added section, since superseded**:
the first version of this feature added a "Change Order Details" section onto the
existing leak-report template in all three output paths. Mark corrected this the same
day — a Change Order needed to be its own distinct document, not a leak report with
extra fields. See "Change Order gets its own PDF template" below for what actually
ships now.

**Verified against a mock Firestore** (no production writes): a fresh work order and
a work order object with no `woType` field at all (simulating existing production
data) both resolve to "Leak / Service" with the Change Order card hidden; switching
the type select correctly shows/hides the card; a full Change Order — cost, man-hours,
materials (multi-line), description, PO number, date completed — round-trips exactly
through `collect()` → `fill()`; `logReportAndHistoryEvent()`'s payload carries the
right `workOrderType` for both a Change Order and a plain work order; the timeline
filter dropdown picks up both types from real data, filtering by "Change Order"
correctly returns only that entry, and the chip shows for Change Order but not for the
default type; `buildText()` and `renderDoc()` both include the type and the full
Change Order Details section; and — generating an actual jsPDF document (not just the
HTML preview) and inspecting its raw page content confirmed "Change Order Details,"
"Work Order Type," and the cost value are genuinely present in the real PDF output,
with the section correctly absent for a plain Leak/Service PDF. Zero console errors
throughout.

### Change Order gets its own PDF template (shipped 2026-07-10, same day correction)

**Correction from Mark**: a Change Order needed to be its own distinct document — a
proper change-order/work-authorization style PDF — not a section added to the leak
report. Built the same day as the type feature above, replacing that first approach.

**Routing, not a rewrite of the leak report**: `generatePdf()` is now a thin router —
`o.woType === "Change Order" ? generateChangeOrderPdf(o) : generateLeakReportPdf(o)`.
`generateLeakReportPdf()` is the original function, renamed, with the Change Order
splice removed — otherwise byte-for-byte the same logic as before this correction, so
the Leak/Service PDF is unaffected. `generateChangeOrderPdf()` is a fully separate,
self-contained jsPDF builder (its own `doc`/`heading()`/`kvTablePdf()`/
`wrappedTextPdf()` closures, matching the leak builder's pattern but never sharing
state with it) with its own layout:
- Logo + a **"CHANGE ORDER"** title in the Watkins brand red (`#B4223F`, extracted from
  the actual logo — see APP_OVERVIEW.md), not the leak report's slate-colored title.
- Job Information: name, address, date, PO number, date completed (no roof
  system/reported leak area — those aren't relevant to a change order).
- **Description of Work Performed** — its own prominent heading, right after Job
  Information, ahead of materials/cost, per spec.
- **Materials** — rendered as an actual itemized list (each non-blank line of the
  textarea becomes its own bulleted line), not a wrapped paragraph.
- **Cost Summary** — Man-Hours and Cost in a compact table, then a separately-drawn
  **Total** row with a filled background and bold/larger text (`doc.rect()` +
  `doc.text()`, not just another table row) so it reads like a real invoice total.
- **Approval/signature**: two actual drawn lines (`doc.line()`) labeled "Approved By"
  and "Date" — a real signature line, not a table row.
- Photos, if any, are a plain grid at the end with no "leak investigation" framing
  text — secondary, per spec.
- No findings table, no warranty determination — those belong to the leak report's
  inspection framing, not a change order.

`renderDoc()` (the on-screen HTML preview) and `buildText()` (the plain-text email
body) got the identical treatment: both are now thin routers to
`renderChangeOrderDoc()`/`buildChangeOrderText()`, matching the PDF's structure and
section order, so what a tech previews on-screen is what actually gets emailed/
downloaded — no mismatch between preview and output. Small new scoped CSS
(`.co-materials`, `.co-cost`, `.co-total`, `.co-sig`) for the HTML preview's itemized
list, total-row emphasis, and signature-line styling — additive, doesn't touch any
existing `.doc` styling used by the leak report. `pdfFileName()` now prefixes
`ChangeOrder_` instead of `WorkOrder_` for that type, and `sendEmailNow()`/`emailDoc()`'s
subject/body text also branch by type.

**Inspection/Repair/Warranty were left on the original leak-report format**, per the
explicit instruction not to over-build — noted here in case Mark decides one of them
should get its own template later (e.g. a Warranty determination letter might
eventually want its own layout the same way Change Order just did).

**Verified against a mock Firestore** (no production writes): generated an actual
jsPDF document for a Change Order and inspected its raw page content — confirmed
"CHANGE ORDER," "DESCRIPTION OF WORK PERFORMED," "MATERIALS," "COST SUMMARY," "TOTAL,"
the cost value, and "Approved By" are all present, and confirmed "ROOF INVESTIGATION
FINDINGS"/"WARRANTY DETERMINATION" are genuinely absent (proving this isn't just the
leak template with headings added). Regenerated a plain Leak/Service PDF afterward and
confirmed it's completely unaffected — same findings/warranty/work-performed sections
as before, no Change Order content, filename correctly reverts to the `WorkOrder_`
prefix. Repeated the same content checks against `renderDoc()`'s HTML output and
`buildText()`'s plain text for both types. Zero console errors throughout.

### Home / launcher screen (shipped 2026-07-10)

**Goal (from Mark, refined through two rounds — a plain type chooser, then upgraded to
an icon-tile launcher)**: instead of dropping straight into a blank Leak/Service form,
the app should first ask "what are you creating?" — big tappable tiles for each work
order type plus a way to jump straight into RoofMapper, without turning into a wall
that blocks getting to the actual form.

**A new `view-home`**, shown by `showView("home")`, is now what the app opens to
(replacing the old `newOrder()` call in the init section) — `view-edit` gained an
explicit `display:none` in its static HTML so there's no flash of the empty form
before Home takes over. **`newOrder()` itself was repurposed**: "+ New" in the header
and "+ New Work Order" in Building History's empty state both already called
`newOrder()`, so changing what that function does (show Home instead of immediately
blanking the form) updated both entry points for free, still behind the same
unsaved-work `hasContent()` confirm guard as before. Tapping the header logo also
returns to Home — a small, standard, low-risk addition.

**Tiles are generated from `WORK_ORDER_TYPES`**, not hardcoded — `renderHomeTiles()`
maps each type through `WORK_ORDER_TYPE_ICONS`/`WORK_ORDER_TYPE_LABELS` (only
"Leak / Service" needs a label override, to "Leak Work Order" — every other type's
tile just uses its own type string), so extending `WORK_ORDER_TYPES` later gets that
new type its own home tile automatically, same "add a string, done" extensibility as
the type selector itself. Three more tiles — RoofMapper, Building History, Reports —
round out the launcher as secondary destinations (styled with a slate border instead
of brand red, to visually separate "start a work order" from "jump to a tab").
`startNewWorkOrder(type)` is the actual entry point a work-order tile calls: creates a
fresh work order pre-set to that type (`fill({ id: ..., woType: type })`) and shows
the Edit view — genuinely equivalent to picking a type from the in-form selector on a
brand-new order, just one tap sooner.

**Editing an existing work order was never routed through Home at all** — `loadOrder()`
already calls `fill(o); showView("edit");` directly, unchanged; Home only sits in front
of the "start something new" entry points, never in front of "open something that
already exists." Switching type mid-form still works exactly as before (the in-form
`#woType` selector and `onWoTypeChange()` weren't touched) — Home is a launcher for
starting new work, not a gate you get routed back through.

**Styled with the actual Watkins brand red** (`#B4223F`, from the logo — see "Logo
location and brand palette" in APP_OVERVIEW.md) for the work-order-type tiles,
deliberately scoped to just this new screen rather than touching the rest of the
app's existing orange/slate palette, per the standing instruction to hold off on a
broader restyle until the dedicated aesthetic pass.

**Verified against a mock Firestore** (no production writes — this feature has no
Firestore dimension, purely client-side navigation state), mobile (375×812) viewport:
fresh page load shows Home with `view-edit` hidden, all 8 tiles present with the
correct icons/labels/order; tapping a work-order-type tile starts a new order with
that exact type, shows Edit, and (for Change Order) shows the Change Order Details
card immediately; tapping the RoofMapper/Building History/Reports tiles correctly
navigates to each; the "+ New" unsaved-work guard correctly blocks navigation on
Cancel and proceeds to Home on Confirm; tapping the header logo returns to Home;
loading/editing an existing work order goes straight to Edit with its saved type,
never touching Home; switching type mid-form still works from an existing order; and
the tile grid confirmed responsive (2-column layout at 375px width, not cramped into
one column or overflowing). Zero console errors throughout.

### RoofMapper: recovering from a wrong GPS fix (shipped 2026-07-10)

**Bug (reported by Mark)**: on desktop, RoofMapper's GPS put him in the wrong location
(desktop geolocation is IP-based and often miles off — expected, not itself a bug). He
panned the map to the actual building, but couldn't tap it — nothing happened.

**Root cause**: RoofMapper only ever renders the building footprints returned by the
*one* Overpass search it ran (around the GPS point) as clickable polygons
(`rmRenderFootprints()`/`rmState.footprintLayers`). Panning the map is just moving the
viewport — Leaflet doesn't fetch or render anything new on its own — so a building the
user pans to, with no footprint search ever run near it, has no clickable shape there
at all. This wasn't a click-handling bug; there was genuinely nothing to click.

**Fix — "🔍 Search This Area"**, the primary/only change shipped: a new button, always
visible once the map is open (same row as "Search Wider"/"Re-locate & Search Again"),
plus a plain-language hint explaining when to use it. `rmSearchThisArea()` reads
`rmState.map.getCenter()` — wherever the user has panned to — writes it into
`rmState.lat`/`rmState.lng` (overwriting the original, possibly-wrong GPS fix), resets
`radiusIndex` to the narrowest step (same as a fresh GPS lock — this is "start over,
but here"), and calls the *exact same* `rmSearchBuildings()` the GPS flow already
uses. Deliberately not a new search path — reusing the existing function means the
existing "no footprints found," "Search Wider," and site-boundary-fallback logic all
apply identically whether the search center came from GPS or from a pan.

**No stale/overlapping polygons**: `rmSearchBuildings()` already calls
`rmClearFootprintLayers()` before rendering new results (needed for "Search Wider" and
"Re-locate" too), so this was already correct by construction — confirmed rather than
newly built.

**Feature #2 (tap anywhere on the map to search that point) — evaluated, deferred, not
built.** Leaflet's vector layers don't bubble their own click events up to the map by
default, so a `map.on("click", ...)` handler technically wouldn't conflict with
tapping an existing footprint to select it — that part would've been clean. What held
it back: every stray tap (scrolling, pinch-zoom overshoot, an accidental touch) would
silently fire a real Overpass request — Overpass is a shared public service with fair
use limits, and an unpredictable "every tap has a network side effect" isn't good
mobile UX either. The explicit button is a deliberate, visible action instead. Worth
revisiting if Mark finds the button alone isn't fast enough in the field.

**Verified with a mocked `rmFetchNearbyBuildings`** (never hit the real Overpass API —
a shared public service, not something to hammer for testing), mobile and desktop
viewports: seeded a "wrong" GPS fix and ran the normal search (renders the wrong
building); panned the map to a different point entirely; tapped Search This Area with
a different mocked result set at the new point — confirmed `rmState.lat`/`lng` updated
to the panned-to center (not the original GPS point), `radiusIndex` reset to 0, the
old footprint was genuinely removed (not just hidden), and the new footprints
rendered; confirmed the newly-rendered footprint is actually selectable
(`rmSelectFootprint` works, shows the correct building info) — proving the original
"can't click on it" bug is fixed, not just that a search ran. Repeated a third
pan-and-research on a desktop viewport to confirm it isn't mobile-specific. Zero
console errors throughout.

### Warranty guidelines reference (shipped 2026-07-10)

**Goal (from Mark, simplified twice from an initial classification-tool build — see
below)**: show techs the warranty-coverage guideline lists right on the work order
form. Explicitly **display-only** — "just guidelines for the techs," no manufacturer
branding, no data capture.

**`WARRANTY_GUIDELINES`** (index.html, right after `onWoTypeChange()`): a plain
object with `warrantable` and `notWarrantable` string arrays (Mark's exact lists —
membrane seam failures, failed factory flashings, etc. vs. foot traffic damage, storm
damage unless covered, normal aging, etc.). Nothing else — no note, no manufacturer
name, no per-item metadata. Editing the guidance is editing these two arrays.

**Display**: a collapsible `<details>` block ("Warranty Guidelines (reference for
techs)", closed by default) on the existing "Warranty Determination" card — present on
every work order type, same as before. `populateWarrantyGuidelines()` renders both
lists into `#warranty-guidelines-body` once at page load (green card for warrantable,
red card for not-warrantable) — plain text, no inputs, nothing to select or save.

**What this replaced**: an earlier same-day build had a "Warranty Assessment Guide"
modal, a per-finding "Warranty Reason" dropdown that auto-set the finding's Warranty
Opinion (and so its map pin color), and an Elevate Licensed Applicator/Amrize
compliance note. Mark corrected this twice — first to drop the modal/classification
UI entirely in favor of an inline list, then to drop the Elevate/Amrize/Red Shield
branding too, since the lists are just informal tech guidelines, not an official
manufacturer program. That version was fully removed (no `warrantyCategory` field, no
modal, no auto-sync) rather than left dormant — the finding row and `warranty` field
are back to exactly what they were before any of this started.

**Verified with mocked state**: reloaded, opened a Leak/Service work order, confirmed
the `<details>` block renders both lists correctly (both headings present, no
Elevate/Amrize/Red Shield text anywhere) and is closed by default; confirmed a new
finding has no extra field (`Object.keys` on a fresh finding is back to
`condition/location/warranty/id/pin`, nothing added); confirmed `collect()` never
produces a `warrantyCategory` key; confirmed no `#warranty-modal` element exists in the
DOM at all — zero console errors throughout.

### Repair work order type (shipped 2026-07-10)

**Goal (from Mark)**: flesh out the Repair work order type — a project/small-project
report (flashing a curb, several curbs and boots) rather than a leak diagnosis. Carries
most of the same info as a Leak/Service work order, minus leak findings, plus a way to
describe the repair scope.

**Form changes** — `onWoTypeChange()` now toggles two more cards based on `woType`:
`#wo-findings-card` (wrapped around the existing Roof Investigation Findings card,
previously unwrapped/always-visible) hides for Repair; a new `#wo-repair-card`
("Repair Scope") shows only for Repair, with a `repairDescription` textarea and an
itemized `repairItems` list (same add/remove/render pattern as `findings`/`repairs`:
`addRepairItem()`/`removeRepairItem()`/`renderRepairItems()`). Each item has a `type`
(dropdown, `REPAIR_ITEM_TYPES` — Curb, Pipe Boot / Flashing, Seam, Vent, Drain,
Scupper, Expansion Joint, Skylight, Roof Hatch, Penetration, Other — worded to match
the existing `ROOF_ASSET_TYPES` vocabulary without being coupled to it; these are
report line items, not map pins), a `qty`, and free-text `notes`. Everything else on
the form — job info, job/work-order number (`jobNo`), technician, roof map context,
Work Performed, Warranty Determination, photos — is completely unaffected; Repair just
reuses those existing, ungated cards. `repairItems` has no forced minimum row (unlike
`findings`/`repairs`) since it's explicitly optional per spec.

**Report/PDF — reused, not separate**: unlike Change Order (its own fully separate
builder, since it's a different kind of document), Repair reuses
`buildLeakReportText()` / `renderLeakReportDoc()` / `generateLeakReportPdf()` — Mark
asked for "most of the same info," not a new template. Each function now checks
`var isRepair = o.woType === "Repair"` once at the top and branches in exactly two
places: the title ("REPAIR / PROJECT REPORT" vs. "LEAK WORK ORDER / REPAIR
DOCUMENTATION") and the findings section, which becomes a "Repair Scope"
section/table (description + the repairItems table) instead of "Roof Investigation
Findings." Every other line (Job Information, Work Performed, Warranty Determination,
Summary, Photo Documentation, footer) is shared, unconditional code — same as before.
`pdfFileName()` gained a third prefix (`Repair_...`) alongside `ChangeOrder_` and
`WorkOrder_`.

**Leak/Service stays byte-for-byte unchanged**: every branch added is gated on
`o.woType === "Repair"` specifically, with the original (non-Repair) code path left
completely untouched in the `else` — confirmed by diffing text/PDF output for a
Leak/Service work order before and after.

**Verified with mocked state**: switched to Repair and confirmed the findings card
hides and the repair card shows (and the reverse for every other type, including
Leak/Service and Change Order — no regression); added repair items and a description,
confirmed they round-trip through `collect()`/`fill()` and survive a simulated
reload; confirmed `buildText()`, `renderDoc()`, and `generateLeakReportPdf()` all show
"Repair / Project Report" / "Repair Scope" / the itemized items table and contain **no**
"Roof Investigation Findings" text anywhere; ran the same three checks for a
Leak/Service work order and confirmed the original title, the findings section, and
`WorkOrder_` filename prefix are all unchanged; ran Change Order and confirmed it's
still routed to its own separate builder, untouched; loaded a legacy-shaped Repair
work order (no `repairItems`/`repairDescription` at all) and confirmed it loads clean
with an empty items list — zero console errors throughout.

### Warranty guidelines restricted to Leak/Service + Manufacturer Service # (shipped 2026-07-10)

**Two refinements from Mark, same commit.**

**1. Warranty guideline lists are leak-only.** The "Warranty Guidelines" `<details>`
reference (see "Warranty guidelines reference" above) was visible on every work order
type's Warranty Determination card. Mark: the lists are "for leaks and leaks only."
Both the `<details>` block and the new Manufacturer Service # field (below) now live
inside a single wrapper, `#wo-leak-warranty-extra`, toggled by `onWoTypeChange()`
alongside the Change Order / Repair cards — visible only when
`val("woType") === WORK_ORDER_TYPES[0]` (i.e. "Leak / Service"). The Warrantable/
Non-Warrantable Repairs textareas underneath stay visible for every type, unchanged —
only the reference list and the new field are leak-gated.

**2. Manufacturer Service # field.** For a warrantable leak, Mark says there's
"~9 times out of 10" also a manufacturer's own work order/service number. New optional
text input, `mfgServiceNo`, inside the same leak-only wrapper. Added to `FIELD_IDS` so
it round-trips through `collect()`/`fill()` like any other simple field — a single
input, no category picker, no pin-sync (explicitly not a repeat of the earlier
over-built warranty classification tool). Included in the Warranty Determination
section of the leak report — text, HTML preview, and PDF — only when filled (same
"skip if empty" behavior as Warrantable/Non-Warrantable Repairs). Since
`buildLeakReportText`/`renderLeakReportDoc`/`generateLeakReportPdf` are shared with
Repair (see "Repair work order type" above), the field is technically present in those
too, but harmlessly always empty there since the form never shows the input for
Repair — confirmed by testing, not just assumed.

**Verified with mocked state**: checked `#wo-leak-warranty-extra`'s visibility across
all five work order types — visible only for Leak/Service, hidden for Repair, Change
Order, Inspection, and Warranty; filled `mfgServiceNo` on a Leak/Service work order,
round-tripped through `collect()`/`fill()`, and confirmed it appears correctly in the
text build, the HTML preview, and the generated PDF; zero console errors throughout.

### CompanyCam PDF upload gaps (fixed 2026-07-10)

**Background**: Mark reported report PDFs missing from CompanyCam for several real
jobs (Planet Fitness, St. Mary's Hospital, St. Joseph's, Westminster). A code-path
investigation (no live CompanyCam/production access from the dev sandbox — see that
diagnosis for the full writeup) found three independent gaps, all fixed here:

**1. "Select Existing Building" never carried over the building's CompanyCam link.**
`bpSelectBuilding()` copied jobName/billTo/location/roofSystem from the building
record but never `b.companyCamProjectId`/`companyCamProjectName` — even though the
picker list shows "🔗 CompanyCam linked" right next to buildings that have one. A work
order for an already-linked building silently stayed unlinked (`o.companyCamProjectId`
null) unless the tech separately used Import from CompanyCam too — the natural
workflow for a repeat customer skips that. Now `bpSelectBuilding()` sets
`ccLinkedProjectId`/`ccLinkedProjectName` from the building record when present (and
calls `renderCCLinkInfo()` so the "🔗 Locked to CompanyCam project" banner appears
immediately) — but only if the work order isn't already linked to something else, so
it never clobbers an explicit Import-from-CompanyCam link made in the same session.

**2. "Download PDF" never attempted a CompanyCam upload at all.** Only "Send Email
Now" and "Share / Email PDF" called `uploadLinkedPdfToCompanyCam()`; `downloadPdf()`
built and saved the PDF locally and stopped there, regardless of linking. Now it calls
`uploadLinkedPdfToCompanyCam()` too, same as Share — matching toast behavior (its own
"Saving to CompanyCam…"/success/failure toasts when linked; the original "attach it to
your email" toast only when not linked, unchanged for that case). `window.print()`
(the Print button) is unchanged — it prints the live HTML preview directly, never
produces PDF bytes app-side, so there's nothing there to upload.

**3. No persistent visibility into whether an upload actually happened.** Even when an
upload was attempted and failed, the only feedback was a one-time toast at that exact
moment — nothing was ever recorded. `logReportAndHistoryEvent()` now takes a 4th
param, `ccUploadResult` (the same `{ok:true}` / `{ok:false,error}` / `{skipped:true}`
shape `uploadLinkedPdfToCompanyCam()` already returned), and writes it as
`companyCamUploadStatus` ("saved" | "failed" | "not_linked" | `null` if never
attempted) + `companyCamUploadError` on both the `reports` and `building_history_events`
docs — sticky like `emailSent`, so an action that doesn't attempt an upload (e.g. a
manually logged activity) preserves whatever was already recorded rather than
overwriting it with "unknown." All four call sites (`downloadPdf`, `sendEmailNow`, and
both branches of `sharePdf`) were reordered so the upload attempt completes *before*
logging, so the very first log entry already reflects the real outcome. Building
History and the Reports tab now show a persistent "☁️ Saved to CompanyCam" (green) or
"⚠️ Not saved to CompanyCam" (red, covers both `failed` and `not_linked` — both mean
the PDF genuinely isn't there) badge via the new shared `ccUploadBadgeHtml()` helper,
plus the actual error text on a `failed` entry. Entries logged before this shipped just
show no badge (status `null`) rather than a misleading one.

**Verified with mocked Firestore + mocked `ccApiPost`** (never touched the real
CompanyCam API or production Firestore): confirmed `bpSelectBuilding()` carries the
link over and doesn't clobber an existing one; ran `downloadPdf()` against a linked
work order with a mocked successful upload and confirmed `companyCamUploadStatus:
"saved"` lands on both the `reports` and `building_history_events` mock docs; reran
with a mocked rejection and confirmed `"failed"` + the exact error message are
recorded; reran unlinked and confirmed `"not_linked"`; confirmed `ccUploadBadgeHtml()`
renders the right text for all four states (including no badge for `null`); ran
`sendEmailNow()` end-to-end (mocked `fetch` for the send-workorder function too) and
confirmed the same status recording. Zero console errors throughout.

### Home-screen app icon (shipped 2026-07-10, dev only)

**Goal (from Mark)**: with the new RoofOps logo approved, give the app a real
home-screen/PWA icon on iOS instead of the browser's default, and make the
`dev` build's icon visually distinct from production so it's obvious which
one is open.

**Source asset**: `icons/source/roofops-logo-source.png` (1254×1254, the full
logo — metallic "RO" house monogram + "ROOF OPS" wordmark, on black). The
wordmark isn't legible at real icon sizes (tested down to 120×120, the rough
size iOS actually renders), so the icons use the monogram alone, cropped and
centered on a black square with ~14% margin — see `icons/README.md` and
`icons/source/gen_icons.py` for exactly how.

**DEV vs prod, same logo**: `icons/dev/*` has a red "DEV" ribbon banner
across the bottom-left corner (the one area of the monogram crop that's
clear black space, so it doesn't cover any of the house/lettering) —
generated once at high res and downsampled, so the ribbon text stays crisp
at 180px. `icons/prod/*` is the identical clean monogram, no ribbon.
**Only `icons/dev/*` is wired into anything right now** — `icons/prod/*` is
generated and committed, ready for when this carries over to `main` (swap
the `index.html` icon links to `icons/prod/*` and drop in a clean
`manifest.json`, see `icons/README.md`).

**Wiring**: `index.html`'s `<head>` gained a `manifest.json` link, an
`apple-touch-icon` link (→ `icons/dev/icon-180.png`), a 192px `icon` link,
and the standard iOS PWA meta tags (`apple-mobile-web-app-capable`,
`apple-mobile-web-app-title: "RoofOps DEV"`,
`apple-mobile-web-app-status-bar-style`, `theme-color: #000000`). New
`manifest.json` at the repo root: `name`/`short_name: "RoofOps DEV"`,
`display: standalone`, black `background_color`/`theme_color`, 192/512
dev icons.

**iOS caches the home-screen icon** — this only affects a *new* "Add to
Home Screen." An existing dev shortcut on Mark's phone won't pick up the
new icon on its own; he'll need to delete it and re-add it from the site
after this deploys.

**Verified**: reloaded the app, confirmed `manifest.json` and all three
`icons/dev/*.png` return 200 with the right content-type, confirmed
`manifest.json` parses as valid JSON, confirmed the `<link>`/`<meta>` tags
resolve to the right URLs in the DOM, and confirmed the rest of the app
(header, home launcher, tabs) still renders normally — zero console errors.

### Photo-capture rework — Increment 1: camera capture + auto-pin (shipped 2026-07-10, dev only)

**Goal (from Mark)**: photos should be captured in context — right in a finding, with
caption/details/pin all attaching in one action, no separate photo section to link up
afterward. This is the enabling piece: in-app camera capture that grabs GPS and
auto-drops a pin. Increments 2 (photo-in-finding UI) and 3 (change-order photos) build
on top of this.

**"📷 Take Photo"** — a new `input[type=file][accept=image/*][capture=environment]`
(`#cameraInput`), alongside the existing library-picker input (`#photoInput`,
untouched). `capture=environment` is what actually opens the device camera directly
on mobile rather than a file picker.

**`captureDeviceGps()`** — wraps `navigator.geolocation.getCurrentPosition` in a
Promise that **never rejects**: no geolocation support, permission denied, or an
8-second timeout all resolve to `null` rather than throwing, so a capture flow can
always just `await` it and keep going — "handle no-GPS/denied gracefully" per spec.
Same accuracy expectations as `useMyLocationForPin()` (~10-30ft, consumer GPS) — a
starting point for the pin, not a final placement.

**`addPhotosFromCamera(files)`** — a deliberate separate function from
`addPhotosFromFiles()`, not a shared refactor: a photo taken right now, standing at
the job, gets the device's current GPS attached (`photo.gps = {lat,lng,accuracy}`);
a library-picked photo could be old or from somewhere else entirely, so that path is
intentionally left with no GPS guess. Same resize/compress pipeline as the existing
upload path either way (this repeats a bit of code intentionally, matching the
established pattern in this codebase of keeping two things that must never interfere
with each other in fully separate functions rather than sharing a fragile control-flow
branch).

**`maybeAutoPinFinding(photo)`** — the actual auto-pin: if a GPS-tagged photo is (or
becomes) associated with a finding that doesn't already have a pin, sets
`finding.pin = {lat, lng, x:null, y:null, source:"device_gps"}` — the exact same shape
and `source` convention `useMyLocationForPin()` already writes for a manual "Use My
Location" placement, so nothing downstream (roof map rendering, PDF pin refs,
`warrantyColor()`) needs to know a pin came from a photo instead of a manual tap.
**Never overwrites an existing pin** — a tech's manual placement, or an earlier
auto-pin, always wins. Wired into the existing photo→finding dropdown's change handler
(`renderPhotos()`) — today that's still the only way a photo gets associated with a
finding; increment 2 replaces that manual step with capturing directly inside the
finding's card, at which point auto-pin fires immediately instead of only once the
tech picks from the dropdown.

**Verified — mocked `navigator.geolocation` only, no real device/GPS, no Firestore or
CompanyCam writes of any kind**: `captureDeviceGps()` resolves correctly for a mocked
success, a mocked permission-denial, and a browser with no `navigator.geolocation` at
all (`null` in every failure case, confirmed never throws); `addPhotosFromCamera()`
end-to-end with a synthetic in-memory JPEG produced a photo with `.img` and `.gps`
set correctly; `maybeAutoPinFinding()` set a finding's pin from a GPS-tagged photo,
confirmed a second call with different GPS did **not** overwrite it; drove the actual
`<select>` dropdown via a real `change` event (not a direct function call) and
confirmed a camera-style (GPS-tagged) photo auto-pins its finding while a
library-style (no `gps` key at all) photo correctly does **not**; confirmed
`collect()`/`fill()` round-trips the new `gps` field with no data loss. Zero console
errors throughout. No real backend was touched at any point in this testing — nothing
to clean up.

### Photo-capture rework — Increment 2: photo-in-finding UI (shipped 2026-07-10, dev only)

**Goal**: capture a photo right inside the finding it belongs to — caption, finding
link, and auto-pin all in one action — instead of adding it in the separate global
Photo Documentation section and then manually picking the finding from a dropdown.

**No data model change — two views of the same array.** `photos[]` already had
`finding_id`; that field is the entire backward-compat story here. Each finding's
card (`findingPhotoGalleryHtml()`, called from `renderFindings()`) now has its own
"📷 Take Photo" / "+ Add Photos" buttons and a small photo strip — but it's built by
*filtering* the existing global `photos[]` array down to `p.finding_id === f.id`,
not a second array. The global Photo Documentation section is completely unchanged
(still every photo, still where reorder/print-order and "General / no specific
finding" happen) because it's reading the exact same array. A work order saved
before this shipped already has `finding_id` set (or `null`) on its photos exactly
the way it always did, so it just displays correctly in both places with zero
migration — confirmed by loading a legacy-shaped object directly (see Verified below).

**`addPhotosFromCamera()`/`addPhotosFromFiles()` gained an optional `findingId`
param** (increment 1's versions untouched otherwise — existing call sites just don't
pass it, identical behavior to before). When a finding's card calls them, the new
photo gets `finding_id` set at creation instead of needing the dropdown afterward,
and — for camera captures — `maybeAutoPinFinding()` now fires **immediately** rather
than waiting for a later dropdown change, since the photo already belongs to the
finding the moment it's captured. That's the actual "caption/finding/pin all attach
in one action" Mark asked for.

**Thumbnail/remove/caption in the embedded gallery reuse the existing global-index
functions** (`openPhotoLightbox(i)`, `removePhoto(i)`) rather than parallel
finding-scoped versions — `findingPhotoGalleryHtml()` just looks up each matching
photo's real index in the global array first. One source of truth, one set of
functions; `removePhoto()` now also calls `renderFindings()` when the removed photo
had a `finding_id`, so it disappears from the embedded strip too, not just the
global list.

**Verified — no real Firestore/CompanyCam writes, everything local/in-memory**:
captured a photo inside a finding's card with mocked GPS and confirmed the pin
auto-dropped immediately (no dropdown step needed) and the photo appeared correctly
in that finding's strip; added a library photo inside a finding and confirmed no GPS
key and no auto-pin; confirmed the global section shows the same photo with the
correct finding pre-selected in its dropdown (same object, not a copy); edited a
caption from the embedded gallery and confirmed it's reflected identically in the
global section; removed a photo from the embedded gallery and confirmed it's gone
from both places with no orphaned entries. **Backward compatibility**: loaded a
legacy-shaped work order object (findings with an existing manual pin and one with
no `pin` key at all, photos with `finding_id` set and one with none, no `gps` key
anywhere) and confirmed it displays correctly in both the embedded and global views
with no errors, no data loss, no duplication. Zero console errors throughout.

### Photo-capture rework — Increment 3: change-order photos (shipped 2026-07-10, dev only)

**Goal**: a Change Order has no findings (it's a scope of work, not a leak diagnosis),
but photos should still be capturable right in the change-order form, each with its
own caption and auto-pin, and show up in the change-order PDF.

**New "Photos" field inside `#wo-changeorder-card`** — "📷 Take Photo" / "+ Add
Photos" buttons plus a photo strip (`#co-photos-host`, populated by
`renderChangeOrderPhotos()`). Unlike `findingPhotoGalleryHtml()` from increment 2,
this shows **every** photo on the work order, not a filtered subset — a Change Order
has no finding grouping, so on that work order type "every photo" and "this change
order's photos" are the same set. Same reuse pattern as increment 2:
`openPhotoLightbox(i)`/`removePhoto(i)` by real global index, one source of truth,
no parallel photo list.

**`photo.pin`** — new, additive, optional field (same shape as `finding.pin`: `{lat,
lng, x, y, source}`). Since a Change Order has no finding to hang a pin off of, each
photo carries its own. `maybeAutoPinPhoto(photo)` is the Change Order equivalent of
increment 1's `maybeAutoPinFinding()` — same never-overwrite rule, same
`source:"device_gps"` convention. Wired into `addPhotosFromCamera()`'s existing
`done()` callback: when no `findingId` is passed (so not an increment-2 in-finding
capture) *and* the work order's current type is "Change Order," it tries
`maybeAutoPinPhoto()` instead of `maybeAutoPinFinding()` — scoped so a Leak/Service
photo added through the ordinary global section doesn't pick up a pin field it has
no use for.

**Photos already printed into the Change Order PDF** — `generateChangeOrderPdf()`
already pulled from `filledPhotos()` (the same global array) as a secondary photo
grid, so nothing needed to change there; photos captured through the new UI just
show up automatically, confirmed by generating the PDF and checking for the photo
section.

**Deliberately not built** (per "don't over-build," matching this session's
established scoping discipline): no drag-to-adjust modal for a photo's pin (only
findings get that, via the existing pin modal, which is hard-wired to
`findingById()`), and `photo.pin` is **not** wired into the roof map or the Building
History aggregate view — this increment is scoped to "captured, auto-pinned, shown
on the change order and its PDF" exactly as asked, not full feature parity with
finding pins. Each photo shows a small "📍 Located" / "No location" note instead. A
reasonable follow-up if Mark wants more.

**Verified — no real Firestore/CompanyCam writes, everything local/in-memory**:
switched to Change Order and confirmed the empty-state gallery renders with working
capture buttons; captured with mocked GPS and confirmed `photo.pin` was set and the
gallery shows "📍 Located"; added a library photo and confirmed no pin and "No
location"; confirmed both photos also appear in the (unchanged) global Photo
Documentation section, same array; generated the actual change-order PDF and
confirmed the photo section is present; removed a photo from the change-order
gallery and confirmed it's gone from both views. **Backward compatibility**: loaded a
legacy-shaped Change Order work order (a photo with no `gps`/`pin` key at all) and
confirmed it displays correctly with "No location," no errors. Zero console errors
throughout.

### Change Order form cleanup (shipped 2026-07-10, dev only)

**Goal (from Mark's review)**: a Change Order was showing sections that don't apply
to it — Roof Investigation Findings, the generic Work Performed list, and (since
Increment 3 of the photo-capture rework) photos twice: once in its own in-scope photo
box and again in the separate global Photo Documentation section below.

**All three now hide for Change Order specifically, via `onWoTypeChange()`**:
- `#wo-findings-card` — already hid for Repair; now also hides for Change Order
  (`(isRepair || isCO)`).
- `#wo-repairsperformed-card` (the plain "Work Performed" list, previously had no
  id at all — added one so it could be targeted) — hides for Change Order only.
  Repair keeps it, unchanged, per "Repair work order type" in this file (it carries
  most of the same info as Leak/Service).
- `#wo-globalphotos-card` (the "Photo Documentation" section, also newly given an
  id) — hides for Change Order only, since `#co-photos-host` (inside
  `wo-changeorder-card`) is the exact same `photos[]` array with its own capture UI;
  showing both was showing the same photos twice. Every other type keeps the global
  section exactly as before.

**Pure UI de-duplication, no data change**: hiding the global photos card doesn't
stop `renderPhotos()` from running (it still writes into the hidden `#photos-list`
and still drives `renderChangeOrderPhotos()` at its end) — photos captured through
the Change Order's own box still land in the same `photos[]` array, still collect()
into the saved work order, and still print into the change-order PDF exactly as
before. Confirmed by capturing a photo on a Change Order with the global section
hidden and generating the actual PDF.

**Verified — no real Firestore/CompanyCam writes**: cycled through all five work
order types and confirmed exactly the right cards show/hide for each (Change Order:
only its own card + Warranty Determination + Summary; Repair, Leak/Service,
Inspection, Warranty: all sections shown as before, unaffected); captured a photo on
a Change Order and confirmed it's in `collect()`'s output and in the generated PDF.
Zero console errors.

### Global photo size setting (shipped 2026-07-10, dev only)

**Goal (from Mark's review)**: photo size shouldn't be a per-user toggle each tech
sets for themselves — it should default to small (email-friendly) for everyone, with
one admin-controlled override that applies globally.

**`globalPhotoSizePref`** (default `"small"`) replaces the old per-user
`localStorage`-backed preference entirely. `photoPreset()` now just reads this one
variable — no more `localStorage.getItem("photo-size-pref")` anywhere. A tech's
device that still has that old key sitting in `localStorage` is harmless: nothing
reads it anymore, confirmed by explicitly setting it and checking `photoPreset()`
ignores it.

**`app_settings/global`** (new Firestore doc, one field: `photoSizePref`) is the
single source of truth. `loadGlobalPhotoSizePref()` reads it once on app startup —
no doc yet, offline, Firestore rules not yet applied, or any other failure all just
mean "keep the small default," never a hard error (confirmed all three failure
modes explicitly). **Read is open to everyone** (every user needs it on load);
**write only ever happens through `netlify/functions/admin.js`'s new
`set_photo_size_pref` action**, same admin-PIN-gated-server-side pattern as every
other admin mutation in that file (`delete_building`, `set_roof_profile`, etc.) —
not a client-side-only `isAdmin` check, since this affects every user's photos going
forward, not just the admin's own session. `firestore.rules` (reference file) now
has an `app_settings` match block: `allow read: if true; allow write: if false;` —
**Mark needs to apply this rule update in the Firebase Console** (same manual step
any `firestore.rules` change here has always needed) for the read to succeed in
production; until then it silently falls back to "small," so nothing breaks either
way, it just won't reflect an admin-set override yet.

**Admin control** — a new bar (`#admin-settings-bar`), visible on every view (not
just the work order Edit form) whenever admin mode is on, since this is an app-wide
setting rather than something tied to the currently-open work order or type (Change
Order hiding the global photos card, above, made that coupling a real problem — a
photo-size control tucked inside a per-work-order card would've been unreachable
whenever admin happened to have a Change Order open). `saveGlobalPhotoSizePref()` is
blocked client-side if `isAdmin` is false (defense in depth — the real gate is the
PIN check in `admin.js`) and updates `globalPhotoSizePref` locally on success, so a
newly-set size applies immediately without needing a reload.

**Verified — mocked Firestore and mocked `callAdminApi`, no real writes**: confirmed
the old `#photoSize` select is gone from the DOM and the default preset matches
`SIZE_PRESETS.small`; loaded a mocked `app_settings/global` doc with
`photoSizePref: "large"` and confirmed `globalPhotoSizePref`/`photoPreset()` picked
it up; confirmed a mocked Firestore rejection and a missing-`fdb` case both fall back
to "small" without throwing; confirmed the admin settings bar is hidden by default,
appears when `isAdmin` is set and disappears when it's cleared, and the select
pre-populates to the current global value; ran `saveGlobalPhotoSizePref()` with a
mocked `callAdminApi` and confirmed the right action/value is sent and the local
preset updates immediately; confirmed the save is a no-op when `isAdmin` is false.
Zero console errors throughout.

### Saved view access control (shipped 2026-07-10, dev only)

**Goal (from Mark)**: a non-admin should only be able to Open a saved work order to
review it — Delete, Export, and Import Work Order File all become admin-only.

**Identified before gating anything**, per spec:
- **Delete** — per-row "Delete" button in the Saved list, calls `deleteOrder(id)`.
  Removes the work order everywhere (local + cloud). Was **not** admin-gated at all
  before this — any user could delete any saved work order.
- **"Export" (Mark: "for the tax")** — per-row "Export" button, calls `exportOrder(id)`.
  Downloads that work order as a `.workorder.json` file ("Export a work order on one
  device, send the file to yourself, then Import it on another" — a manual
  device-to-device transfer mechanism, not an accounting/CSV export despite the "for
  the tax" description). Was not admin-gated.
- **"Input work order file"** — the "Import Work Order File" button (+ its hidden
  file input), calls `importOrderFile(files)`. Reads a `.workorder.json` file back in
  and saves it as a new/replacement local + cloud work order. Was not admin-gated.

**All three now dual-gated** — same defense-in-depth pattern as every other
admin-only action in this file (`deleteBuildingAdmin()`, etc.): the button itself
only renders/shows for `isAdmin` (`drawSaved()` for the per-row Export/Delete
buttons; `#saved-import-btn`/`#saved-export-hint` toggled in `updateAdminUI()` for
Import), **and** `deleteOrder()`/`exportOrder()`/`importOrderFile()` each check
`isAdmin` themselves and bail with a toast if it's off — so calling any of them
directly (e.g. from devtools) hits the same wall a hidden button would, not just a
missing button. Toggling admin mode re-draws the Saved list immediately
(`updateAdminUI()` now calls `drawSaved()`), so switching modes takes effect without
changing tabs.

**Open/review behavior — reported, not changed, per spec**: `loadOrder()` (what
"Open" calls) does `fill(o); showView("edit");` — the exact same fully-editable Edit
form used for creating or editing any work order, complete with its own Save button.
**There is currently no read-only/view mode at all.** A non-admin opening a
submitted work order "to review" it can fully edit every field and re-save,
overwriting the original — indistinguishable from editing a draft. Mark needs to
decide whether that's acceptable or whether Open should become read-only for
non-admins; nothing about this was changed in this pass.

**Verified — no real Firestore/CompanyCam writes left behind**: confirmed a non-admin
Saved view shows only "Open" per row, with Import and its explanatory hint both
hidden; confirmed admin mode shows Open/Export/Delete per row and the Import button;
confirmed toggling admin mode live-updates the list without a tab change; confirmed
all three functions correctly no-op with a toast when called directly while
`isAdmin` is false (including a real import attempt with an actual file, proving the
block, then flipping `isAdmin` true and confirming the identical call succeeds —
proving the gate is specifically the `isAdmin` check). **One real mistake made and
corrected during this pass**: an early test round ran against the real `fdb` (it
initializes automatically against production Firestore, not a mock, unless
explicitly nulled out) instead of a mocked one — the admin-mode import test briefly
wrote a real `workorders/wo_should_not_import` test document to production. Caught
immediately by checking `fdb === null` after the fact, confirmed the document existed
via a direct Firestore read, deleted it, and confirmed the delete with a follow-up
read (404). All remaining verification was redone with `fdb` explicitly set to
`null`. No trace of test data remains in production Firestore or local storage.

### Change Order: no Warranty Determination (shipped 2026-07-10, dev only)

**Goal (from Mark)**: a Change Order doesn't need a warranty section at all — it's a
scope-of-work/authorization document, not a leak/warranty investigation.

`#wo-warrantydetermination-card` (new id on the existing card — Warrantable/
Non-Warrantable Repairs textareas, plus the Leak/Service-only guideline reference and
Manufacturer Service # inside it) now hides for Change Order via `onWoTypeChange()`,
same pattern as every other type-conditional card. Every other type keeps it exactly
as before, including the Leak/Service-only guideline lists inside it. No PDF change
needed — `generateChangeOrderPdf()`/`buildChangeOrderText()` never read
`warrantable`/`nonWarrantable`/`mfgServiceNo` in the first place (confirmed by
reading those builders — they're fully separate from the leak-report builder and
never referenced these fields).

### Leak-form photo restructure: CompanyCam moves into findings (shipped 2026-07-10, dev only)

**Goal (from Mark)**: photos should live with findings — move Import from CompanyCam
up into the finding section, remove the lower/global section's Take Photo and Add
Photos buttons, and enforce that every photo has both a caption and an assigned
finding.

**Current layout, reported before touching anything**: findings already had their
own Take Photo/Add Photos buttons (Increment 2 of the photo-capture rework). The
lower "Photo Documentation" section (`#wo-globalphotos-card`) had Take Photo, Add
Photos, *and* Import from CompanyCam, plus the full photo list (every photo, with
caption/finding-reassignment dropdown/reorder/lightbox) and the CompanyCam link
banner.

**A real conflict found before implementing**: `#wo-globalphotos-card` is shared by
every type except Change Order (which hides it entirely) — including **Repair**,
which has no findings at all and no photo capture of its own on its "Repair Scope"
card. Stripping the three buttons from the global section unconditionally would have
left Repair work orders with no way to add a photo. Resolved by keeping Take
Photo/Add Photos/Import-CompanyCam visible in the global section **only for Repair**
(`#wo-globalphotos-buttons`, toggled by a new `hasFindings` check in
`onWoTypeChange()` — `!isRepair && !isCO`); they're hidden for Leak/Service,
Inspection, and Warranty (the types that have findings). The global section's hint
text swaps between two variants (`#wo-globalphotos-hint-findings` /
`#wo-globalphotos-hint-nofindings`) to match. Per spec, the photo **list/thumbnails**
in the global section stay visible for every type (including Leak/Service) — only
the capture buttons move/disappear; the list is still where reordering (print order)
and reassigning a photo's finding happen.

**CompanyCam import is now finding-aware**: `openCC(findingId)` (called from
`findingPhotoGalleryHtml()`'s new "Import from CompanyCam" button) records
`ccTargetFindingId`; `ccImport()` sets `compressed.finding_id` from it and calls
`maybeAutoPinFinding()` when set — same "attach + auto-pin in one action" behavior
camera/library captures already had, now extended to CompanyCam imports made from
inside a finding. Opening from the global section (Repair only now) leaves
`ccTargetFindingId` null, identical to today's behavior.

### Caption + finding enforcement (shipped 2026-07-10, dev only)

**`findingsPhotoIssues(o)`**: on any work order type that has findings
(Leak/Service, Inspection, Warranty — not Repair or Change Order, which have no
findings to assign to), every photo must have both a non-empty caption and an
assigned `finding_id`. Checked in `saveOrder()`, which now returns `false` and shows
a specific, itemized toast (e.g. "Photo 1 needs a caption and a finding; Photo 2
needs a finding") instead of saving, if anything's missing.

**Deliberately scoped to the explicit Save button only** (`opts.quiet` unset) — NOT
the internal quiet auto-saves `ccImport()` and `autoSaveBeforeReport()` already make.
Found and worked around a real conflict here too: `ccImport()` calls
`saveOrder({quiet:true})` immediately after every import, and a freshly-imported
photo hasn't had a chance to be captioned yet — validating that quiet save would
have blocked the *entire CompanyCam import flow* with a false-positive error every
single time. Same reasoning for not blocking `autoSaveBeforeReport()` (the pre-Send/
Share/Download auto-save): blocking a tech from sending a report at all over a photo
caption felt too disruptive for field use.

**Known tradeoff, flagged for Mark rather than silently decided**: this does mean
opening an *existing* Leak/Service/Inspection/Warranty work order that already has
general/uncaptioned photos (anything saved before this shipped) will now be blocked
from re-saving until those photos are fixed. That's arguably the intended
"enforcement" outcome (force cleanup as old work orders get touched again), but it's
a real behavior change worth knowing about.

**Verified — `fdb` explicitly set to `null` before any test that could write, per
the standing instruction**: confirmed the Warranty Determination card hides for
Change Order only across all 5 types; confirmed the global photo buttons hide for
Leak/Service/Inspection/Warranty and stay visible for Repair only, with the matching
hint text swap; confirmed each finding's own "Import from CompanyCam" button targets
that specific finding (not a different one — caught and fixed a real bug here, see
below); confirmed a mocked CompanyCam import into a finding sets `finding_id` and
auto-pins the finding from the imported photo's GPS; confirmed `saveOrder()` blocks
with the exact itemized message for missing caption, missing finding, or both, and
succeeds once both are fixed; confirmed Repair and Change Order are fully exempt
(save succeeds even with an uncaptioned/unassigned photo). **A real bug found and
fixed during this pass**: `ccImport()` tracked `ccTargetFindingId` but never actually
applied it to the imported photo — caught by testing the actual import path (not just
the open/close tracking), fixed by setting `compressed.finding_id` and calling
`maybeAutoPinFinding()` inside the import loop. Zero console errors throughout. All
local test work orders created during testing (all saved locally only, `fdb` was
null) were cleared from `localStorage` afterward, and a direct read against real
production Firestore confirmed no test document was ever created there.

### Field-value memory / autocomplete — researched, not built (2026-07-10)

**Mark's question**: "Did we address keeping track of what was entered in the fill
boxes so they can auto-populate?" Checked the codebase directly (grepped for
`datalist`, `autocomplete=`, and any field-history mechanism) — **no such thing
exists today.** The only two "auto-populate" mechanisms in the app are both
select-a-specific-existing-record flows, not general field memory:
- **Select Existing Building** (`bpSelectBuilding()`) — pulls Job Name/Bill To/
  Location/Roof System from a previously-*saved* building record the tech explicitly
  picks.
- **CompanyCam import** — pulls Job Name/Location from the linked CompanyCam
  project's own metadata.

Free-text fields like Technician, Site Contact, Billing Contact, etc. have no `name`
attribute, no `autocomplete` hint, and no `<datalist>` — nothing remembers a
previously-typed value across work orders or suggests it while typing. This is a
real gap if Mark wants it; not something this pass built (report-only, per his
request — he'll decide with the user whether to build it).

## Outlook / Microsoft 365 integration (Phase 0: auth + mailbox read, shipped dev-only)

First increment of integrating Mark's Microsoft 365 mailbox (`marks@watkinsroofing.net`)
via Microsoft Graph, so mail can eventually be organized and inspection-report PDFs
auto-filed to the matching CompanyCam project. Follows the same proxy-function
pattern as `companycam.js`/`send-workorder.js` — credentials live only in Netlify
environment variables, never in the browser or the repo.

- **`netlify/functions/lib/graphAuth.js`** — app-only (client-credentials) OAuth2
  token helper. `POST`s to
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
  `scope=https://graph.microsoft.com/.default`, caches the resulting token in
  memory (per warm function instance only — never written to disk) until ~1 minute
  before it expires, and exposes `graphFetch(pathOrUrl, options)`, a thin wrapper
  that resolves relative paths against `https://graph.microsoft.com/v1.0` and
  attaches the bearer token. Not itself a deployed function — required by
  `outlook.js`.
- **`netlify/functions/outlook.js`** — the deployed endpoint.
  - `GET ?action=folders` — lists the configured mailbox's mail folders
    (`/users/{mailbox}/mailFolders`).
  - `GET ?action=messages&folder_id=&top=` — lists recent messages, optionally
    scoped to one folder, newest first, capped at 50 per call.
  - Both actions pass a non-2xx Graph response through as `{ error }` with the
    real status code and body (truncated to 500 chars) rather than swallowing it —
    important right now because a **403 from Exchange's Application Access
    Policy** (see below) needs to be visually distinguishable from a real
    auth/credential failure.
- **Access is intentionally restricted, not wide-open app-only mailbox access.**
  The Azure app registration's app-only Graph permission is scoped down by an
  **Exchange Application Access Policy** to a specific security group
  ("RoofOps Team") — the app can only read mailboxes that are members of that
  group, not every mailbox in the tenant. Adding a mailbox to that group is an
  Exchange Online change that can take **up to ~30 minutes to propagate**; until
  it does, reads against that mailbox 403 even though the credentials themselves
  are valid. `outlook.js` returns that as a plain 403 with Graph's own error body,
  which for this specific case looks like an `ErrorAccessDenied`/`AccessPolicy`
  message rather than an `InvalidAuthenticationToken` one — that distinction is
  the tell for "still propagating" vs. "actually broken."
- **Required env vars** (Netlify > Project configuration > Environment variables —
  see the table below): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
  `GRAPH_MAILBOX`. The client secret is time-limited and will be **rotated before
  go-live** — when that happens, only the Netlify env var needs to change, nothing
  in code references the value directly.
- **Not built yet (left as code comments in `outlook.js`, not scaffolding)**:
  - **Phase 1 — organize mail into folders by sender.** Needs the `Mail.ReadWrite`
    app-only permission (this Phase 0 build only requests/uses `Mail.Read`) — the
    Azure app registration's API permissions need extending + re-consenting before
    this can be built, not just new code here.
  - **Phase 2 — watch for inspection-report emails and file the PDF to the
    matching CompanyCam project.** Planned approach: either polling (a scheduled
    function querying `/messages?$filter=...`) or a Graph change-notification
    subscription (needs a public HTTPS callback — a Netlify function URL would
    work). On a match, download the attachment and reuse `companycam.js`'s
    existing `upload_document` action to file it — no new CompanyCam-side code
    needed, just wiring. Matching-strategy notes from the earlier (declined) "push
    photos to CompanyCam" investigation — see "Push app-added photos to
    CompanyCam" above — are the starting point for how to match an email/PDF to a
    project.
- **Live connection test (2026-07-10)**: ran the app-only auth + a mailbox read
  against the real tenant/mailbox inline (credentials passed as environment
  variables to a throwaway process, never written to disk, never logged, deleted
  immediately after) to check whether the Exchange Application Access Policy had
  finished propagating after the mailbox was added to the "RoofOps Team" group.
  **Result: token acquisition succeeded (`200`), but the mailbox read still
  failed** —
  `403 {"error":{"code":"ErrorAccessDenied","message":"Access to OData is disabled: [RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings."}}`.
  Credentials are valid and the app-only flow works end-to-end; the Application
  Access Policy simply hasn't propagated to allow this mailbox yet. No code
  change needed — re-run the same check later (it can take up to ~30 minutes
  after the mailbox was added to the group).

### Field-value memory / autocomplete (shipped 2026-07-10, dev only)

**Goal (from Mark)**: an actual build, following up on the earlier "did we address
field memory" research (see "Field-value memory / autocomplete — researched, not
built" above) — remember what's been typed into free-text fields before and suggest
it, across many fields including photo captions.

**Mechanism — plain `localStorage`, no Firestore writes, nothing leaves the
device**: `FIELD_HISTORY_KEYS` names each shared suggestion pool (a "key" groups
semantically-identical fields across different parts of the app — e.g. Site Contact
and Billing Contact both feed the same `contactName` pool, since they're both just
"a person's name"). `rememberFieldValue(key, value)` trims, dedupes (re-entering an
existing value moves it to the front instead of duplicating), and caps each key's
history at `FIELD_HISTORY_CAP` (25) most-recent values, stored under
`localStorage["field-history:" + key]`. Recorded on **blur**, not every keystroke.
Surfaced via a native `<datalist>` per key (`populateFieldDatalist()`/
`populateAllFieldDatalists()`), referenced by `list="dl-<key>"` on each wired input —
Mark's own suggested "cleanest approach," so no custom dropdown widget to build or
maintain, and the browser's native suggestion UI just works.

**Fields wired** (10 keys):
- `jobName` — Job Name, and RoofMapper's quick-save "Job Name / Building"
- `location` — Location
- `billTo` — Bill To, and RoofMapper's quick-save "Bill To / Customer"
- `contactName` — Billing Contact **and** Site Contact (shared pool)
- `contactPhone` — Contact Phone
- `technician` — Technician, **and** the Log Activity modal's Technician/Author
  (shared pool)
- `roofLocationDetail` — a finding's "Location / Detail," **and** a Work Performed
  repair's "Location / Detail" (shared pool — both are "where on the roof" detail
  fields)
- `repairItemNotes` — a Repair work order's itemized Repair Item "Notes / Location"
- `photoCaption` — every photo caption input in the app (finding-embedded gallery,
  the global Photo Documentation section, and the Change Order photo gallery — all
  three share one pool, since a caption is a caption regardless of which UI
  captured it)
- `assetLabel` — a permanent roof asset's Label (e.g. "Drain #3, RTU-2")

**Deliberately left out, with reasons** (not an oversight):
- **Materials** (`#woMaterials`, Change Order) and every other free-text `<textarea>`
  (Description of Work Performed, Summary, Warrantable/Non-Warrantable Repairs,
  Repair Scope's description, a finding's Roof Condition Observed, a repair's Repair
  Performed) — the native `list` attribute only works on `<input>`, not `<textarea>`,
  and datalist-style single-value suggestion doesn't fit a multi-line/multi-sentence
  free-text block the same way it fits a short recurring value anyway.
- Unique identifiers and dates — Job No., PO Number, Date Completed, Manufacturer
  Service #, Date of Service — these are never repeat values by nature.
- Search boxes (Reports/Building Picker/RoofMapper/CompanyCam search fields) — these
  filter-as-you-type against existing data; suggesting past *search terms* isn't the
  same thing and wasn't asked for.
- Roof Profile admin fields (Roof System, Manufacturer, Deck Type, Insulation Type,
  Warranty Provider) — genuinely could benefit from this later (manufacturer/deck
  type names do recur across buildings), but it's an admin-only editing surface, not
  a field a tech fills out routinely — left out to keep this pass scoped to what
  Mark actually asked about. Flagging as a reasonable future candidate.

**Verified — no Firestore writes possible, `fdb` explicitly `null` throughout**:
confirmed a shared key (`contactName`) correctly pools values entered through two
different fields (Site Contact and Billing Contact) into one datalist; confirmed
re-entering an already-remembered value moves it to the front without creating a
duplicate; confirmed the 25-item cap is enforced by pushing 30 values past it;
confirmed empty/whitespace-only values are silently ignored (never stored). Zero
console errors.

### Export button removed (shipped 2026-07-10, dev only)

**Goal (from Mark)**: "I don't need an export button at all." Not just admin-gating
it further (it was already made admin-only earlier this session, see "Saved view
access control" above) — full removal.

`exportOrder()` is deleted entirely, along with its per-row button in `drawSaved()`.
The Saved-tab hint that explained the Export → Import device-transfer pairing is
reworded to describe Import on its own (`#saved-import-hint`, was
`#saved-export-hint`) — "Import a work order file (.workorder.json) received from
elsewhere."

**Import was deliberately left in place, not removed** — per spec, flagging the
tradeoff rather than deciding unilaterally: Import's job (load a `.workorder.json`
file from *anywhere*, not necessarily one this app produced) doesn't strictly
require Export to exist. It's genuinely a little less useful now that there's no
in-app way to produce such a file, but it's not fully orphaned — a file could still
arrive some other way (manually crafted for a migration/test, a future tool, etc.).
**Recommendation for Mark to weigh in on**: if there's truly no other source for a
`.workorder.json` file in practice, Import could reasonably go too — but that's his
call, not assumed here.

**Verified — no Firestore writes possible, `fdb` explicitly `null`**: confirmed
`exportOrder` is `undefined` (not just hidden); confirmed a non-admin's Saved row
shows only Open, an admin's shows Open + Delete (no Export for anyone, at any
permission level); confirmed Import still works correctly for an admin.

### View-only mode for a submitted work order — built, then CANCELED by Mark

Mark initially asked for this (see the Saved-view access-control pass above), then
clarified he does **not** want it: non-admins CAN edit and re-save any work order,
submitted or not, exactly as it worked before. The lock (MutationObserver on
#view-edit, currentOrderIsSaved flag, refreshViewOnlyLock(), the saveOrder() guard,
the view-only banner) was fully built, tested, and briefly shipped in one commit
alongside Builds A/B, then **completely removed** in a follow-up commit the same
day, before Mark saw it live -- confirmed zero trace of the removed code remains
(grepped for every identifier: currentOrderIsSaved, viewOnlyObserver,
lockFormControlsIn, unlockFormControlsIn, refreshViewOnlyLock, view-only-banner --
all clean), and confirmed directly that a non-admin can open, edit, and re-save an
already-submitted work order again, identical to behavior before this was ever
built. Only Builds A (field autocomplete) and B (Export button removed) shipped.

### RoofMapper <-> Roof Map unification -- Phase 1: connect outline save to feature placement (shipped 2026-07-10, dev only)

Mark's end-state vision: "Use RoofMapper to capture the roof outline (or drop in a
satellite/drone image) -> that outline becomes the canvas you place features on ->
drains, HVAC, leaks, repairs, all on the roof you just mapped -> it all lives on
the building's history." Before this, RoofMapper (outline capture/generation) and
the Roof Map / roof-asset feature-placement UI were two disconnected screens --
saving an outline just toasted and closed a modal, with no path into placing a
feature on the roof you'd just mapped.

Phase 1 connects them without rebuilding either side:

- `rmSaveOutlineToBuilding(buildingId, roofId)` -- after a successful save, instead
  of just toasting, now calls `showView("history")` then
  `historySelectRoof(buildingId, roof.id)` (the roof actually resolved/saved to,
  not the possibly-undefined `roofId` param) so the tech lands directly on that
  roof's Building History roof map. `rmCreateBuildingAndSave()` (the new-building
  save path) funnels through the same function, so it's covered automatically.
- Building History's roof map (`renderBuildingMap()`) already drew `roof_outlines[]`
  as the orange polygon and already had an "+ Add Roof Feature" button scoped to
  the selected roof -- no changes needed there. Landing there now puts the
  just-saved outline directly in view with the add-feature action one tap away.
- `openAssetModalSatellite()` (the roof-asset/feature placement modal itself) did
  NOT previously draw the roof outline while actually placing a pin -- only other
  existing assets (faded). Added the same outline-polygon rendering used on the
  Building History map, so the outline is visible as the canvas while you're
  placing the feature, not just on the map you passed through to get there. Also
  added an outline-centroid fallback for the map's initial center/zoom (used only
  when there's no existing pin, no other placed assets, and no drone orthomosaic
  to center on) so a fresh roof with a fresh outline and zero features zooms
  straight to the outline instead of a generic address geocode.
- Left untouched, confirmed still working standalone: `rmSaveLocally()`
  (device-only localStorage save, no building/roof link -- correctly has nothing
  to route into, stays on the RoofMapper screen) and opening Building History /
  the Roof Map directly without going through RoofMapper at all.
- Feature-placement pixel/xy custom-base-map mode (roof plan or hand sketch
  uploads) does NOT get the outline overlay -- `roof_outlines[]` are always real
  lat/lng (see the comment at `renderBuildingMap`), and xy mode has no
  georeferencing to place them against. Satellite/lat-lng mode only.

Resulting flow: RoofMapper -> generate outline -> "Save Outline to Building" ->
picks/confirms building+roof -> save succeeds -> automatically lands on that
roof's Building History roof map (outline visible) -> tap "+ Add Roof Feature" ->
the placement modal opens with the outline drawn on it -> place drain/HVAC/etc
-> Save -> back on the roof map, feature now shown alongside the outline.

Tested with `fdb` mocked (fake in-memory building/roof, no writes to production
Firestore) end to end: outline save -> navigation -> roof correctly selected ->
asset modal shows exactly one outline polygon layer -> closed cleanly. All test
state (`window.fdb`, `rmState.outline`, the local-outline localStorage key) reset
before finishing; page reloaded with a clean console.

See the Roadmap section below for the full multi-phase plan (Phase 2: feature
placement + zoom inline in RoofMapper as one surface; Phase 3: satellite/drone/
uploaded image as the RoofMapper canvas) and the two new capabilities Mark wants
captured for later -- per-edge dimensions/measurement lines, and dividing a roof
outline into labeled sections.

### RoofMapper <-> Roof Map unification -- Phase 2: unified surface, zoom, full-roof export (shipped 2026-07-10, dev only)

Mark's vision restated for this phase: "map the roof, then mark it up on that
same roof, then export the whole blueprint" -- RoofMapper stops handing off to
a separate screen and becomes the place all three actually happen.

**1. Inline feature placement.** `rmSaveOutlineToBuilding()` no longer
navigates to Building History after a successful save (Phase 1's behavior,
superseded) -- it sets `rmState.linkedBuildingId`/`linkedRoofId`, reveals a new
"Roof Features" card (`#rm-features-panel`), and draws any of that roof's
existing features right on RoofMapper's own map (`rmLoadLinkedAssets()` ->
`rmDrawLinkedAssets()`, a Leaflet `layerGroup` on `rmState.map`). "+ Add
Feature" (`rmAddFeature()`) and tapping an existing marker (`rmEditFeature()`)
both just call the existing `openAssetModal(buildingId, assetId, roofId)` --
placement itself is 100% reused, not rebuilt. The only new plumbing is a
`assetModalReturnTo` flag ("history" default, unchanged; "roofmapper" when
opened from here): `closeAssetModal()` branches on it so it redraws
RoofMapper's inline markers instead of rebuilding Building History's map
underneath a view nobody's looking at. Building History's own Roof Map is
completely unaffected -- it reads the same `roof_outlines[]`/`roof_assets[]`
arrays and still works exactly as before for anyone who opens the building
from there instead.
- **Scope cut, flagged rather than forced**: finding pins (leak/repair
  markup) are NOT placeable inline from RoofMapper. A pin belongs to a
  specific work order's finding (`finding.pin`), and RoofMapper has no
  "current work order" in its context for a pin to attach to -- forcing that
  in would mean either inventing a pin-with-no-finding concept or dragging a
  work order picker into RoofMapper, both bigger changes than this phase
  should force through. Leak/repair pins still get placed the existing way
  (from within a work order), and DO flow into the full-roof export below
  once they exist.
- A roof with a custom base map (roof plan/sketch, x/y pixel-placed assets)
  can't show those assets inline here -- RoofMapper's map is always real
  lat/lng (OSM), same limitation the outline itself already has. Documented
  in code comments; not a regression, those assets still save and still show
  correctly on Building History's map (which supports both coordinate
  systems).

**2. Zoom.** `#rm-map`'s height went from `min(55vh,460px)` to
`min(70vh,640px)` -- more room to work on a big roof. `rmEnsureMap()` now
explicitly sets `zoomControl`/`scrollWheelZoom`/`touchZoom: true` (these
already defaulted true in Leaflet -- spelled out so it's clearly intentional,
not incidental). The real fix for "feels small": `rmGenerateOutline()` used
to leave the map at whatever wide view `fitBounds()` picked to show ALL
candidate footprints from the search -- it now calls the new
`rmZoomToOutline()` right after generating, zooming straight into the one
roof actually chosen. A "🔍 Zoom to Roof" button in the outline panel lets
the tech re-center any time after panning away while placing several
features.

**3. Full-roof export.** `rmExportSVG()`/`rmExportPNG()`/`rmExportPDF()` are
now async and call the new `rmFetchExportOverlayData()` first, which (when
the outline is linked to a building) fetches that roof's `roof_assets[]`
plus its historical finding pins (`building_history_events[].pins[]`,
filtered by `roofId`, same source and query Building History's own map
already uses -- no new Firestore index needed). `rmBuildOutlineSvg(outline,
overlay)` and the PDF builder now take that `overlay` and draw each asset as
a colored circle + emoji (matching `ROOF_ASSET_TYPES`) and each pin as a
circle colored by `warrantyColor()`, plus a text legend. **Backward
compatible by construction**: `overlay` is optional -- passing `null`/
`undefined` (an unlinked or locally-saved-only outline) produces
byte-identical output to the pre-Phase-2 outline-only export, verified
directly (same SVG string shape, no markers/legend, same `footerH`/layout
math). `rmExportProjectFeet(ring)` was refactored to share its per-point
projection logic (`rmExportProjectPoint(point, origin)`) with the new
asset/pin projection, guaranteeing they land in the exact same coordinate
space as the outline -- not a separate/independent calculation that could
drift out of alignment. Assets/pins placed via a roof's custom base map
(x/y, no georeference) are skipped in the export for the same reason they're
skipped inline (no lat/lng to plot against a lat/lng-based outline).

Also added: `rmClearLinkedFeatures()` (drops the linked-building state and
inline markers -- called by a fresh search and by loading a different
locally-saved outline, so a previous building's features never bleed into a
new one) and `rmUpdateExportHint()` (a small `#rm-export-hint` line under the
export buttons that says outright whether the next export will be
outline-only or the full marked-up roof).

Tested with `fdb` mocked (fake in-memory building/roof/history-events, no
writes to real Firestore): outline generated -> auto-zoom confirmed ->
saved to a fake building -> confirmed it stayed on RoofMapper (Building
History's view never became visible, never fetched) -> features panel shown
with the building's name -> added a feature via `rmAddFeature()` ->
confirmed `assetModalReturnTo` was "roofmapper" -> saved it -> confirmed the
modal closed, RoofMapper stayed active, and exactly one marker was drawn
inline -> confirmed `rmFetchExportOverlayData()` returned that asset ->
confirmed the SVG export included a matching circle + legend entry ->
confirmed the PDF export ran end-to-end with no errors (draws its own
circles via `doc.circle()`) -> confirmed passing `overlay: null` reproduces
the original bare-outline SVG exactly (no markers, no legend, same size
math) -> confirmed a fresh search correctly clears the linked state and
markers -> confirmed Building History's own Roof Map still renders correctly
and independently for the same test building -> confirmed
`rmSaveLocally()`'s fully offline/unlinked path still works standalone. All
test state (`window.fdb`, `rmState.*`, one locally-saved outline) removed
before finishing; page reloaded with a clean console throughout.

**Not built, explicitly deferred** (see Roadmap): merging the asset/pin
placement UI itself INTO RoofMapper's map (still a separate modal overlay,
just one that stays on the RoofMapper screen instead of routing away --
Mark's Phase 2 description also mentioned "zoom inline in RoofMapper" as one
surface, which this interprets as reusing the existing placement modal
in-place rather than rebuilding a second placement UI directly on
`rmState.map`); satellite/drone/uploaded imagery as RoofMapper's own capture
canvas (Phase 3); per-edge dimensions and roof sections (documented, not
built).

### Email Send-to recipient defaults (shipped 2026-07-10, dev only)

Mark's request: drop the "Office"/"Manager" role-labeled quick-picks from the
report-email "Send to" dropdown, default the TO field instead of requiring a
manual pick, and remember any address actually sent to so it becomes a future
quick-pick. This is the report-email TO field only (`#emailTo`/`#emailPick` on
the Preview view) -- the separate Reply-To (marks@ + charlottew@, set
server-side in `netlify/functions/send-workorder.js` via `REPLY_TO_EMAIL`/the
`domain` fallback) is untouched.

- **Removed**: the two hardcoded `<option>`s labeled "Office — Charlotte
  Washburn" and "Manager — Mark Sheppard" from `#emailPick`. Chris Gravits,
  Nathan Dietiker, and Mark Emms remain as named quick-picks (they were never
  "office"/"manager" presets, just individually named people) -- now sourced
  from `EMAIL_RECIPIENTS_SEED` instead of static HTML.
- **New default TO**: `renderDoc()` (runs every time the Preview view is
  shown) now pre-fills `#emailTo` -- `marks@watkinsroofing.net` alone for
  every work order type, or `charlottew@watkinsroofing.net` +
  `marks@watkinsroofing.net` together specifically for `Leak / Service`
  (`WORK_ORDER_TYPES[0]`). Only fills an **empty** box, so it never clobbers
  recipients the user already picked/typed -- flipping back and forth between
  Edit and Preview on the same order doesn't reset a manual choice.
- **Auto-grow, persisted list**: `#emailPick`'s options now come from
  `getEmailRecipients()` (localStorage key `email-recipients-v1`, seeded with
  Chris/Nathan/Mark E on first use). After a confirmed-successful send via
  "Send Email Now" (`resp.ok && out.ok` from `send-workorder`, the same guard
  `markWorkOrderEmailed()` uses), `rememberEmailRecipients(addrs)` adds any
  address not already in the list (case-insensitive dedupe against the whole
  list, not just the seed) and re-renders the dropdown. Scoped to "Send Email
  Now" only -- not `emailDoc()` (mailto:) or `sharePdf()` (system share sheet),
  since neither of those confirms an email was actually sent (the user could
  back out of their own mail app); only the server-confirmed Resend path
  counts as "sent."
- Same storage-quota-safe pattern as field-value memory (Build A): wrapped in
  try/catch, a full/unavailable localStorage never blocks the send itself.

Tested with `fdb` and `fetch` both mocked (no real Firestore writes, no real
Resend/CompanyCam calls): confirmed the Office/Manager options are gone from
the dropdown; confirmed the Leak/Service default is
`charlottew@watkinsroofing.net, marks@watkinsroofing.net` and every other type
defaults to `marks@watkinsroofing.net` alone; confirmed the empty-box guard
leaves a manually-typed recipient list untouched; confirmed a brand-new
address survives a full mocked `sendEmailNow()` call and gets added to the
persisted list (and that re-sending to an already-known address, in a
different case, does not duplicate it); confirmed the list persists across a
page reload. All test-added recipients and the `email-recipients-v1` key were
removed before finishing, leaving the seeded Chris/Nathan/Mark E list as the
clean baseline; no test work orders were saved (real save/PDF/CompanyCam/
history-log functions were stubbed out for this test, not exercised for
real).

### Email Send-to corrections: Charlotte/Mark restored, guaranteed BCC, name-on-add (shipped 2026-07-10, dev only)

Mark clarified the previous pass misread his intent, plus two new asks:

- **Charlotte and Mark restored to the quick-pick list.** "Remove the
  Office/Manager presets" meant drop the ROLE LABELS ("Office —", "Manager
  —") in front of their names, not drop the people. `EMAIL_RECIPIENTS_SEED`
  is back to five entries: Charlotte Washburn, Mark Sheppard, Chris Gravits,
  Nathan Dietiker, Mark Emms — all plain named quick-picks now, no role
  prefixes on anyone. **One-time backfill in `getEmailRecipients()`**: if a
  device already saved the briefly-live buggy list (missing Charlotte/Mark)
  before this fix, any seed entries missing from the stored list are
  prepended and the fixed list is persisted back, without disturbing
  anything the device had already auto-grown onto it. The Leak/Service and
  default-marks@ pre-fill behavior from the previous pass is unchanged.
- **Guaranteed BCC to marks@ on every send.** `netlify/functions/
  send-workorder.js` now always sets `bcc: ["marks@" + domain]` on the
  Resend payload, unconditionally — enforced server-side so it can't be
  skipped by omitting it from the client call, and applies no matter who's
  already in To/Reply-To. The two client-built `mailto:` links (`emailDoc()`,
  and `sharePdf()`'s desktop branch) now also append `&bcc=` for the same
  address (`EMAIL_ALWAYS_BCC` constant) so the guarantee holds through those
  paths too. `sharePdf()`'s mobile branch uses the Web Share API when
  available, which has no BCC (or To/CC) concept at all — not applicable
  there, unchanged.
- **Name prompt on auto-add.** `rememberEmailRecipients()` now asks (native
  `prompt()`) for a name the first time a genuinely new address is
  remembered — "New recipient "&lt;addr&gt;" isn't on your Send-to list yet
  — name them for next time?" A name is stored as `"Name <email>"` in the
  quick-pick's label; leaving it blank/canceling falls back to the bare
  email, same as before this ask. Still fires once per new address per
  `sendEmailNow()` call (multiple genuinely-new addresses in one send = one
  prompt each), still skips entirely for anything already on the list
  (case-insensitive).

**Flagged, not changed**: marks@ is now both a default To recipient (every
type) and always BCC'd — and on Leak/Service he's a To recipient twice over
(default To list + the guaranteed BCC). He'll get some emails twice (once as
a visible To, once as a blind copy) until/unless the defaults are simplified
(e.g. drop him from the To defaults and rely on the BCC alone). Not changed
here — Mark's call to make later.

Tested with `fdb` null, `fetch`/save/PDF/logging mocked, and `window.prompt`
stubbed (captures the prompt text, returns a scripted answer) — no real
Firestore writes, no real Resend calls, no real dialogs blocking automated
testing. Confirmed: the dropdown includes Charlotte Washburn and Mark
Sheppard as plain names (no "Office —"/"Manager —"); the one-time backfill
correctly prepends missing seed entries onto an already-stored list without
losing a previously auto-grown address; Leak/Service still defaults to
`charlottew@watkinsroofing.net, marks@watkinsroofing.net` and other types to
`marks@watkinsroofing.net` alone; the name prompt fires with the expected
message and stores `"Name <email>"` when answered, falls back to a bare
email when left blank, and does not fire at all for an address already on
the list (including a same-address-different-case check). All test
recipients and the `email-recipients-v1` key were removed before finishing;
page reloaded clean.

### Email Send-to defaults, round 2: marks@ is BCC-only, no duplicates (shipped 2026-07-10, dev only)

Mark: he doesn't want duplicate emails — the always-on BCC already covers
him, so he shouldn't ALSO be a default To recipient (the exact flag left
open at the end of the previous pass).

- `EMAIL_DEFAULT_TO` is now `[]` (empty) — no default To recipient at all
  for anything except Leak/Service. `EMAIL_DEFAULT_TO_LEAK` is now just
  `["charlottew@watkinsroofing.net"]` (she handles billing) — Mark dropped
  entirely from both. He's still on `EMAIL_RECIPIENTS_SEED` (the quick-pick
  dropdown) as "Mark Sheppard," fully selectable, just no longer
  pre-selected.
- **Dedupe, made real.** Added `parseEmailRecipients(raw)` — trims, drops
  blanks, and dedupes case-insensitively — and switched every place that
  used to do a bare `.split(",").map(trim).filter(Boolean)` over to it:
  `sendEmailNow()`, `emailDoc()`, `sharePdf()`'s desktop mailto: branch.
  `pickRecipient()` (the dropdown-to-textbox add) also now compares
  case-insensitively before pushing, so picking someone already in the box
  in a different case doesn't add them twice.
- **BCC no longer doubles up.** If marks@ ends up in the To list anyway
  (he's still pickable), the guaranteed BCC is skipped for that send so he
  gets exactly one copy, not two — enforced both server-side
  (`send-workorder.js`: `alreadyInTo` check before setting `payload.bcc`)
  and in the two client mailto: builders (`alreadyHasBcc` check before
  appending `&bcc=`), matching the server's logic so the guarantee is
  consistent across every send path.

Tested with `fdb`/sends mocked: confirmed Leak/Service now defaults to
`charlottew@watkinsroofing.net` alone; confirmed every other type's default
is empty; confirmed Mark Sheppard is still a selectable dropdown option;
confirmed picking an already-present recipient (same or different case)
never duplicates it in the box; confirmed `parseEmailRecipients()` collapses
mixed-case duplicates and blanks correctly; confirmed the
already-a-To-recipient BCC-skip logic (identical pattern used client- and
server-side) evaluates correctly for both the "marks@ already in To" and
"marks@ not in To" cases. `email-recipients-v1` removed and page reloaded
clean before finishing.

### RoofMapper: deselect a wrong footprint (shipped 2026-07-10, dev only)

Real gap Mark hit: once a building footprint was selected in RoofMapper,
there was no way to back out of it — if you tapped the wrong building,
you were stuck. Also a related latent bug found while fixing it: tapping a
*different* footprint directly (without an explicit deselect) didn't clear
a previously generated outline either, so it was possible to end up with a
stale outline drawn/stored for the WRONG building.

- Added **"✕ Wrong Building? Choose Again"** next to "Generate Roof
  Outline" in the Selected Building card (`rmDeselectFootprint()`) —
  clears the selection, restyles every footprint back to unselected, hides
  the footprint/outline/features panels, and clears the footprint info
  text. The candidate footprint polygons themselves stay on the map (no
  re-search needed) so picking the right one is immediate.
- Extracted the outline-clearing logic into a shared
  `rmClearGeneratedOutline()` (removes the drawn outline polygon, clears
  `rmState.outline`, clears any building link and its feature markers via
  the existing `rmClearLinkedFeatures()`, hides the outline panel, updates
  the export hint) and now call it from THREE places: a fresh search
  (`rmClearFootprintLayers()`, refactored to delegate to it), **tapping a
  different footprint directly** (`rmSelectFootprint()`, the fix for the
  latent bug above), and the new explicit deselect button. All three now
  behave identically — no path can leave a stale outline behind.
- Purely a local/session-state clear — if the wrong building had already
  been saved to Firestore (outline and/or features), deselecting does NOT
  delete anything already persisted. It only clears what RoofMapper is
  currently pointing at in this browser tab. Correcting a real mistaken
  save is a separate, deliberate action (open that building directly), not
  something a "wrong building" screen should silently attempt.

Tested with `fdb` mocked: selected footprint A, generated an outline for
it, confirmed the deselect button clears `rmState.selectedId`/`outline`/
`outlineLayer`, hides the relevant panels, and leaves the two candidate
footprint layers still on the map; re-selected footprint B and confirmed
the outline generated afterward correctly reflects B, not stale A data;
separately confirmed tapping B directly (skipping the deselect button)
also correctly clears A's outline first; confirmed that after linking A to
a fake building (outline + BCC-mocked save), deselecting clears
`rmState.linkedBuildingId` locally while the already-saved outline entry on
the fake building's data remains untouched (1 entry, not deleted). All test
state removed, page reloaded clean.

### RoofMapper Phase 2.5: place features right on RoofMapper's own map (shipped 2026-07-10, dev only)

Fully realizes "map it, then mark it up on that same roof" — Phase 2 still
opened a separate modal (`#asset-modal`, its own Leaflet map) for placement;
Phase 2.5 replaces that with placement happening directly on `rmState.map`,
no modal at all.

- **Data layer extracted and shared, not duplicated.** `saveAssetFromModal()`/
  `deleteAssetFromModal()`'s Firestore read-modify-write was pulled out into
  `persistRoofAsset(buildingId, roofId, asset)` / `removeRoofAsset(buildingId,
  roofId, assetId)` — both the Building History modal AND RoofMapper's new
  inline placement now call the exact same two functions, so there's one
  place that knows how to persist a roof asset, not two copies that could
  drift apart. Refactor is behavior-preserving by construction (same
  fetch/upsert/write logic, just relocated) — verified the modal path still
  saves/loads/navigates identically.
- **New inline UI, not a rebuilt placement engine.** `rmAddFeature()` and
  `rmEditFeature(assetId)` no longer call `openAssetModal()` at all. Instead:
  a draggable `rmFeatureMarker` is placed directly on `rmState.map` (starting
  at the outline's centroid for a new feature, or the existing lat/lng for an
  edit), a small inline form appears right in the "Roof Features" card
  (Type/Label/Notes + Save/Delete/Cancel, reusing `ROOF_ASSET_TYPES` the same
  way the modal's type select does), and tapping the map repositions the
  marker exactly like the modal's map did. `rmZoomToOutline()` (Phase 2) runs
  automatically when the form opens, so there's always room to work.
  `rmEditFeature()` looks its asset up from `rmState.linkedAssetsCache` (the
  array `rmDrawLinkedAssets()` already fetched to draw the markers) instead
  of a fresh Firestore read — instant open, same pattern as the marker click
  handler that was already there.
- **Idempotent open/close.** `rmOpenFeatureForm()` always clears any previous
  `rmFeatureMarker`/map-click-handler before creating new ones, so tapping a
  different existing marker while already mid-add doesn't stack markers or
  duplicate click listeners — it just cleanly switches to editing that one.
  `rmCloseFeatureForm()` (Cancel, after Save, after Delete) removes the
  marker and the click handler and restores the "+ Add Feature" button.
  `rmClearLinkedFeatures()` (fresh search, switching footprint, loading a
  local outline — see Phase 2/deselect above) now also closes the form, so
  an in-progress add/edit can never be left orphaned pointing at a roof
  RoofMapper is no longer linked to.
- **`assetModalReturnTo` removed.** Phase 2's routing flag (so
  `closeAssetModal()` could redraw RoofMapper instead of rebuilding Building
  History) is now dead code, since RoofMapper never opens that modal at all
  — removed along with its branch in `closeAssetModal()`, which is back to
  its original single-purpose (Building History) form.
- Still correctly out of scope, same reasoning as Phase 2: finding pins
  (leak/repair markup) aren't placeable inline — a pin belongs to a specific
  work order's finding, which RoofMapper still has no context for. Photo
  auto-pin (`maybeAutoPinFinding()`/`maybeAutoPinPhoto()`) is untouched —
  it's part of the work-order photo-capture flow, nothing in this change
  goes near it. Custom (x/y) base-map assets still can't show inline here,
  same lat/lng-only limitation as before — inline-placed features always
  save `lat`/`lng`, never `x`/`y`.

Tested with `fdb` mocked end to end: generated + saved an outline (linking to
a fake building) -> `rmAddFeature()` confirmed the asset modal never opened
and a marker appeared directly on `rmState.map` -> set type/label, dragged
the marker (simulated), saved -> confirmed the asset persisted to the fake
building's `roof_assets[]` and exactly one marker redrew on the map ->
`rmEditFeature()` on that asset confirmed it pre-filled from the cache with
no extra fetch and the marker started at its saved location -> deleted it,
confirmed it's gone from both the fake building's data and the map ->
confirmed Cancel removes the marker with nothing saved -> confirmed
reopening the form (without closing first) replaces the click handler
rather than stacking it, and a map click moves the marker exactly once ->
confirmed a fresh search cleanly closes an in-progress form -> confirmed
the Building History modal path (`openAssetModal`/`saveAssetFromModal`)
still works standalone through the same shared persistence helpers. All
test state removed; page reloaded clean (including restoring the native
`window.confirm` after a temporary auto-confirm stub used for the delete
test).

### RoofMapper Phase 3, part 1: satellite view + manual trace (shipped 2026-07-10, dev only)

Goal: map + mark up a roof even where OpenStreetMap has no building
footprint at all (the real case that prompted this — St. Joseph's Hospital,
whose OSM data has no `building=*` footprint anywhere near it). Shipped in
two pieces; a third (uploading a drone/custom image as the capture canvas)
is explicitly **not built** — see the flag below.

- **Satellite/map toggle.** `rmEnsureMap()`'s single hardcoded OSM tile
  layer became swappable via `rmSetBaseLayer("osm" | "satellite")` /
  `rmToggleBaseLayer()` — same free Esri `World_Imagery` tiles already used
  everywhere else in the app (asset/pin placement), no new or paid service.
  A "🛰️ Switch to Satellite View" / "🗺️ Switch to Map View" button appears
  once a location/search has happened, available at any time (not just
  during a trace) since satellite view is also useful while picking an OSM
  footprint in dense areas.
- **Manual trace.** "✏️ Trace Manually Instead" (next to the satellite
  toggle) auto-switches to satellite and enters trace mode: tap the roof's
  corners in order directly on the SAME `rmState.map` (no separate map
  instance) — each tap adds a point, drawn as a small marker plus a live
  dashed polygon preview; "↩️ Undo Last Point" removes the last one; "✓
  Finish Outline" (needs 3+ points) closes the ring and builds an outline
  object; "✕ Cancel" aborts. Starting a trace, a fresh search, or loading a
  local outline all now cancel any other in-progress trace too, so nothing
  can be left half-finished when the user's attention moves elsewhere.
- **Reuses the outline pipeline, doesn't fork it.** `rmDrawFinalOutline
  (outline)` was extracted from `rmGenerateOutline()` and is now shared by
  both the OSM-footprint path and the new `rmFinishTrace()` — a traced
  outline is `{ ring, center, areaSqFt, perimeterFt, source:"manual_trace",
  osmId:null, osmType:null, tags:{}, isSiteBoundary:false, createdAt }`,
  identical in shape to an OSM-sourced one except `source`/`osmId`/`tags`.
  Area/perimeter use the exact same `rmGeomPolygonAreaSqMeters()`/
  `rmGeomPolygonPerimeterMeters()`/`rmGeomCleanRing()` helpers. Because the
  shape matches, save-to-building, local save, export (SVG/PNG/PDF, outline
  and full-roof alike), and Phase 2.5's inline feature placement all work
  on a manually traced outline with **zero additional code** — verified
  directly by saving a traced outline to a fake building and confirming it
  links/shows a Features panel exactly like an OSM one would.

**Flagged, explicitly NOT built: uploading a drone/custom image as the
capture canvas.** Researched the existing upload path thoroughly
(`renderBaseMapAdminCard`'s `drone_ortho`/`roof_plan`/`sketch` flow,
`resizeImageFile()`, `tools/geotiff_to_webmap.py`) before deciding this,
rather than guessing. The blocker: the ONLY way this app gets a public URL
for an uploaded image is CompanyCam's `upload_document` API, which requires
`bld.companyCamProjectId` to already be set — there's no Firebase Storage
anywhere in this app, and reintroducing it is explicitly gated behind
checking with the user first (see "Push app-added photos to CompanyCam,"
this file). RoofMapper's whole reason to exist is mapping roofs that may
not have a RoofOps building record — let alone a linked CompanyCam project
— yet. Building this properly means Mark deciding one of:
  1. Require picking/creating the building (and linking CompanyCam to it)
     *before* offering an image-upload capture option, inverting
     RoofMapper's current locate-first flow, or
  2. Reintroducing some form of image hosting for this one case.
  Not something to quietly route around — flagging for Mark's call rather
  than forcing a decision that isn't mine to make.

Tested with `fdb` mocked (and none needed for the satellite/trace pieces
themselves — pure client-side Leaflet/geometry, no network calls beyond
tile requests): confirmed the base-layer toggle switches
`rmState.baseLayerType` and the button label both directions; confirmed
starting a trace clears any prior search/outline state and switches to
satellite automatically; confirmed the Finish button stays disabled under 3
points and enables at 3; confirmed Undo removes exactly one point; confirmed
Finish produces a correctly-shaped `manual_trace` outline (ring closed,
area/perimeter computed, title falls back to "Roof Outline" since there are
no OSM tags to draw a name from); confirmed that outline saves to a fake
building and links/shows the Features panel identically to an OSM-sourced
one; confirmed Cancel clears all trace state and hides the panel; confirmed
the OSM-footprint path (`rmGenerateOutline()`) still produces
`source:"osm"` correctly after the `rmDrawFinalOutline()` refactor. All test
state removed, page reloaded clean.

### RoofMapper refinements: fixed duplicate feature markers, added Delete Outline (shipped 2026-07-10, dev only)

Real-world feedback from Mark testing dev mid-build.

**1. Fixed a real bug: editing an existing feature left a duplicate marker
behind.** `rmOpenFeatureForm(existingAsset)` (Phase 2.5) created a new
draggable `rmFeatureMarker` at the SAME lat/lng as the existing marker in
`rmState.assetLayerGroup` without ever hiding the original — so dragging
the new one visibly left a stale, non-draggable ghost marker sitting at the
old spot. This is almost certainly what read as "the icons need to be...
where you can move them around" not actually working. Fixed:
- Each marker in `rmDrawLinkedAssets()` is now tagged `m._rmAssetId = a.id`.
- `rmOpenFeatureForm()` now always redraws the full marker set fresh from
  `rmState.linkedAssetsCache` first (cheap — cache only, no fetch), THEN
  hides only the one specific marker being edited. This guarantees exactly
  one marker is ever missing (the one currently open in the form) — never
  zero, never two — even when switching directly from editing one marker to
  another without closing the form first (verified: editing A, then tapping
  B without saving/canceling A, correctly restores A and hides only B).
- `rmCloseFeatureForm(refresh)` now takes a flag: `true` (Save/Delete — data
  actually changed) triggers a real `rmLoadLinkedAssets()` re-fetch; `false`/
  omitted (Cancel — nothing changed) just redraws from the existing cache,
  restoring whatever was hidden without an unnecessary Firestore read.
  `rmSaveFeature()`/`rmDeleteFeature()` were simplified to a single
  `rmCloseFeatureForm(true)` call instead of a separate close-then-refetch
  pair.
- Delete was already present in the inline form (visible once editing an
  existing feature) — confirmed still there and working; the bug was purely
  the leftover duplicate marker during drag, not a missing delete option.

**2. Added "🗑️ Delete Outline"** in the outline panel (Mark: "there's not
anything to get rid of it... you still don't have the delete button to get
rid of anything that you generate on RoofMapper"). Clears the CURRENT
working outline (drawn polygon, linked-building state, feature markers) via
the existing `rmClearGeneratedOutline()`. Two cases, worded differently in
the confirm dialog so the distinction is explicit rather than assumed:
- **Not yet saved to a building**: "Delete this outline and start over?" —
  clears it, that's the whole story, nothing else to consider.
- **Already saved** (`rmState.linkedBuildingId` set): "...it will NOT remove
  the saved copy from the building's record. Continue?" — clears the
  working screen only. Deliberately does NOT delete the Firestore entry:
  `roof_outlines[]` is an append-only, no-delete-anywhere design (documented
  since Phase 1 as "array is append-only, newest is current" — Building
  History's own Roof Map has no delete-a-saved-outline button either, so
  there's no existing admin-gated mechanism to reuse here). Adding real
  delete-from-Firestore for permanent roof history records is a bigger,
  more consequential decision than this bug-fix pass — flagging it rather
  than quietly building it. Feature (roof_assets) deletion is unaffected by
  this distinction and was already correctly ungated (matches the existing
  "any tech can add/move/remove roof assets, no admin gating" rule) —
  nothing changed there.

Tested with `fdb` mocked: generated+saved an outline with two placed
features (A, B) -> tapping A to edit showed exactly one marker in the
group (B) while A's draggable marker was out on its own -> dragging A and
Canceling restored exactly one marker at A's ORIGINAL position (drag
discarded, confirmed via the underlying data too) -> dragging A and Saving
persisted the new position with exactly one marker on the map afterward ->
switching directly from editing A to editing B (without closing) correctly
showed exactly one marker (A) the whole time, then correctly showed A again
after closing out of B -> deleting a feature removed it from both Firestore
and the map. Delete Outline: confirmed on an UNSAVED outline it clears
`rmState.outline` and hides the panel; confirmed on a SAVED (linked)
outline it clears the local link/view while the fake building's
`roof_outlines[]` entry count stayed at 1 (untouched). Also re-verified the
Building History asset-modal path (`openAssetModal`/`saveAssetFromModal`,
untouched by this change) still saves correctly on its own. All test state
removed, page reloaded clean.

### RoofMapper: surfaced "Clear Base Map" from RoofMapper itself (shipped 2026-07-10, dev only)

Mark wanted to be able to clear a custom base map (roof plan/sketch/drone
ortho) so the roof reverts to satellite, while working from RoofMapper. The
capability already existed -- `renderBaseMapAdminCard()` in Building History
has had a "Clear Base Map" button since the custom-base-map feature shipped,
wired to `clearRoofBaseMap(buildingId, roofId)`, which is admin-gated
(`if (!isAdmin)`) and goes through the same `callAdminApi({action:
"set_building_roof_map", ...roof_base_map_type:null, roof_base_map_url:null})`
server path as setting one. It just wasn't visible from RoofMapper, which is
now where Mark is actually working.

`rmLoadLinkedAssets()` now also reads the linked roof's `roof_base_map_type`
and calls the new `rmRenderBaseMapStatus(baseMapType)`, which shows nothing
when there's no custom base map, or a short explanatory line plus (admin
only, exact same gating as the Building History card) a "🗑️ Clear Base Map
(admin)" button that calls `rmClearBaseMap()` -> the SAME unmodified
`clearRoofBaseMap()` -- reused, not rebuilt or duplicated. The status line
also flags a real, separate limitation worth knowing about: RoofMapper's own
map always shows satellite/street tiles and never switches into the custom
base map's xy/CRS.Simple mode the way the Building History placement modal
does -- clearing the base map has no visual effect on RoofMapper itself, it
only affects placement from Building History. Not fixed here (out of scope
for this ask); noted so it doesn't read as a bug later.

Tested with `fdb`/`callAdminApi` mocked: confirmed the status line and Clear
button are hidden entirely for a non-admin (matches the existing Building
History card's behavior exactly, not just disabled); confirmed both appear
for an admin when a custom base map is set; confirmed clicking Clear
correctly nulls `roof_base_map_type`/`roof_base_map_url` via the existing
admin path and the status line updates to empty afterward; confirmed
`rmClearLinkedFeatures()` (fresh search, etc.) also clears the status line.
All test state removed, page reloaded clean.

### Inspection form overhaul (shipped 2026-07-10, dev only)

Real-world feedback from Mark testing dev — Inspection had been reusing the
generic Leak/Service form with almost no differentiation. Built it out into
a real form.

1. **"Reported Leak Area" removed for Inspection.** Wrapped in
   `#wo-reportedarea-fld`, toggled by `onWoTypeChange()`'s new `isInspection`
   var. Field/schema itself unchanged for every other type.
2. **Findings section relabeled, not removed.** `#wo-findings-title` (an id
   added to what was a static `<h2>`) now reads "Roofing Inspection
   Findings" for Inspection, "Roof Investigation Findings" for everything
   else, set in `onWoTypeChange()`. The section stays fully visible and
   manually-addable ("+ Add Finding" unchanged) — findings on an inspection
   are still added one at a time as the tech works through the roof, same
   as Leak/Service. Not hidden like Repair/Change Order.
3. **Warranty Determination hidden for Inspection too** — extended the
   existing Change-Order-only hide condition (`wdc.style.display`) to
   `(isCO || isInspection)`. An inspection isn't itself a warranty
   determination; that's a separate downstream decision.
4. **Summary field untouched** — already always-visible, no change needed.
5. **New Inspection Checklist** (`#wo-inspection-card`, `#inspection-
   checklist-list`) — the core piece that was missing. A FIXED set of 8
   components (`INSPECTION_CHECKLIST_COMPONENTS`: Membrane/Field,
   Flashings & Terminations, Penetrations, Drainage (incl. Ponding),
   Rooftop Equipment, Perimeter/Edge, Interior (if accessible), Safety
   Hazards), each rated Good/Fair/Poor/Critical/N/A
   (`INSPECTION_RATINGS`) with an optional notes field and an optional
   photo (reuses `findingPhotoGalleryHtml(item)` unmodified — confirmed
   generic, keyed only on `.id`, works for any object with a stable id, not
   specifically a "finding"). `inspectionChecklist` (module var, mirrors
   `repairItems`'s pattern) is NOT addable/removable like `repairItems` —
   `ensureInspectionChecklist()` backfills all 8 in canonical order for any
   Inspection order, old or new, so a tech always sees the same fixed
   checklist and just rates what applies, N/A for what doesn't.
   - **"Anything rated below Good surfaces as a finding"** (Mark's exact
     ask) — `syncInspectionFinding(item)` runs on every rating/notes edit:
     if the new rating is Fair/Poor/Critical, it creates-or-updates ONE
     finding in `findings[]` (condition = "`<component>`: `<rating>` —
     `<notes>`", location = component label, warranty = "Undetermined"),
     tracked via the checklist item's new `linkedFindingId`. If the rating
     goes back to Good/N/A, that linked finding is removed and the link
     cleared. This is one-way (checklist → findings) and scoped to ONLY the
     finding it created itself — a tech's manually-added findings are
     completely untouched by it, verified directly (added one manually,
     changed a checklist rating, confirmed both coexist independently and
     the manual one's text was never touched).
   - Both `addPhotosFromFiles()`/`addPhotosFromCamera()`'s completion
     callbacks, and the CompanyCam-import completion path in the CC modal,
     now check `inspectionChecklistItemById(findingId)` (a new tiny lookup,
     mirroring `findingById()`) alongside the existing `findingById()`
     check, calling `renderInspectionChecklist()` when a photo was added to
     a checklist item specifically — otherwise a photo added to a checklist
     row's gallery wouldn't visually appear until something else happened
     to re-render the checklist.
6. **Multi-roof roof selection.** There was NO roof-picker anywhere on the
   main work-order Edit form before this — the only existing one
   (`renderPinRoofPicker()`) lives inside the pin-placement modal, reached
   only once a tech places a pin. Added `renderInspectionRoofPicker()`
   (mirrors that exact pattern -- same `lookupProspectiveBuildingRoofInfo()`
   lookup, same `<select>` markup) directly on the Inspection card, writing
   straight to the same `currentRoofId` the pin picker already uses, so it
   round-trips through `collect()`/`fill()` (`o.roofId`) with zero changes
   to either function. Only ever shows up once the resolved building
   actually has more than one roof (single-roof buildings see nothing,
   same as the pin picker). Since the lookup depends on Job Name/Bill To
   already being filled in (same constraint `lookupProspectiveBuildingRoofInfo()`
   already had), `refreshInspectionRoofPickerIfNeeded()` was hooked onto
   both fields' existing `onblur` handlers (only actually does the async
   lookup when `woType === "Inspection"`, a no-op otherwise) so the picker
   catches up once enough info exists to resolve the building, not just at
   initial type-selection time.
7. **Report output** (`buildLeakReportText()`, `renderLeakReportDoc()`,
   `generateLeakReportPdf()`) — all three gained an `isInspection` branch:
   title becomes "Roofing Inspection Report" (was falling through to the
   generic Leak title before); Reported Leak Area row omitted from Job
   Information; a new Inspection Checklist table (Component/Condition/
   Notes, all 8 rows always) renders before the findings table; the
   findings heading is relabeled the same way as the edit form; Warranty
   Determination is omitted entirely (not just self-hidden-when-blank like
   before). Findings themselves needed NO new rendering code — Inspection
   already fell through to the same shared findings-table path Leak/Service
   uses (only Repair and Change Order branch away from it), so the
   checklist's auto-surfaced findings and any manually-added ones both show
   up there automatically.

**Kept intentionally scoped, per the ask**: rating+notes checklist only —
no health-score rollup or weighted scoring across components (flagged as a
natural follow-up if it grows into something bigger, not attempted here).

Tested with `fdb`/`callAdminApi`/`confirm` mocked, extensively: confirmed
field visibility for Inspection (reportedArea hidden, warranty hidden,
inspection card shown, findings card shown+relabeled) and confirmed all 4
OTHER types are completely unaffected (reportedArea still visible,
inspection card still hidden, findings title unchanged) after these
changes; confirmed the checklist renders all 8 rows with working rating/
notes inputs; confirmed rating a component below Good auto-creates exactly
one finding with the right text, editing notes afterward updates that SAME
finding (no duplicate), and reverting to Good removes it and clears the
link; confirmed a manually-added finding is completely unaffected by
checklist syncing running alongside it; confirmed the full `collect()`/
`fill()` round-trip (save an Inspection order with checklist+findings data,
load a DIFFERENT type over it to create stale state, then load the saved
Inspection order back) correctly restores the checklist, findings, roof
link, and field visibility — this specifically exercises a real ordering
fix in `fill()` (`inspectionChecklist` must be set from the loaded data
BEFORE `onWoTypeChange()` runs, since that's what renders it); confirmed
the multi-roof picker resolves a mocked multi-roof building, defaults to
the first roof, and correctly updates `currentRoofId` (verified it
round-trips through `collect()`) when a different roof is picked; confirmed
all three report outputs (text/HTML/PDF) render the checklist table,
relabeled findings heading, and correctly omit Reported Leak Area and
Warranty Determination -- PDF generation itself ran end-to-end with no
errors. Hit and recovered from one test-harness snag (a stubbed `newOrder()`
call triggered a real blocking `confirm()` dialog that froze the headless
preview — recovered by forcing a fresh navigation, then re-ran the test with
`window.confirm` properly stubbed first; not a product bug, purely a testing
sequencing mistake on my part). All test state removed, page reloaded clean
with a final regression pass confirming Leak/Service, Change Order, Repair,
and Warranty are all still exactly as they were before this feature.

### RoofMapper Phase 3, part 2: "Walk the Corners" GPS capture (shipped 2026-07-10, dev only)

Third RoofMapper outline-capture method, alongside OSM footprint search and
manual trace (both re-verified still working correctly first, per Mark's
ask -- see "RoofMapper Phase 3, part 1" above, no regressions from
subsequent Phase 2.5/base-map/delete-outline work). For a roof where
neither OSM nor satellite imagery is good enough to search or trace: walk
to each corner of the building, tap "📍 Record This Corner," repeat, tap
Finish.

**Reused the trace engine instead of building a second one.** Manual trace
and walk-the-corners are now two entry points into the SAME
`rmTraceState`/`rmTraceAddPoint()`/`rmRenderTracePreview()`/
`rmUpdateTraceButtons()`/`rmTraceUndo()`/`rmCancelTrace()`/`rmFinishTrace()`
machinery -- `rmTraceState.mode` ("manual" | "walk") is the only thing that
differs:
- Manual trace (`rmStartManualTrace()`) attaches a map-click handler; points
  come from tapping the satellite map.
- Walk-the-corners (`rmStartWalkCorners()`) attaches NO map-click handler at
  all -- `rmWalkRecordCorner()` calls the existing `rmGeoRequest()` (the
  same geolocation wrapper `rmUseMyLocation()` already uses, same error
  handling) and feeds the result into the identical `rmTraceAddPoint()`
  manual trace's map-click handler calls. One shared "add a point, redraw
  the preview, update Finish/Undo state" path regardless of where the point
  came from.
- `rmFinishTrace()` tags the resulting outline `source: "walk_corners"`
  (vs. `"manual_trace"`) -- otherwise byte-identical shape to every other
  capture method (`ring`/`center`/`areaSqFt`/`perimeterFt`/`isSiteBoundary`/
  `createdAt`, no `tags`/`osmId`), so save, export, and Phase 2.5's inline
  feature placement all work on a walked-corners outline with zero
  additional code -- verified directly (saved one to a fake building,
  confirmed it links and shows the Features panel exactly like any other
  outline).
- `rmShowTracePanel()` swaps the panel's title/hint text and shows/hides
  the "📍 Record This Corner" button based on `rmTraceState.mode`, so the
  same `#rm-trace-panel` card serves both methods without duplicating markup.
- **Accuracy reality flagged directly in the UI**, not just in a doc:
  the walk-mode hint text states consumer GPS is "roughly ±10–30 ft per
  corner... not survey-grade," and each recorded corner's actual accuracy
  (`position.coords.accuracy`, converted to feet) shows in the confirmation
  toast, so the tech gets live feedback on how rough that specific corner's
  fix was, not just a generic warning up front.
- Auto-pan-to-latest-point on the map is scoped to walk mode only
  (`rmRenderTracePreview()` checks `rmTraceState.mode === "walk"`) --
  manual trace deliberately does NOT auto-pan, since the tech is
  intentionally tapping a fixed view there and yanking the map after every
  tap would fight their own panning/zooming. Walk mode benefits from it
  (keeps the growing polygon in view while physically walking around a
  building); manual trace would find it actively annoying.

Tested with `navigator.geolocation.getCurrentPosition` mocked (no real GPS
needed): confirmed starting walk-corners switches to satellite, shows the
Record button, hides it for manual trace and vice versa; confirmed
recording corners correctly disables Finish under 3 points and enables it
at 3+; confirmed Undo removes exactly one point; confirmed Finish produces
a `source:"walk_corners"` outline with a correctly closed ring and
computed area; confirmed that outline saves to a fake building and links
into the Features panel identically to OSM/manual-trace outlines; confirmed
Cancel clears all state including resetting `rmTraceState.mode` back to
"manual"; confirmed a geolocation error (permission denied) is handled
gracefully -- no point added, button re-enabled, no crash; confirmed manual
trace still works correctly and independently afterward (shares the engine
but the two modes don't interfere with each other). All test state removed,
page reloaded clean.

## Outlook / Microsoft 365 — delegated auth (Phase 0 of delegated, dev-only, pending redirect URI registration)

The app-only (client-credentials) Graph integration above is read/write for
mail as *the app itself*, not as Mark — and Microsoft Graph does not expose
Outlook inbox rules (`messageRules`) to application permissions **at all**.
Confirmed empirically, not just from docs: every `messageRules` POST under
the app-only token returned `403 ErrorAccessDenied`, while every other Graph
call (folders, messages, moves) succeeded under the *identical* token
immediately before and after — that's the signature of a hard permission-
model wall, not a missing scope/consent. OneDrive/Excel/Word "as Mark" have
the same requirement — those APIs work delegated-only for a personal
mailbox/drive. This phase adds the **delegated** ("acts as you")
authorization-code OAuth flow, alongside (not replacing) the app-only flow —
both live on the same Azure app registration, just two different grant
types.

**New files** (mirror the app-only files' structure/conventions):
- `netlify/functions/lib/graphDelegatedAuth.js` — the auth helper: builds/
  validates the OAuth `state` param, exchanges an authorization code for
  tokens, refreshes an access token from a stored refresh token (persisting
  any *rotated* refresh token Azure AD issues back to Firestore — see
  below), and `graphFetchDelegated()`, a delegated-token equivalent of
  `lib/graphAuth.js`'s `graphFetch()`.
- `netlify/functions/ms-auth-start.js` — Mark visits this URL directly (a
  plain link, no UI needed) and gets a `302` to Microsoft's sign-in page.
  Sign-in URLs:
  `https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-start`
  (prod) / `https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-start`
  (dev).
- `netlify/functions/ms-auth-callback.js` — Microsoft redirects back here
  with an authorization code; this exchanges it server-side for an access +
  refresh token, confirms identity with a lightweight `GET /me`, and stores
  the refresh token. Returns a plain confirmation HTML page — never echoes
  any token back to the browser.

**Redirect URIs are hardcoded, not env-configurable** — Azure AD rejects
any `redirect_uri` that doesn't exactly match what's registered on the app
registration, so a typo'd env var would silently break sign-in in a
confusing way. Instead `resolveRedirectUri()` allow-lists exactly two
request hosts and maps each to its exact, fixed callback URL:
`leak-work-orders.netlify.app` → prod callback, `dev--leak-work-orders.netlify.app`
→ dev callback. Any other host (including a similar-looking spoof like
`leak-work-orders.netlify.app.evil.com`) is rejected outright rather than
used to build a URL. **These same two exact strings need to be registered
in Azure AD → App registrations → this app → Authentication → Web platform
→ Redirect URIs — Steve (the M365/domain admin, see "Outlook / Microsoft
365 integration" above) needs to add them.** Until he does, `ms-auth-start`
will redirect fine, but Microsoft will reject the sign-in with a redirect-
URI-mismatch error at the consent screen. **This step is the one thing not
yet done — everything else in this phase is built and unit-tested.**

**State CSRF protection is stateless** (no server-side session to store a
nonce in, since this is plain serverless functions) — `signState()`
produces `base64url(timestamp + "." + HMAC-SHA256(timestamp))`, keyed by
`GRAPH_CLIENT_SECRET` (intentionally reused — it's already a secret only
the server holds; a separate state-signing secret would be one more env
var to manage for no real security gain in this single-admin-user
context). `verifyState()` recomputes the HMAC and rejects if it doesn't
match (`crypto.timingSafeEqual`, not `===`, to avoid a timing side-channel)
or if the timestamp is more than 10 minutes old (replay protection).

**Refresh token storage: Firestore, `secrets/ms_graph_delegated`, Admin-SDK-only.**
Considered and rejected a Netlify env var instead — env vars are
deploy-time/static in Netlify, but Azure AD v2 **rotates the refresh token
on most refreshes** when `offline_access` is granted, so the stored value
needs to be updatable at runtime, which only a real database supports.
Firestore was the natural choice since it's already the app's database and
`admin.js` already established the exact pattern needed (Firebase Admin
SDK, bypasses Firestore security rules entirely, gated by which Netlify
function code paths call it — never by a client-supplied credential).
`firestore.rules` (repo root) has an explicit
`match /secrets/{secretId} { allow read, write: if false; }` block — belt
and suspenders on top of Firestore's own implicit deny-by-default for any
collection with no matching rule, so a future edit to this file can't
accidentally expose it. The refresh token itself is never returned to the
browser, logged, or written to any file outside Firestore.

**Testing done without a live interactive sign-in** (can't get a real
authorization `code` until Steve registers the redirect URIs and someone
actually completes the Microsoft sign-in prompt): 23 unit tests against
the actual pure logic (redirect-URI allow-listing including a spoofed-
subdomain rejection case; state sign/verify round-trip, tamper rejection,
expiry, wrong-secret rejection; authorize-URL structural correctness —
exact scope string, exact redirect_uri, tenant/client_id round-trip), all
passing, plus a live read-only check against the tenant's own OIDC
discovery document confirming the authorize/token endpoint URLs Graph
expects match exactly what this code builds. One interesting non-bug found
while testing: appending characters to the end of a `state` value doesn't
always get rejected — `base64url`/`hex` decoding in Node/Deno silently
drops a trailing *incomplete* group rather than erroring, so a small
amount of trailing noise can decode to the exact same payload. Confirmed
this is not a forgery vector (mid-string tampering, which *does* change
the decoded payload, is correctly rejected every time) — an attacker still
cannot produce a *different* valid timestamp/signature pair without
`GRAPH_CLIENT_SECRET`. **Not tested at all yet, pending the redirect URI
registration**: the actual authorization-code exchange, refresh-token
persistence against real Firestore (no local service-account credentials
in the environment this was built in), and refresh-token rotation over
real repeated use.

**Required env vars**: same `GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`
as the app-only integration (same app registration, different grant type —
nothing new to add there) plus `FIREBASE_SERVICE_ACCOUNT` (already required
for `admin.js`). No new env vars.

**Not built yet, deliberately**: nothing calls `graphFetchDelegated()` for
anything real yet — no OneDrive/Excel/Word feature, no inbox-rules
creation using it. This phase is scoped to "get delegated auth working
end-to-end so a stored, refreshable token exists" per the task that
specced it; wiring an actual feature on top (starting with the 33-rule
inbox-rules spec drafted in the app-only section above, once delegated
auth is confirmed live) is the next phase, not this one.

### Inspection checklist photo pinning (shipped 2026-07-10, dev only)

Mark testing the Inspection form live on dev: refined how each checklist
item's photo capture should work.

1. **Removed "+ Add Photos" (library) and "Import from CompanyCam"** from
   every checklist item — only **"📷 Take Photo"** (in-app camera) remains.
   Mark: the tech is photographing the specific condition they're looking
   at and rating right there, not attaching photos from elsewhere. New
   `inspectionItemPhotoGalleryHtml(item)` — a copy of the existing
   `findingPhotoGalleryHtml(f)` with the library-add and CompanyCam-import
   buttons/inputs removed, everything else (thumbnail strip, caption,
   Remove) unchanged. `renderInspectionChecklist()` calls this instead of
   `findingPhotoGalleryHtml()` now; findings themselves are completely
   unaffected (still get all three options).
2. **Auto-pin on capture.** Each checklist item now has its own `pin`
   field (`{lat,lng,x,y,source}`, same shape `finding.pin` already uses),
   independent of `linkedFindingId`/`findings[]` entirely — so it's set
   regardless of rating, not just when a condition is below Good. New
   `maybeAutoPinInspectionItem(photo)` mirrors `maybeAutoPinFinding()`
   exactly (same never-overwrite rule: a tech's first photo sets it, later
   photos never move it): checks `inspectionChecklistItemById(photo.
   finding_id)` instead of `findingById()`. `addPhotosFromCamera()`'s
   completion callback now calls both `maybeAutoPinFinding(r)` and
   `maybeAutoPinInspectionItem(r)` whenever a `findingId` was passed —
   exactly one of them ever actually does anything, since each checks its
   own array and no-ops otherwise. (`addPhotosFromFiles()`, the library-add
   path, was NOT touched here since checklist items no longer have a UI
   path into it at all.)
3. **Pin shows on the Roof Map, not just saved data.** `buildPinsForHistoryEvent(o)`
   — the function that turns a saved work order's pins into what
   `building_history_events[].pins[]` (and from there, the building's Roof
   Map) actually renders — now also pulls pins from `o.inspectionChecklist`
   alongside `o.findings`, synthesizing the same pin shape (`condition` =
   "`<component label>`: `<rating>`", `warranty: ""` since that's not a
   checklist concept — `warrantyColor("")` already falls through to the
   same neutral/yellow default other non-warranty-rated pins get). This is
   what makes a checklist photo's pin "reviewable by someone else" — it's
   not just stored on the work order, it shows up on the building's roof
   map exactly like a finding's pin would.
4. **Found and fixed two related pre-existing-pattern gaps** while
   building this: (a) `removePhoto()` only called `renderFindings()` when
   a removed photo had a `finding_id` — extended to also check
   `inspectionChecklistItemById()` and call `renderInspectionChecklist()`,
   otherwise a checklist item's photo strip (and its "📍 Pinned..." hint)
   would go stale after removing one of its photos. (b) `renderPhotos()`'s
   global Photo Documentation section has a "Finding:" reassignment
   dropdown per photo, built only from `findings[]` — a checklist item's
   photo would fall through to showing "General / no specific finding"
   there (misleading) and risked being reassigned away by accident.
   Extended `findingOptions` to also list checklist items ("Checklist:
   `<component>`"), and the dropdown's change handler now calls
   `maybeAutoPinInspectionItem(p)` alongside `maybeAutoPinFinding(p)` too,
   for the same "exactly one actually does something" reasoning as above.
5. **`ensureInspectionChecklist()`** now also seeds `pin: null` on newly
   created items and self-heals it (`if (item.pin === undefined) item.pin
   = null;`) for any item saved before this shipped — same defensive
   pattern `fill()` already uses for findings' `pin` field.

**Roadmap note, not built here**: this pin is explicitly the "before" half
of a before/after comparison capability — see "Inspection checklist
photo pinning: before/after-at-a-pin" in `ROADMAP.md`. The pin is the
anchor; an actual side-by-side before/after comparison view (matching a
later repair photo at the same pin against this inspection photo) is
future work, not attempted here.

Tested with `navigator.geolocation.getCurrentPosition` and a real 1x1 PNG
`File` mocked (no real GPS/camera needed): confirmed a checklist item's
photo gallery shows only Take Photo, no Add Photos/Import from CompanyCam;
confirmed capturing a photo via `addPhotosFromCamera()` correctly sets the
item's `pin` from the mocked GPS coords; confirmed the "📍 Pinned on the
roof map..." hint and photo thumbnail both appear after capture; confirmed
a SECOND photo capture with different mocked GPS does NOT move the
already-set pin (never-overwrite rule holds); confirmed
`buildPinsForHistoryEvent()` correctly includes the checklist item's pin
with the right condition text/coordinates; confirmed removing one of a
checklist item's two photos correctly refreshes its gallery and leaves the
pin untouched; confirmed the global photo section's Finding dropdown lists
the checklist item as "Checklist: Membrane / Field"; confirmed a full
`collect()`/`fill()` round-trip preserves a checklist item's `pin`
correctly; confirmed findings (Leak/Service) are completely unaffected --
still show all three photo options. All test state removed, page reloaded
clean.

### RoofMapper UI cleanup: contextual controls + per-edge dimensions (shipped 2026-07-10, dev only)

Mark's feedback tracing an outline live on dev.

**1-4: contextual control visibility, centralized.** Search-again buttons
(Search This Area/Wider/Relocate) stayed on screen after tracing started;
mode buttons (satellite/trace/walk) were full-width `rm-bigbtn`s when they
should be small/secondary; trace controls (Undo/Finish/Cancel/Record) lived
in a separate card far enough below the map that reaching Undo mid-trace
needed a scroll; and once an outline was saved, all of the earlier
capture-phase controls stayed cluttering the screen instead of getting out
of the way for feature placement. Fixed as one coherent state model instead
of four separate patches:
- New `rmUpdateControlVisibility()` — reads `rmState.lat`/`rmTraceState.
  active`/`rmState.outline`/`rmState.linkedBuildingId` and sets exactly
  four things: `#rm-search-again-wrap`+hint (visible only while located,
  no outline yet, not tracing), `#rm-basemap-wrap`+hint (visible once
  located, gone once saved), `#rm-trace-btn`/`#rm-walk-btn` specifically
  (hidden while already mid-trace — starting a NEW capture mid-trace
  doesn't make sense, but the satellite toggle stays available), and
  `#rm-trace-panel` itself (visible only while `rmTraceState.active`).
  Also force-hides `#rm-footprint-panel` once saved (doesn't touch its
  normal show/hide otherwise -- that's still driven by footprint
  selection). Called from every phase-transition point:
  `rmUseMyLocation()`/`rmSearchBuildings()` (replacing what used to be
  direct, scattered `style.display` sets), `rmClearGeneratedOutline()`
  (fresh search / switch footprint / delete outline), `rmDrawFinalOutline()`
  (outline generated or traced), `rmShowTracePanel()` (trace started),
  `rmCancelTrace()` (trace ended), `rmSaveOutlineToBuilding()` (saved), and
  `rmLoadLocalOutline()` (loaded a local save).
- **HTML restructure**: `#rm-trace-panel`'s content moved from its own
  separate `<div class="card">` to living directly inside the main map
  card, right after `#rm-map` — verified directly (`compareDocumentPosition`)
  that it's now in the same parent as the map, not several DOM siblings
  away. `#rm-basemap-wrap` changed from `class="rm-actions"` (column,
  `rm-bigbtn` children -- full width, 52px tall) to `class="btnrow"` with
  plain `class="btn"` buttons (row, wraps, ~13px/8px-padding sizing --
  same as the delete buttons elsewhere) and shortened button text
  ("🛰️ Satellite View" instead of "🛰️ Switch to Satellite View", etc.,
  including `rmSetBaseLayer()`'s dynamic toggle text) so three buttons fit
  comfortably in one row.
- **`#rm-features-panel` moved earlier in DOM order** — now sits
  immediately after the map card (verified: `mapCard.nextElementSibling
  === featuresPanel`), ahead of `#rm-footprint-panel`/`#rm-outline-panel`.
  It's already `display:none` until linked, so this has zero effect on the
  pre-save flow — but once `rmSaveOutlineToBuilding()` succeeds and hides
  the search/mode/footprint clutter, Roof Features is the very next visible
  thing below the map, exactly matching Mark: "after I saved it, the add
  features should just pop up right below the map." The old duplicate
  `#rm-features-panel` block (previously positioned after the outline
  panel) was removed, not left as dead markup.

**5: per-edge dimensions on the map.** New `rmDrawEdgeDimensions(outline)`
— one small dark label per edge (`L.divIcon`, non-interactive), positioned
at that edge's midpoint, reading its length in feet, computed with the
exact same `rmGeomHaversineMeters()` helper the perimeter total already
uses (so the labels always sum to the displayed perimeter, no separate/
divergent calculation). Drawn on `rmState.dimensionLayerGroup`, called
alongside every place an outline gets drawn (`rmDrawFinalOutline()` — OSM
footprint or trace/walk-corners alike — and `rmLoadLocalOutline()`), and
cleared alongside the outline layer itself in `rmClearGeneratedOutline()`
so nothing lingers after Delete Outline or a fresh search. This is the base
"automatic per-edge perimeter dimensions" piece of the Dimensions roadmap
item — area and perimeter totals are unchanged, this adds the per-edge
breakdown on top. The tap-to-edit-one-edge-and-rescale calibration (see
"Calibrate-by-known-edge" in `ROADMAP.md`) is NOT built here — these labels
are read-only for now, still purely GPS/geometry-derived.

Tested with mocked footprint/trace/walk-corners data (no real GPS/network):
confirmed the "located" state shows search+mode buttons with trace panel
hidden; confirmed generating an outline hides search buttons while mode
buttons and the footprint panel stay visible, and produces exactly one
dimension label per edge with correct lengths (verified a rectangle's
opposite edges compute equal lengths); confirmed starting a manual trace
hides search buttons, hides Trace/Walk (keeps the satellite toggle), and
shows the trace panel in the same card as the map (not a separate one);
confirmed finishing a trace restores Trace/Walk, hides the trace panel, and
draws the correct number of dimension labels for the traced shape;
confirmed saving hides search/mode buttons and the footprint panel, and
that the now-visible Roof Features panel is the map card's very next DOM
sibling; confirmed Delete Outline restores search/mode buttons and clears
the dimension layer group with nothing lingering; confirmed walk-the-corners
goes through the identical trace-panel/dimension pipeline (source tagged
`walk_corners`, correct label count). All test state removed, page reloaded
clean.

### In-app signature capture (shipped 2026-07-10, dev only)

Goal: capture a real signature on the device screen and embed it into a PDF,
starting with the Change Order, built as a reusable component so other forms
(leak/non-warranty service-order signing) can adopt it later.

**Reusable signature-pad component** — `sigPadState` + `openSignaturePad(opts)`/
`closeSignaturePad()`/`sigPadClear()`/`sigPadSave()`, plumbing-agnostic about
what calls it:
- `#signature-modal` — same `position:fixed;inset:0;z-index:9999` modal
  pattern as `#pin-modal`/`#asset-modal`, with a `<canvas id="signature-canvas">`
  the signer draws on (pointer events — `pointerdown`/`pointermove`/`pointerup`/
  `pointerleave` — covers touch, pen, and mouse in one handler set, no separate
  touch listeners needed), a Clear button, a "Print Name" text input, and an
  auto-filled date display (`todayStr()`, the same `M/D/YY` helper photos/work
  orders already use).
- Canvas backing store is sized to `getBoundingClientRect() × devicePixelRatio`
  (set in a `setTimeout(…, 30)` after the modal becomes visible, since
  `getBoundingClientRect()` returns zeros on a `display:none` element) —
  crisp strokes at any pixel density. This is a different pattern from photo
  handling (`resizeImageFile()` etc.), which resizes FROM an arbitrary source
  image; here there's no source image, just a blank drawing surface to size.
- Saved as **PNG**, not JPEG — deliberate: a signature is sparse black ink
  strokes on white, and JPEG's lossy compression puts visible artifacts around
  thin lines for no size benefit (PNG compresses this content tiny anyway —
  measured ~6KB for a real test signature vs. a full-photo JPEG in the tens of
  KB).
- `openSignaturePad(opts)` takes `{ title, existing: {img, printName}, onSave }`
  — `title` sets the modal header per calling form, `existing` pre-fills the
  canvas (draws the prior signature image onto it) and the Print Name field
  for a "re-sign" flow, and `onSave` is a callback invoked with
  `{img, printName, date}` once the user saves (validated: won't save with an
  empty canvas or a blank Print Name). Nothing in the pad itself knows about
  Change Orders — a future caller just passes its own `title`/`existing`/
  `onSave`.

**Change Order wiring** — thin consumer layer on top of the reusable pad:
`changeOrderSignature` (module var, `null` until signed, else
`{img, printName, date}` — see `DATA_MODEL.md`), `renderChangeOrderSignature()`
(swaps `#co-signature-status` between a "✍️ Get Signature" button and a
signed-state summary + thumbnail + Re-sign/Clear Signature buttons),
`openChangeOrderSignaturePad()` (calls `openSignaturePad()` with
`title: "Change Order Signature"`, `existing: changeOrderSignature`, and an
`onSave` that sets `changeOrderSignature` and re-renders), and
`clearChangeOrderSignature()` (confirm-gated removal, matching the
confirm-before-destroy convention used elsewhere for findings/repairs/photos).
Round-trips through `collect()`/`fill()` exactly like `companyCamProjectId` —
one line each, additive.

**All three Change Order outputs updated, each with a signed/unsigned
branch, unsigned branch byte-for-byte the original markup**:
- `generateChangeOrderPdf(o)` — `doc.addImage(o.changeOrderSignature.img,
  "PNG", …)` at a fixed 220×50 box above the Print Name/Date line, wrapped in
  try/catch (same defensive pattern as the logo image already in this
  function) so a corrupt/oversized data-URL can't break PDF generation
  entirely — falls through to no image rather than throwing. Page-break
  threshold at this point bumped from `H - M - 70` to `H - M - 100` to make
  room for the taller signed block. Unsigned: unchanged blank
  `Approved By ___  Date ___` lines.
- `renderChangeOrderDoc(o)` (HTML preview) — signed renders an `<img>` plus
  "Print Name: …" and "Date: …" lines in `.co-sig`; unsigned renders the
  original `Approved By: <span></span>` / `Date: <span></span>` markup
  unchanged.
- `buildChangeOrderText(o)` (plain-text/email body) — signed renders
  `"Signed by: <name>   Date: <date>  (signature captured on device — see
  attached PDF)"`; unsigned renders the original
  `"Approved by: _______________________________   Date: ______________"`
  line unchanged.

**Reusability note for future wiring**: to add signing to another form (e.g.
leak/non-warranty service-order signing, once email-doc-attach lands), call
`openSignaturePad({title, existing, onSave})` from that form's own action
button, store the result under a form-appropriate field name (mirroring
`changeOrderSignature`'s shape), and add the same signed/unsigned branch to
that form's own PDF/HTML/text builders — the pad itself needs no changes.

Tested with mocked data, no real Firestore writes: drew a real signature via
dispatched `PointerEvent`s on the canvas, entered a Print Name, saved, and
confirmed `changeOrderSignature` held the expected `{img, printName, date}`
shape (`~6KB` PNG data-URL); confirmed a `collect()` → switch to a different
work order type (clearing module state) → `fill()` round-trip restored the
exact same signature data and re-rendered the signed-state UI; generated a
real PDF with a signature present (640KB output, `doc.addImage` succeeded,
still 1 page — no page-break regression) and with `changeOrderSignature:
null` (78KB output, confirming the image is what drove the size difference,
still 1 page); confirmed the unsigned PDF, HTML doc, and plain text all
produce byte-for-byte the original blank-signature-line markup (isolated the
`.co-sig` block specifically to rule out an unrelated `<img>` elsewhere in
the doc, e.g. the logo); confirmed Re-sign pre-fills both the canvas
(drawing the existing signature image onto it) and the Print Name field;
confirmed Clear Signature is confirm-gated and correctly nulls
`changeOrderSignature`; confirmed the signature section only ever renders
inside `#wo-changeorder-card`, which stays `display:none` for every
non-Change-Order work order type (checked Leak/Service and Inspection) — no
signature UI leaks onto other forms. All test state cleared, page reloaded,
console clean.

### Self-scaling dimension calibration (calibrate-by-known-edge, shipped 2026-07-10, dev only)

The last piece of the Dimensions roadmap item — per-edge labels (shipped
earlier the same day) were read-only; this makes them the calibration
mechanism itself. Mark's exact UX: tap ONE edge's dimension label, type in
the real tape-measured length, and the whole outline rescales proportionally
off that one edge — every other edge, area, and perimeter update to match.
One field measurement, one edit, the whole footprint becomes accurate.

**Geometry**: two small additions next to the existing local-XY helpers —
`rmGeomFromLocalXY(xy, origin)` (inverse of the existing `rmGeomToLocalXY`,
turns a meters-from-origin offset back into `{lat,lng}`) and
`rmGeomScalePoint(point, origin, factor)` (round-trips a point through
local XY, scaling its offset from `origin` by `factor`, origin itself
unmoved). `rmCalibrateEdge(edgeIndex)` is the entry point: computes the
tapped edge's current haversine length in feet, `prompt()`s for the real
length (pre-filled with the current rounded value — same lightweight
`prompt()` pattern already used for the admin PIN and new-roof naming, no
new modal needed), then computes `factor = measuredFt / currentFt` and
scales every ring point about the ring's own **freshly recomputed**
centroid (`rmGeomRingCentroid(ring)`, not the outline's original `center`)
by that factor. A uniform scale about the centroid preserves the shape
exactly (same angles/proportions, only size changes) — matches "rescales
proportionally" precisely. Recomputing the centroid fresh on every call
(rather than reusing a stored one) is what makes recalibrating a second
time — off the same edge again, or a different one — compound correctly
with no drift, since each calibration is a clean similarity transform of
the shape as it currently stands. `areaSqFt`/`perimeterFt` are recomputed
from the new ring with the exact same helpers the rest of RoofMapper
already uses, so they never diverge from what's drawn.

**UI**: `rmDrawEdgeDimensions(outline)` (existing, from the earlier
per-edge-labels ship) now makes every label `interactive:true` with an
`onclick` bound to its own edge index via closure, and reads
`outline.calibration.edgeIndex` to render that one label with a green
background + white border + a leading checkmark — "which edge was
calibrated" stays visibly marked on the map itself, through every redraw,
until a different edge is calibrated (`rmCalibrateEdge` always overwrites
`outline.calibration` to point at whichever edge was tapped most
recently — tapping a different label re-calibrates off that edge instead,
no separate mode toggle needed).

**Works on any outline** (OSM footprint, manual trace, or walk-the-corners)
since it only touches `outline.ring`/`.calibration` — no `source`-specific
branching anywhere in the calibration path.

**Linked features stay anchored**: if the outline is already linked to a
saved roof with placed features (`rmState.linkedAssetsCache` non-empty —
e.g. re-calibrating a previously-saved roof that already has drains/HVAC
placed), each asset's `{lat,lng}` is scaled through the identical
`rmGeomScalePoint()` transform about the same centroid/factor, so
everything on the roof rescales together instead of the outline moving out
from under previously-placed markers. Redrawn via the existing
`rmDrawLinkedAssets()`.

**Persistence**: calibrating BEFORE the first save just updates
`rmState.outline` in memory — the next "Save Outline" tap picks up the
calibrated ring like any other edit, no separate write. Calibrating an
outline that's **already saved** writes immediately: `rmSaveOutlineToBuilding()`
now stamps the saved entry's id back onto `rmState.outline.id` (one-line
addition — previously only the Firestore copy got an id, the in-memory
outline never did), so `rmCalibrateEdge()`'s persistence step
(`rmPersistCalibration()`) can find that exact `roof_outlines[]` entry by
id, replace its `ring`/`areaSqFt`/`perimeterFt`/`center`/`calibration`, and
(if features were rescaled too) `roof_assets`, then write through the same
`saveBuildingRoofs()` every other roof edit already uses. An outline with
no `.id` yet (never saved) or no linked building skips the write entirely
and just toasts that it'll save with the outline — never attempts a
premature/dangling write.

Tested with mocked geometry (a plain rectangle, no real GPS/map/Firestore):
calibrated a 100×60ft outline's 100ft edge to a real 120ft measurement,
confirmed the adjacent edge scaled to exactly 72ft (proportional, matching
the 1.2× factor) and perimeter scaled to exactly 384ft (320×1.2), with area
scaling to the expected ~1.44× (small sub-1% variance vs. the theoretical
value is the pre-existing flat-earth local-XY approximation re-projecting
through two different centroids, not a calibration bug — same approximation
already documented on `rmGeomToLocalXY`); confirmed recalibrating a second
time off a *different* edge compounds correctly (verified against hand
calculation); confirmed Cancel and an invalid/non-numeric/zero-or-negative
entry both leave the outline completely untouched (deep-equality check
before/after); confirmed a linked asset placed at an edge's midpoint stays
exactly at that edge's midpoint after scaling (proving the transform is
applied identically to outline and features); confirmed persistence with a
mocked `fdb`: calibrating an outline with a `.id` and a linked
building/roof correctly writes the rescaled ring/area/perimeter/calibration
into the matching `roof_outlines[]` entry via `saveBuildingRoofs()`, while
calibrating an unlinked/unsaved outline makes zero `fdb` calls; confirmed
`rmSaveOutlineToBuilding()`'s new id-stamping line makes the in-memory
outline's `.id` match the Firestore-saved entry's `.id` exactly. All test
state (`rmState.outline`, `linkedAssetsCache`, `linkedBuildingId`/
`linkedRoofId`, stubbed `fdb`/`prompt`/`toast`) cleared, page reloaded,
console clean.

## Send Feedback (shipped 2026-07-10, dev only)

An in-app feedback tool so field testers (Mark, mainly, during live testing)
can report a problem or idea from wherever they hit it, without switching
apps. Reachable from every screen.

**Floating button + form, present everywhere**: `#feedback-fab` (💬) sits
outside every view's own `<div>` (right after `#photo-lightbox`, a sibling
of the view containers), `position:fixed;bottom:74px;right:16px;z-index:400`
— `showView()`'s per-view `display` toggling only touches the `view-*`
containers, so the button is never hidden regardless of which tab is
active. `z-index:400` clears the toast (`bottom:18px`, so the two don't
overlap) but sits well under every modal's `9999`. Tapping it opens
`#feedback-modal`, following the exact same modal pattern as
`#signature-modal`/`#pin-modal` (fixed, dimmed backdrop,
`lockBodyScroll()`/`unlockBodyScroll()`).

**Quick-type picker + comments + optional screenshot**: four fixed types
(`FEEDBACK_TYPES` — 👍 Works great / 🤔 Confusing / 🐞 Bug / 💡 Feature
request), rendered as toggle buttons (`renderFeedbackTypePicker()`,
re-renders on every `selectFeedbackType()` call so the active one highlights
`btn primary`). Comments are free text, optional — a bare 👍 tap with no
elaboration is a valid submission. Screenshot is optional two ways:
"📸 Capture Screen" (`html2canvas`, new CDN script tag alongside
jsPDF/Leaflet — captures `document.body` after briefly hiding the feedback
modal itself so it doesn't capture its own UI, then restores it in a
`finally` so a capture error can't leave the modal stuck hidden) or
"🖼️ Attach Photo" (reuses the existing `resizeImageFile()` helper, same as
every other photo-capture path in the app). Either path runs through a
resize/compress cap (900px max dimension, JPEG quality 0.55 —
`canvasToCappedDataUrl()` for the html2canvas path, `resizeImageFile()`'s
existing cap for the attach-photo path) to stay well under Firestore's 1MB
document limit and keep the emailed attachment small; a captured screenshot
in testing came out to ~33KB.

**Auto-captured context, no typing needed**: `screen` (`FEEDBACK_VIEW_LABELS
[currentViewName]` — `currentViewName` is a new module var `showView()` now
sets on every call, mirroring its `v` argument, that nothing needed before
this), `technician` (the open work order's Technician field if the tester's
on the edit/preview view and it's non-empty, else the most-recently-
remembered technician name device-wide via the existing
`getFieldHistory("technician")[0]` field-memory mechanism, else "" — "no
real accounts yet, use the best available identifier" per spec), `adminMode`
(`isAdmin`), `device` (`navigator.userAgent`, truncated), `workOrderId`/
`workOrderJobName` (from `currentId`/the Job Name field, only when a work
order is actually open — edit/preview view — else both `null`), and
`createdAt` (`Date.now()`).

**Storage — `feedback` Firestore collection, additive, create-only from the
client**: `fdb.collection("feedback").doc(genId("fb")).set(doc)`, matching
this app's existing convention of client-generated ids over `.add()`.
`firestore.rules` allows `create: if true` (anyone should be able to submit,
no PIN) but `read/update/delete: if false` — nobody reads it back through
the client SDK at all; the admin backlog is the only reader, and it goes
through `netlify/functions/admin.js`'s new `list_feedback` action (Admin
SDK, PIN-gated, newest-first, capped at 200) instead, so "admin-only read"
is enforced server-side, not just hidden in the UI. **Needs a manual apply
in the Firebase Console to take effect**, same as `app_settings` — this repo
file is reference-only, nothing deploys it automatically.

**Emailed to Mark on every submission, independent of the Firestore
write**: new `netlify/functions/send-feedback.js`, structurally mirroring
`send-workorder.js` (same `RESEND_API_KEY`, same fetch-to-Resend shape) but
tailored — no PDF, an optional screenshot/photo attachment instead, and
always sent to `marks@watkinsroofing.net` (overridable via new
`FEEDBACK_TO_EMAIL`) rather than a client-picked recipient list. **Subject
is always `"[RoofOps Feedback] " + typeLabel + " — " + screen`** (e.g.
`"[RoofOps Feedback] 🐞 Bug — Inspection Form"`) — the leading
`[RoofOps Feedback]` token is identical on every single submission
regardless of type or screen, specifically so a mail rule can match on that
fixed prefix and file all of them into one Outlook folder once delegated
auth/inbox rules are available (see "Outlook / Microsoft 365" above) —
Mark's explicit ask. The email body lists every auto-captured field plus
the comments. `submitFeedback()` fires the Firestore write and the email
send as two independent best-effort attempts (`savedOk`/`emailOk`, each in
its own try/catch) — either one succeeding is enough to report success, so
a network hiccup on one doesn't silently lose the other or block the UI.

**Admin backlog view** — new card at the top of the Reports tab
(`#feedback-backlog-card`), visibility driven by `updateAdminUI()` exactly
like `#admin-settings-bar`, and auto-loaded (`loadFeedbackBacklog()`)
whenever an admin opens the Reports tab or turns admin mode on while
already there. Newest-first list (server already sorts by `createdAt desc`
in `list_feedback`), a type filter `<select>` re-renders client-side from
the already-fetched `feedbackBacklog` array (no re-fetch per filter
change), each entry showing type/comments/screen/technician/work
order/timestamp, and a screenshot thumbnail that opens full-size via a new
`openImageLightbox(src)` — pulled `openPhotoLightbox(i)`'s body out into
this reusable-by-src version (it now just resolves the index to a `.img`
and calls through) so a screenshot, which has no place in the global
`photos[]` array, can reuse the exact same lightbox UI.

Tested with mocked `fdb`/`callAdminApi`/`fetch` (no real writes, no real
emails, no real admin PIN check): the type picker correctly highlights the
active selection; submit is blocked with a clear toast when no type is
picked; a full submit on the Work Order Form view correctly captured
screen/technician/work order context and produced matching payloads to
both the Firestore write and the `send-feedback` fetch call; the subject-
prefix logic (re-implemented inline and run against 4 cases, since this
sandbox has no Node runtime to execute the Netlify function directly)
produced the exact expected string in every case, including the no-screen
edge case; `html2canvas` screenshot capture produced a real ~33KB JPEG and
correctly restored the modal's visibility afterward; the attach-photo
fallback correctly resized a synthetic PNG through `resizeImageFile()`;
Remove Screenshot correctly cleared the state; the admin backlog card is
`display:none` for non-admins and becomes visible + auto-loads on
`updateAdminUI()`/entering Reports as admin; the type filter correctly
narrowed the rendered list without re-fetching; a `list_feedback` failure
(simulated wrong-PIN error) rendered a clear inline error instead of a
blank list; the 💬 button was confirmed present (`getComputedStyle().
display`) across all six views. All test state (`fdb`, `isAdmin`/
`adminPin`/sessionStorage, `feedbackState`, `feedbackBacklog`, `currentId`,
stubbed `callAdminApi`/`fetch`/`toast`) cleared, page reloaded, console
clean, no stray `localStorage` keys left behind.

## Buildings Near Me (proximity / GPS building detection, shipped 2026-07-10, dev only)

Realizes the "tech pulls up on site and the app already knows where they
are" vision pillar (see ROADMAP.md). A "📍 Buildings Near Me" card at the
top of the Building History tab gets the tech's current GPS, resolves every
building's best-known coordinate, sorts by distance, and lets them tap the
one they're at to jump straight into its full Building History — which
already links CompanyCam, job numbers, past reports, and the roof map, so
nothing extra was needed there.

**Coordinate resolution, cheapest-first (`bnmCachedCoord()`)**: (1) a
cached `geoCache.{lat,lng}` on the building doc, if a previous run already
resolved one; (2) failing that, the most recently created `roof_outlines[]`
entry's `.center` across all of the building's roofs — free (the building
doc is already fetched) and usually more accurate than a street-address
geocode, since it's GPS/geometry-derived; (3) failing that, a live geocode
of the building's `location` address via the existing `geocodeAddress()`
(Nominatim, already used by pin placement) — capped at
`BUILDINGS_NEAR_ME_GEOCODE_CAP` (25) live calls per run, since Nominatim is
a shared free service and a large mostly-uncached building list shouldn't
turn into a slow bulk-geocoding scan. A building with none of the three
(no location text either) is silently skipped — can't compute a distance
for it, but it still shows up normally in the regular building search
below.

**Caching the geocode result (`bnmCacheGeocode()`)**: any building resolved
via step 3 gets `{ geoCache: { lat, lng, source: "geocoded", updatedAt } }`
written back with `.set(patch, { merge: true })` — a plain client write
(buildings already allow open `update`, no admin gate needed), and `merge:
true` means the patch can only ever add/overwrite the `geoCache` key,
never touch anything else on the building doc. So the building "warms up"
over time: the first tech near a given building pays one geocode call, and
every tech (and every future run) after that reads the cached value
instead. A failed cache write is swallowed (best-effort, in its own
try/catch) — worst case, the next run just re-geocodes that one building
again, nothing breaks.

**Distance + results**: haversine via the existing `rmGeomHaversineMeters()`
(not RoofMapper-specific in practice, just a general-purpose distance
helper — reused as-is rather than duplicated), converted to miles, filtered
to `BUILDINGS_NEAR_ME_RADIUS_MI` (25) and sorted ascending. A single result
under ~800ft (0.15mi) gets a "You're here" highlight as a suggestion, but
tapping is always required — it never auto-navigates on its own, matching
the spec ("still let them confirm"). Tapping any result calls
`openBuildingFromNearMe(id)`, which just does `showView("history")` +
the existing `openBuildingHistory(id)` — no new building-detail rendering
was needed, since Building History already shows everything (CompanyCam
link, job numbers, reports, roof map) once opened.

**Graceful fallbacks, all tested**: no `navigator.geolocation` at all, or
the user denies the permission prompt (`getCurrentPosition`'s error
callback) — both show a toast ("search below instead") and leave the
regular Building History search/list working exactly as before, no crash,
no wasted Firestore query (the buildings fetch never even starts if GPS
fails first). No buildings resolve within the radius — a clear inline
message in `#bnm-results`, same "search below instead" framing, with the
normal building list still right there underneath.

Tested with mocked `navigator.geolocation`/`fdb`/`geocodeAddress` (no real
GPS, no real Nominatim calls, no real writes): confirmed
`bnmCachedCoord()`'s three-tier priority (cached > most-recent-outline >
null) picks the right coordinate, including correctly picking the more
recent of two outlines by `createdAt`; ran the full
`findBuildingsNearMe()` flow against five synthetic buildings (one
geoCache-only, one outline-only, one needing a live geocode, one >25mi
away, one with no location data at all) and confirmed exactly the three
in-range buildings rendered, sorted nearest-first, the highlight applied
correctly, and the geocode-needing building's result was correctly cached
back with a merge-safe `{geoCache: {...}}`-only patch (verified the
`{merge:true}` option was actually passed, and that a cache-write failure
doesn't throw); confirmed tapping a result routes to the correct building
id via `openBuildingHistory()` and switches to the History view; confirmed
GPS-denied, no-geolocation-API, and zero-buildings-in-radius all produce
the correct graceful message with no crash and (for the GPS-failure cases)
zero Firestore reads. All test state (`fdb`, mocked `navigator.geolocation`
via `Object.defineProperty`/restored, stubbed `geocodeAddress`/`toast`,
`#bnm-results` contents) cleared, page reloaded, console clean.

## Change Order building picker: CompanyCam merge (shipped 2026-07-10, dev only)

Mark's report: "Select Existing Building" (the picker on every work order
type's Job Information card, opened via `openBuildingPicker()` — he hit it
from a Change Order specifically, but it's shared, not Change-Order-only)
only ever surfaced buildings already created in this app's own Firestore.
He wanted to be able to pick ANY CompanyCam project — the whole company
file — not just ones he'd already turned into a RoofOps building.

**Two independent lists in the same modal, neither blocking the other**:
the existing app-buildings list (`bpCache`, unchanged — `fdb` query,
client-side search via `bpFilter()`) renders exactly as before, and a new
"☁️ From CompanyCam (not yet a building here)" section
(`#bp-cc-list`/`bpCcCache`) loads separately via the existing
`ccApi({action:"projects", q})` — same Netlify function/token the
Import-from-CompanyCam flow already uses, no new secrets. `openBuildingPicker()`
kicks off both loads in parallel (an empty-query CompanyCam browse plus the
Firestore buildings fetch) so opening the picker shows a useful CompanyCam
section immediately, not just after a search. Typing in the search box does
two things: `bpFilter()` (instant, client-side, against the already-loaded
`bpCache`, unchanged) and a debounced (400ms, cleared/reset on every
keystroke so rapid typing only fires one network call) re-search against
CompanyCam via `bpDebouncedCcSearch()`/`bpSearchCompanyCam(q)` — since
CompanyCam's `query=` param searches server-side across their whole project
file, not just whatever page was initially loaded, a search genuinely
reaches "any CompanyCam project," while the un-searched default view is
practically capped (see below) like every other list in this app.

**`companycam.js`'s `projects` action `per_page` bumped 25 → 100** — a
one-line, no-new-secret change benefiting this picker's default/no-query
browse view AND the existing Import-from-CompanyCam project list for free.
Still not literally "every CompanyCam project ever" without paging through
multiple requests (not built — 100 covers the practical case, matching how
every other list in this app is capped at 100-300 rather than truly
unbounded), but a real search reaches the full project file via CompanyCam's
own server-side query.

**Merge/dedupe — "a CompanyCam project already mapped to an app building
should show once, preferring the app building record"**: `bpRenderCcList()`
builds a set of every loaded app building's `companyCamProjectId` (from the
FULL `bpCache`, not just whatever's currently filtered/visible, so dedup
stays correct regardless of search state) and filters those ids out of the
CompanyCam results before rendering — an already-linked project only ever
shows as its app-building row (with the pre-existing "🔗 CompanyCam linked"
meta text), never duplicated in the CompanyCam section too.

**Bug caught in testing, fixed before shipping**: the CompanyCam section's
"Select" buttons were originally indexed into `bpCcCache` (the raw,
un-deduped fetch result) by their position in the RENDERED (deduped) list.
Once dedup actually removed an earlier entry, every later row's index no
longer matched its position in the raw array — tapping "Select" silently
linked the WRONG CompanyCam project (verified: with `[Acme (linked, index
0), Charlie (index 1), Delta (index 2)]` and Acme deduped out, tapping the
rendered "Delta" row (visible position 1) resolved `bpCcCache[1]`, i.e.
Charlie, not Delta). Fixed by introducing `bpCcVisibleCache` — the actual
deduped/rendered array — and indexing `bpSelectCompanyCamProject(i)` into
THAT instead of the raw `bpCcCache`. Re-tested with the same fixture:
selecting the rendered "Delta Depot" row now correctly resolves to Delta's
real CompanyCam id.

**Selecting a CompanyCam-only project** (`bpSelectCompanyCamProject(i)`):
fills Job Name/Location from the CompanyCam project's name/address (same
field-filling `bpSelectBuilding()` already does for an app building), sets
`ccLinkedProjectId`/`ccLinkedProjectName` and re-renders the CompanyCam
link banner (same mechanism Import-from-CompanyCam uses), closes the
picker, and — the "so it attaches to a real building history" requirement —
immediately calls the existing `ensureCustomerAndBuilding()` (the same
idempotent, deterministic-id upsert RoofMapper's "create a new building"
flow already uses) with the CompanyCam project's name/address plus
`companyCamProjectId`, so a real `buildings` doc exists (or is updated, if
one with the same Bill To + Job Name already existed) right away — not
deferred until the work order is saved. Building it eagerly means RoofMapper/
Building History/Reports all have something real to attach to immediately,
matching how picking a CompanyCam project from RoofMapper's own
"create a new building" flow already behaves. `ensureCustomerAndBuilding()`
is idempotent (deterministic id from billTo+jobName), so a later normal save
re-running it is a harmless merge, never a duplicate building.

**Sheet-metal projects are NOT excluded from this picker** — an earlier
version of the spec asked for a hard sheet-metal exclusion here, corrected
by Mark before this was built: that rule applies only to a *future*
CompanyCam consolidation/merge cleanup task (not yet built), not to this
building picker. Sheet-metal CompanyCam projects appear and are selectable
here exactly like any other project — explicitly tested (a
"Charlie Sheet Metal Co" fixture project rendered and was selectable with
no special-casing anywhere in this code path).

**Graceful CompanyCam failure**: a failed/slow CompanyCam search
(`bpSearchCompanyCam()`'s own try/catch) shows "Couldn't reach CompanyCam
right now — showing existing buildings only." inside `#bp-cc-list` only —
the app-buildings list/search above it is completely unaffected, since the
two loads are independent from the start.

Tested with mocked `fdb`/`ccApi` (no real network calls, no real writes):
confirmed the app-buildings list and CompanyCam section both render
correctly on open; confirmed dedup correctly hides a CompanyCam project
already linked to an app building while leaving others (including the
sheet-metal fixture) selectable; confirmed the index bug above, fixed it,
and re-verified the fix with the same fixture; confirmed selecting a
CompanyCam-only project fills the right fields, sets the CompanyCam link,
closes the modal, and calls `ensureCustomerAndBuilding()` with exactly the
expected arguments; confirmed rapid typing in the search box fires exactly
one debounced CompanyCam search call, not one per keystroke; confirmed a
CompanyCam failure shows the fallback message in the CompanyCam section
only, with the app-buildings list/search still fully intact and unaffected;
confirmed the original `bpSelectBuilding()` (existing app-building) path is
unchanged. All test state (`fdb`, `ccApi`/`ensureCustomerAndBuilding`
stubs, form fields, `bpCache`/`bpCcCache`/`bpCcVisibleCache`, the picker
modal) cleared, page reloaded, console clean.

## RoofMapper: compact locate button + free-typed address search (shipped 2026-07-10, dev only)

Two small polish items from Mark.

**"📍 Use My Location" was oversized** — still `rm-bigbtn` (full-width,
52px min-height) from before the earlier RoofMapper UI cleanup pass shrunk
the other buttons around it. Dropped to plain `btn primary`, matching every
other compact control in this card (confirmed via `preview_inspect`: 17px
tall / content-width now, vs. the old 52px full-width).

**Address search, unmatched-address included** — RoofMapper's only
"find a location" entry point was `rmUseMyLocation()` (GPS), which by
definition requires physically standing there. New `rmSearchByAddress()`
sits right below it: types into `#rm-address-search`, geocodes via the
same `geocodeAddress()`/Nominatim path pin placement already uses (no new
geocoding logic), and feeds the result into the *exact* same
`rmState.lat/lng` + `rmSearchBuildings()` pipeline `rmUseMyLocation()`'s
GPS-success branch already uses — so everything downstream (footprint
search, manual trace, walk-the-corners, save-to-new-building) works
identically no matter which entry point located the map, and a
zero-Overpass-match address (a brand-new roof, a scouting stop) just falls
through to Manual Trace/Walk-the-Corners like any other no-footprint-found
case already does. Deliberately does NOT draw a GPS accuracy circle for a
geocoded point (`rmState.accuracy` gets a nominal 30 just so
`rmPickInitialRadiusIndex()` has a sane input) — showing a fake "±Nm GPS
accuracy" badge for a street-address lookup would be misleading. Enter-key
submits (`onkeydown`), not just the Search button.

Tested with mocked `geocodeAddress()`/`rmSearchBuildings()` (no real
Nominatim/Overpass calls): confirmed a successful geocode sets
`rmState.lat/lng`, skips the accuracy circle, and calls
`rmSearchBuildings()`; confirmed empty input, a no-match geocode result,
and a thrown geocode error each show the right message and correctly
re-enable the Search button (`finally` block); confirmed Enter-key
submission dispatches the same call as clicking Search; confirmed
`rmUseMyLocation()`'s own GPS path (real accuracy circle, its own status
text) is completely unaffected by any of the above. All test state
(`rmState.lat/lng/accuracy/userMarker/accuracyCircle`, the address input,
stubbed `geocodeAddress`/`rmSearchBuildings`/`rmGeoRequest`/`toast`)
cleared, page reloaded, console clean.

## Individual-roof tracing + labels (shipped 2026-07-10, dev only)

Mark's feedback: "no way to trace individual roofs, and each roof needs a
LABEL." The multi-roof data model (`roofs[]`, each with its own `.label`/
`.roof_outlines[]`/`.roof_assets[]`) already existed from an earlier
increment — this closes the actual gaps in the RoofMapper/Building History
UI that made it hard to use in practice.

**Real latent bug found and fixed**: `rmChooseBuildingForSave()` only
showed a roof picker for a building that ALREADY had 2+ roofs — a
single-roof building saved with zero extra taps, straight into that one
roof's `roof_outlines[]`. That meant tracing a genuinely second, distinct
roof for a still-single-roof building had no way to become its own roof —
it would silently append into roof #1's outline history instead (which is
otherwise a deliberate, documented behavior for re-surveys/corrections of
the SAME roof, just wrong for a NEW one). Now the picker always shows for
an existing building, single-roof or not, with a
**"+ Add a new roof…"** option alongside whatever roofs already exist —
picking it prompts for a label and creates the roof
(`rmAddRoofAndSave()`) before saving the outline into it
(`rmSaveOutlineToBuilding()`). One extra tap for the common single-roof
case, traded for actually being able to add roof #2/#3/etc. without ever
leaving RoofMapper. (`rmCreateBuildingAndSave()`, for a brand-new building,
is unaffected — its first roof is unambiguous, no picker needed.)

**Persistent labels, not just picker text**: previously a roof's name only
ever appeared as `<option>` text in a dropdown, or in a tap-triggered map
popup (`outlinePopupHtml()`). New shared `roofLabelMarker(lat, lng, text)`
(next to `rmGeomRingCentroid()`) draws a small persistent blue pill label
at an outline's centroid — visually distinct from the existing per-edge
dimension labels (dark slate) so the two read as different kinds of
information. Used in two places: RoofMapper draws one on the outline it
just saved (`rmSaveOutlineToBuilding()`, using the roof it was actually
saved to — `rmState.roofLabelLayer`, cleaned up alongside the rest of
`rmClearLinkedFeatures()`/`rmClearGeneratedOutline()` so nothing lingers
after a fresh search); Building History's `renderBuildingMap()` draws one
per outline that carries an optional `_roofLabel` tag.

**Building History now shows every roof at once, not one at a time**:
`openBuildingHistory()` used to pass only the currently-selected roof's
`roof_outlines` into `renderBuildingMap()` — switching roofs via the
dropdown redrew the map for just that one. New `allRoofOutlinesForMap`
aggregates every roof's MOST RECENT outline, each tagged
`_roofLabel: roof.label`, so Mark can see every roof on the building
together and tell them apart by their labels — matches "coexist... tell
them apart." **Scope boundary, deliberate**: only built for satellite mode
(`hasCustomBaseMap` false) — a roof with a custom `roof_plan`/`sketch` base
map renders in that image's own `L.CRS.Simple` pixel coordinate system,
which other roofs' real lat/lng outlines literally cannot be drawn onto
(same pre-existing constraint already documented for pins/assets). Pins
and roof-features/assets stay scoped to whichever roof is selected in the
dropdown, unchanged — only OUTLINES got the "show them all" treatment;
broadening pins/assets the same way wasn't part of what was asked and
would blur which roof is actually being worked on below the map.
`outlinePopupHtml()` gained an optional second `roofLabel` param so a
tapped outline's popup also states which roof it belongs to.

**Labels are now renameable** — previously set once, at
`promptAddRoof()` creation time, with no way to fix a typo or rename
later. New `promptRenameRoof(buildingId, roofId)` (same prompt-based
pattern, pre-filled with the current label) reachable via a new
"✏️ Rename" button next to the roof picker — shown even for a
single-roof building (its synthesized/default "Roof 1" is just as
renameable), not gated behind having 2+ roofs like the picker dropdown
itself.

**Investigated and found NOT to be a gap**: whether work orders tie to a
specific roof only on Inspection forms. They don't need broadening —
every work order type already gets a per-pin roof picker
(`renderPinRoofPicker()`, at the point a finding's pin is placed) once the
resolved building has more than one roof; Inspection's own up-front
picker (`renderInspectionRoofPicker()`) is a deliberate exception because
an inspection's checklist has no per-item pin to hang a roof choice off of
the way Findings do, so it needs the roof known before the checklist
renders. Change Order has no pin/roof concept at all, by design (no
findings). No code change made here.

**Deliberately deferred, not built tonight**: showing a building's
already-traced roofs as a live reference layer WHILE tracing a new one in
RoofMapper's own capture view (so a tech can see roof #1's boundary while
walking/tracing roof #2 and avoid accidental overlap). Every fresh
footprint search/trace currently resets `rmState.linkedBuildingId` to
`null` (`rmClearGeneratedOutline()` → `rmClearLinkedFeatures()`), by
design, so there's no "still linked to building X" state to draw a
reference layer FROM during a fresh trace anyway — building that properly
would mean deciding whether starting a new trace should preserve the link
to the previous building, a real UX/state design question bigger than
tonight's scope. The save-time roof picker (now with labels + "+ Add a new
roof…") already gives full visibility of what roofs exist before
committing a new one, which covers the essential need. Flagged as a
follow-up, not silently dropped.

Tested with mocked `fdb`/`prompt`/`toast` (no real writes, no real map
network calls) using a stateful in-memory `fdb` mock (a plain object store
so sequential `get()`/`set()` calls within one flow actually observe each
other's writes, matching real Firestore's read-your-own-writes
consistency — an earlier non-stateful mock produced a false failure here
purely from the mock's own limitation, not a product bug): confirmed the
save-flow picker always renders, including for a single-roof building, with
"+ Add a new roof…" always present; confirmed selecting "+ Add a new
roof…" creates the roof AND saves the outline into it (not into the
pre-existing default roof); confirmed the roof-label marker draws with the
correct roof's label text on a real Leaflet map instance and is null'd out
by the existing clear/reset paths; confirmed the `allRoofOutlinesForMap`
aggregation picks each roof's most recent outline, skips a roof with no
outline yet, and tags each with the right `_roofLabel`; confirmed
`promptRenameRoof()` updates only the targeted roof's label (sibling roofs
untouched) and that Cancel/empty-input both leave the label unchanged.
All test state cleared, page reloaded, console clean.

## Square Up (orthogonal snapping, shipped 2026-07-10, dev only)

Mark, building on the self-scaling calibration: roofs are mostly
rectilinear, so a traced outline should "look square" — snap near-90°
corners and near-axis edges clean, UNLESS a segment is an obvious
intentional angle (e.g. a 45° cut) or an arc/curve, which stay exactly as
traced. Manual button ("🟦 Square Up"), not automatic on every trace —
an intentionally irregular roof should never get altered without Mark
asking for it — with a one-level Undo.

**Core algorithm — `rmGeomComputeSquaredRing(ring)`** (pure function, no
`rmState`/map access, independently testable), next to
`rmGeomPolygonPerimeterMeters()`:
1. **Dominant axis detection**: a rectilinear polygon's edges alternate
   between two perpendicular directions, which collapse to ONE value under
   mod-90° reduction (0° and 90° both reduce to 0°). Computes a
   length-weighted circular mean of every edge's angle mod 90° — scaling
   each angle ×4 before the standard sin/cos circular-mean turns the
   90°-period wraparound into a full 360°-period one, so edges near the
   wrap boundary (e.g. 89° and 1°, actually close together under mod-90)
   don't cancel out the way a naive arithmetic mean would.
2. **Curve/arc detection**: a single sharp corner is ONE big turn at one
   vertex with straight edges either side. An arc, as discretely traced,
   instead shows up as a RUN of several consecutive SMALL per-vertex turns
   (each under `RM_SQUARE_CURVE_SINGLE_TURN_MAX`, 35°) that cumulatively
   sweep a real angle (past `RM_SQUARE_CURVE_CUMULATIVE_MIN`, 40°). Every
   edge inside such a run is flagged "never snap," regardless of its own
   mod-90 alignment. Simplification, documented not hidden: a run
   straddling the ring's start/end index isn't merged across that
   boundary — an edge case of an edge case.
3. **Per-edge snap decision**: within `RM_SQUARE_TOLERANCE_DEG` (12°, the
   requirement's "~10-15°") of the dominant axis's nearest 0/90/180/270 →
   snap. Outside tolerance (a real diagonal cut) → left alone. A simple
   fallback safety net on top: a very short edge flanked by other short
   edges is skipped even if in-tolerance, since short choppy segments read
   more like curve/trace noise than an intentional straight edge.
4. **Sequential walk-and-snap**, in local meters (`rmGeomToLocalXY`/
   `rmGeomFromLocalXY`, the same flat-earth-at-building-scale helpers
   calibration uses): walks the ring in order; a snappable edge gets its
   DIRECTION rotated to the nearest exact axis angle while its ORIGINAL
   LENGTH is preserved exactly (corners move, measured lengths don't — the
   explicit requirement); a non-snappable edge is carried through as its
   original vector, unchanged. Deliberately NOT a full line-intersection
   solve at every corner (which would need to handle near-parallel edges
   and would NOT preserve edge lengths) — simpler, length-preserving, and
   numerically always well-defined. The final closing edge (back to the
   start point) is forced to close exactly rather than independently
   recomputed, absorbing whatever small drift accumulated walking around
   the loop — a documented simplification, not a bug.

**UI**: "🟦 Square Up" + "↩️ Undo Square Up" (hidden until applied) in the
outline panel, plus a status line reporting how many edges were snapped
and how many curved/arc edges were left as traced. `rmState.preSquareRing`
holds the one-level undo snapshot; both it and the button/status get reset
by `rmClearGeneratedOutline()` (clearing/re-searching) and
`rmDrawFinalOutline()` (a fresh capture), so nothing stale carries over
from a previous outline.

**Persistence**: mirrors calibration's own pattern exactly — squaring an
unsaved outline just updates `rmState.outline` in memory (next Save
Outline picks it up); squaring an already-saved outline (has `.id` +
`linkedBuildingId`/`linkedRoofId`) writes immediately via
`rmPersistSquareUp()`, replacing `ring`/`areaSqFt`/`perimeterFt`/`center`/
`squared` on the matching `roof_outlines[]` entry. **Deliberately does NOT
touch `roof_assets`**, unlike calibration — calibration's uniform
scale-about-centroid is a well-defined transform to also apply to placed
features; squaring moves vertices non-uniformly (some corners move,
others don't), so there's no unambiguous way to carry that onto point
features without real risk of misplacing them. Noted as a known scope
boundary, not silently glossed over.

**Order with calibration (b64fe10), verified**: recommended flow is trace
→ Square Up → Calibrate, run last, so whichever edge gets calibrated
reflects its FINAL post-square length no matter what squaring did
upstream. Tested the composition directly: squared a 6°-rotated 100×60ft
rectangle (all 4 corners came out exactly 90° apart), then calibrated edge
0 to a real 110ft — edge 0 became exactly 110ft, the adjacent edge scaled
proportionally to 66ft (60 × 1.1), and the corners stayed EXACTLY 90°
apart afterward (calibration's uniform scale preserves angles by
construction, so it can never undo what squaring just fixed).

Tested purely on the geometry function (no map/network/writes needed for
this part): a rectangle rotated 6° off true axis snapped all 4 edges to
exactly 6°/96°/186°/276° (the correctly-detected dominant axis) with every
edge's length unchanged to the sub-foot; a rectangle with one corner cut
at 45° squared the 4 rectilinear edges while leaving the diagonal cut's
exact length untouched (4 of 5 edges snapped); a rectangle with one corner
replaced by a 6-segment rounded arc correctly excluded the curved region
from snapping (the exact edge count at the straight/curve boundary is
inherently fuzzy for a discretized curve — the algorithm conservatively
erred toward preserving one extra boundary edge rather than risk mangling
the arc, the safer of the two failure modes); a near-circular 24-point
shape returned `null` (nothing to square) as expected. Then tested the
UI-level functions with a real Leaflet map instance and mocked `fdb`/
`prompt`/`toast`: `rmSquareUpOutline()` correctly updates the outline,
shows the right snapped-edge count, reveals the Undo button, and persists
when linked; `rmUndoSquareUp()` restores the byte-for-byte original ring,
clears the `squared` metadata, and hides the Undo button again; confirmed
both `rmClearGeneratedOutline()` and `rmDrawFinalOutline()` reset any
stale Square-Up UI state left over from a previous outline. All test
state cleared, page reloaded, console clean.

## Duplicate roof feature (shipped 2026-07-10, dev only)

Mark: "point is speed when a roof has several of the same thing" — multiple
RTUs, a run of roof-fence sections, etc. Works for every placeable feature
type in `ROOF_ASSET_TYPES` (drains, HVAC/RTU, vents, hatches, curbs,
penetrations, and everything else in that map) — not type-specific, since
`rmDuplicateFeature()` just copies whatever `.type`/`.label`/`.notes` the
original asset had. (Findings/pins from a work order — leaks, repairs — are
a different system entirely, tied to a specific report, not a roof-wide
permanent feature; out of scope here, not something this touches.)

**Two reachable paths, both calling the same `rmDuplicateFeature(assetId)`**:
a new "📋 Duplicate" button in the inline feature-edit form (shown only
when editing an existing feature, same visibility gate as Delete), and
double-clicking a placed marker directly (`rmDrawLinkedAssets()`'s new
`dblclick` handler, `L.DomEvent.stopPropagation()`'d so it doesn't also
trigger the map's own double-click-to-zoom underneath). The dblclick path
has one accepted, documented quirk: a double-click is preceded by two
ordinary `click` events (standard DOM behavior, not a Leaflet or app bug),
so the single-click edit-form handler fires first and briefly opens the
form before the duplicate itself completes and closes it again — a minor
visual blip, not a functional issue, and the form's own Duplicate button
sidesteps it entirely for anyone who finds that distracting.

**The copy** gets a fresh `genId("ast")` id, the exact same
type/label/notes as the original, and is offset 12ft in both lat and lng
(≈17ft diagonal — verified) from the original position so it doesn't land
exactly on top of it — same drag-to-reposition interaction as any newly
placed feature, nothing new to learn. Persists through the exact same
`persistRoofAsset()` every other roof-asset write already uses (Building
History's asset modal, RoofMapper's own add/edit form) — no new data path,
no new Firestore write shape.

**Guards**: no-ops (no Firestore call) if nothing is linked, if the asset
id isn't found, or if the source asset only has x/y coordinates (placed on
a building's custom `roof_plan`/`sketch` base map — RoofMapper's own map is
always lat/lng-only, same pre-existing limitation as the outline itself, so
those assets never get a marker here to double-click in the first place;
the guard is defensive, not reachable via the dblclick path, only kept in
case the form button is ever invoked in a state that shouldn't be possible
today).

Tested with a real Leaflet map instance and mocked `fdb` (no real writes):
confirmed a duplicated asset's type/label/notes matched the original
exactly with a different id, at the expected ~17ft offset; confirmed all
three guards correctly skip the Firestore call (unlinked, unknown id,
x/y-only); confirmed the marker's `dblclick` handler routes to
`rmDuplicateFeature()` with the right asset id; confirmed the form's
Duplicate/Delete buttons are both hidden when adding a brand-new feature
and both visible when editing an existing one; confirmed the form button's
`rmDuplicateFeature(rmFeatureEditingId)` call correctly targets whichever
feature is currently being edited; regression-checked that
`rmEditFeature()`/`rmCancelFeatureForm()` still populate and close the form
exactly as before. All test state cleared, page reloaded, console clean.

## Vertex editing (shipped 2026-07-10, dev only)

Mark asked how to adjust an already-traced outline — the honest answer,
confirmed by reading the code before answering, was that there was no way
to move an individual point at all: Square Up auto-cleans angles across
the whole shape, Calibrate rescales the whole shape off one edge, but
neither lets you drag one specific corner, and there's no Leaflet editable-
polygon plugin loaded (only vanilla Leaflet). This ships that missing
capability, deliberately visible rather than a hidden gesture — a primary
"✏️ Edit Shape" button (not a small icon easy to miss), explicit hint text,
and drag handles styled distinctly from both the edge-dimension labels and
asset markers (a plain white-filled circle with a thick orange ring).

**Scope, deliberate**: moving existing vertices only. Adding or removing a
vertex entirely is a real, bigger follow-up (needs edge-midpoint "add"
handles, a vertex removal affordance, minimum-3-point validation) — not
built here, flagged rather than silently out of scope.

**`rmToggleVertexEdit()`** flips between `rmEnterVertexEdit()` (draws a
draggable handle per real vertex via `rmDrawVertexHandles()`, disables
Square Up for the duration — two edit modes mutating the same ring at once
is asking for trouble — shows the hint text) and `rmExitVertexEdit(persist)`
(tears down the handles, re-enables Square Up, and — only when exiting via
"✓ Done Editing," not an internal reset — calls `rmPersistVertexEdit()`).

**Drag performance**: each handle's Leaflet `drag` event (fires continuously,
many times per second during an active drag) only calls
`rmState.outlineLayer.setLatLngs(...)` — cheap, just moves the visible
polygon shape live. The `dragend` event (fires once, on release) is where
`areaSqFt`/`perimeterFt`/`center` actually recompute and
`rmDrawEdgeDimensions()` redraws the dimension-label divIcons. Recreating
those divIcon markers on every drag frame instead of just once on release
would be needless churn mid-gesture and risks feeling laggy on a phone —
the opposite of "easier navigation." Dragging vertex 0 also updates the
ring's closing duplicate point (`ring[n] === ring[0]` by convention) so the
polygon never visibly un-closes mid-edit.

**A manual point move invalidates `squared`/`calibration` metadata** — both
are deleted from the outline on `dragend`, and the Square Up Undo snapshot
(`rmState.preSquareRing`) is cleared too, since "undo" against a ring
that's since been hand-edited wouldn't mean what it used to. This keeps the
metadata honest: `outline.squared`/`.calibration` only ever describe the
CURRENT ring, never a stale claim about a shape that's since changed.

**Persistence** mirrors Calibrate/Square Up exactly: an unsaved outline
just updates `rmState.outline` in memory (next Save Outline picks it up);
an already-saved outline (has `.id` + `linkedBuildingId`/`linkedRoofId`)
writes immediately via `rmPersistVertexEdit()`, explicitly nulling
`calibration`/`squared` on the saved `roof_outlines[]` entry to match.

**Auto-exit, no data loss**: both `rmClearGeneratedOutline()` (fresh
search/clear) and `rmDrawFinalOutline()` (a fresh capture) call
`rmExitVertexEdit(false)` if edit mode is somehow still active, discarding
without attempting a doomed save against an outline that's about to be
replaced or gone entirely.

Tested with a real Leaflet map instance and mocked `fdb`/`toast` (no real
writes): confirmed entering edit mode draws exactly one handle per real
vertex and disables Square Up; confirmed dragging vertex 0 updates both it
and the closing duplicate point, moves the polygon live via `setLatLngs`
during `drag`, and leaves `areaSqFt` unchanged until `dragend` fires (then
correctly recomputes); confirmed a drag correctly clears pre-set
`squared`/`calibration` metadata and hides the Undo Square button; confirmed
"Done Editing" persists correctly to a mocked linked/saved outline with
`calibration`/`squared` explicitly nulled, and shows the right "will save
with the outline" message for an unlinked one; confirmed both
`rmClearGeneratedOutline()` and `rmDrawFinalOutline()` correctly auto-exit
an active edit session. All test state cleared, page reloaded, console
clean.

## Easier map navigation (shipped 2026-07-10, dev only)

Mark: the map is "a little hard to navigate." Three changes, scoped to
`#rm-map` specifically so no other map in the app is affected:

1. **`touch-action:none` on the map container** — the likely actual root
   cause of "hard to navigate" on a phone: without it, the page's own
   native scroll/zoom gesture handling can fight with Leaflet's own touch
   pan/pinch-zoom, making panning feel sticky, laggy, or unresponsive. This
   is a well-understood, common real fix for embedded interactive maps on
   mobile — the app already applied the same principle to the signature pad
   canvas (a different context, same root cause: letting Leaflet/the canvas
   own ALL touch gestures on that element instead of the browser).
2. **Bigger zoom +/- buttons**: Leaflet's default zoom control renders at
   26px, not a great thumb target — bumped to 38px (`#rm-map .leaflet-
   control-zoom a`), scoped so the rest of the app's Leaflet controls
   (asset/pin/building maps) are untouched.
3. **A floating "🎯" recenter button**, overlaid directly on the map
   (`#rm-map-wrap` is now `position:relative` so the button can sit in a
   corner via `position:absolute`) — always reachable without scrolling
   down to the outline panel's existing "🔍 Zoom to Roof" button (which
   still exists, unchanged, for when the panel's already in view). New
   `rmRecenter()` does the most useful "get back to where I should be
   looking" thing for whatever phase RoofMapper is currently in: fits to
   the outline if one's been drawn, else fits to the footprint search
   results if any are showing, else recenters on the located GPS point,
   else toasts that there's nothing to center on yet — one obvious control
   that's never a no-op unless genuinely nothing has happened yet.

Also set on the Leaflet map instance itself (`rmEnsureMap()`):
`bounceAtZoomLimits:false` (no jarring snap-back at the zoom extremes) and
`zoomSnap:0.5` (finer zoom increments, matching how a pinch gesture
actually lands instead of jumping in whole-integer steps).

Tested: confirmed `#rm-map`'s computed `touch-action` is `none`; confirmed
`rmEnsureMap()` reveals `#rm-map-wrap` (not just `#rm-map` directly, since
the recenter button now lives in that wrapper alongside the map);
confirmed `rmRecenter()`'s three fallback branches each fire correctly
(outline → `fitBounds` on the outline; footprints-only → `fitBounds`
across every footprint layer; located-only → `setView` on `rmState.lat/
lng`) and that the zero-state correctly toasts instead of erroring. All
test state cleared, page reloaded, console clean.

## Export preview (shipped 2026-07-10, dev only)

Mark: a way to preview the map/drawing (outline + labels + features) as it
will look exported, before actually exporting. New "👁️ Preview Export"
button in the outline panel, next to the existing Export SVG/PNG/PDF
buttons.

**Guaranteed to match, not a separate approximation**: `rmPreviewExport()`
calls the exact same `rmFetchExportOverlayData()` + `rmBuildOutlineSvg()`
pipeline the SVG and PNG exports already call (PNG literally rasterizes
this same SVG onto a canvas) — the preview is injected via `innerHTML`
into `#rm-preview-svg-host` inside a new `#rm-preview-modal`, so what's
shown is byte-identical markup to what SVG export downloads and what PNG
export rasterizes, not a second render path that could quietly drift out
of sync with the real thing. PDF is explicitly the exception: it draws
directly with jsPDF from the same underlying outline/overlay data rather
than rasterizing the SVG, so it has its own page layout (title placement,
margins, legend position) that doesn't pixel-match the SVG/PNG preview —
the modal says so directly ("this is what SVG/PNG exports will look like;
the PDF includes the same info in its own page layout") rather than
implying a guarantee that isn't quite true for that one format.

**The modal also carries its own Export SVG/PNG/PDF buttons** — a natural
"looks good → export it" flow from the same screen, wired to the exact
same `rmExportSVG()`/`rmExportPNG()`/`rmExportPDF()` functions the outline
panel's own buttons already call — no new export logic, just a second
place to reach the same three actions.

Tested with mocked `fdb` (no real writes, no real downloads triggered):
confirmed no-outline correctly toasts instead of opening an empty modal;
confirmed a real outline's title/area appear correctly in the injected
SVG markup; confirmed `closeRmPreviewModal()` hides the modal and clears
the host (no stale SVG lingering for the next open); confirmed a mocked
placed HVAC asset correctly appears as both a marker and a legend entry in
the preview, sourced from the same overlay-fetch path real exports use;
confirmed the modal's three export buttons carry the exact same `onclick`
handlers as the outline panel's own export buttons. All test state
cleared, page reloaded, console clean.

## RoofMapper save flow: full CompanyCam picker (shipped 2026-07-10, dev only)

Mark: he could pick an existing app-created building when saving a traced
outline, or type a brand-new job name, but there was no way to attach an
outline to a building that only existed as a CompanyCam project (i.e.
anything not already surfaced through a saved report). Mirrors the Change
Order picker's CompanyCam merge exactly (`openBuildingPicker()` / commit
`098ae77`) — same debounced search, same "dedupe against every already-
linked app building, not just the currently-filtered ones" logic, same
fix for the index-into-the-wrong-array bug caught during that earlier
build. Kept as its own `rmBp*`-prefixed copy rather than extracting a
shared helper, matching this file's existing precedent — `rmBpFilter`/
`rmBpRender` already duplicate `bpFilter`/`bpRender` the same way for
RoofMapper's save modal specifically.

**New in this pick — a fresh-fetch, not the stale cache, feeds the roof
picker.** `rmChooseBuildingForSave()` (the existing app-buildings path)
still reads from `rmBpCache` (fetched once when the modal opened, fine —
that data is current). But `rmBpSelectCompanyCamProject()` can't: the
building it just created/linked via `ensureCustomerAndBuilding()` didn't
exist in `rmBpCache` when that fetch ran, and in the edge case where the
CompanyCam project's name happens to match an *existing* app building
that already had real saved roofs, trusting the stale cache would render
a synthesized generic "Roof 1" instead of that building's actual roofs.
Fixed by pulling the roof-picker-rendering logic out into a new shared
`rmRenderRoofPickerFor(buildingId, buildingData)` — `rmChooseBuildingForSave()`
calls it with the cached data (unchanged behavior), `rmBpSelectCompanyCamProject()`
calls it with a fresh `fdb` read of the just-linked building instead.

**"+ Add a new roof…" already works from this path for free** — no new
code needed, since `rmBpSelectCompanyCamProject()` routes into the exact
same `rmRenderRoofPickerFor()`/`rmConfirmSaveToChosenRoof()`/
`rmAddRoofAndSave()` chain the app-buildings path already uses (shipped in
`be48b2f`). Selecting a CompanyCam-only project just means arriving at
that same roof picker with a freshly-created building instead of an
already-existing one — everything downstream is identical.

Tested with mocked `fdb`/`ccApi` (no real network calls, no real writes):
confirmed both lists (app buildings, CompanyCam-only) render on open;
confirmed dedup correctly hides an already-linked CompanyCam project while
leaving others — including a "Charlie Sheet Metal Co" fixture — selectable
(no sheet-metal exclusion, per the explicit correction on that rule);
confirmed selecting a CompanyCam-only project by its RENDERED position
resolves to the correct project (re-verified the index-alignment fix
specifically, same fixture pattern as the original bug); confirmed the
critical edge case directly — a CompanyCam-only selection matching an
existing app building's jobName+billTo correctly surfaces that building's
REAL saved roofs ("Main Roof", "Annex") in the picker, not a stale
synthesized "Roof 1"; confirmed the original app-buildings path
(`rmChooseBuildingForSave`) is unaffected by the `rmRenderRoofPickerFor`
extraction; confirmed rapid typing debounces to one CompanyCam search
call, and a CompanyCam failure shows a fallback message without touching
the app-buildings list. All test state cleared, page reloaded, console
clean.

## Netlify environment variables

| Variable | Used by | Required |
|---|---|---|
| `COMPANYCAM_TOKEN` | `companycam.js` — read actions (projects, project_detail, photos, image) | yes |
| `COMPANYCAM_WRITE_TOKEN` | `companycam.js` — write action only (`upload_document`, PDF-back-to-CompanyCam). Falls back to `COMPANYCAM_TOKEN` if unset. | optional, recommended if your CompanyCam token setup separates read/write scopes |
| `COMPANYCAM_USER_EMAIL` | `companycam.js` (document upload attribution) | optional |
| `RESEND_API_KEY` | `send-workorder.js` | yes |
| `FROM_EMAIL` | `send-workorder.js` | optional (has a default). Also the source of the sending *domain* for per-job From addresses — see below. |
| `REPLY_TO_EMAIL` | `send-workorder.js` | optional, comma-separated. Defaults to `marks@<domain>` + `charlottew@<domain>` (Mark's and Charlotte's real monitored mailboxes, per his decision). See "Per-job From address" below. |
| `FEEDBACK_TO_EMAIL` | `send-feedback.js` | optional (defaults to `marks@watkinsroofing.net`). See "Send Feedback" above. |
| `ADMIN_PIN` | `admin.js` | yes, for admin mode to work | The real PIN check — not present anywhere in `index.html` anymore. |
| `FIREBASE_SERVICE_ACCOUNT` | `admin.js` | yes, for admin mode to work | Entire JSON contents of a Firebase service account key. Full project access — treat as a secret, never commit it. |
| `GRAPH_TENANT_ID` | `outlook.js` / `lib/graphAuth.js` | yes, for the Outlook/M365 integration to work | Azure AD tenant id. |
| `GRAPH_CLIENT_ID` | `outlook.js` / `lib/graphAuth.js` | yes, for the Outlook/M365 integration to work | App registration (client) id. |
| `GRAPH_CLIENT_SECRET` | `outlook.js` / `lib/graphAuth.js` | yes, for the Outlook/M365 integration to work | App registration client secret. Time-limited, will be rotated before go-live — treat as a secret, never commit it. |
| `GRAPH_MAILBOX` | `outlook.js` / `lib/graphAuth.js` | yes, for the Outlook/M365 integration to work | Mailbox this app reads, e.g. `marks@watkinsroofing.net`. Must be a member of the Exchange Application Access Policy's allowed group — see "Outlook / Microsoft 365 integration" above. |

### Email (Resend) — designated test recipient, and known blocker

**Designated test recipient for any "Send Email Now" testing: `marks@watkinsroofing.net`.**
Use this address for all email-sending test attempts — don't send test work order emails
to real customer/office addresses from the `emailPick` list.

**Resend domain verification: confirmed working (2026-07-09).** Originally blocked —
`watkinsroofing.net`'s SPF only covered Microsoft 365 and had no Resend DKIM record —
but Mark had DNS records added for the `send.watkinsroofing.net` sending subdomain
(MX + SPF) plus a DKIM TXT record on the root domain, confirmed via live DNS lookup
against two independent resolvers. A real test send to `marks@watkinsroofing.net`
succeeded end-to-end (HTTP 200, Resend accepted it), and a real field send (to
`charlottew@watkinsroofing.net`, "Planet fitness" work order) also went through
correctly. Live send-email testing is fine now — still use the designated test
recipient above for anything that isn't a real field send.

### Per-job From address (shipped)

`send-workorder.js` now sends from `WO<jobnumber>@<domain>` (e.g.
`WO1234@watkinsroofing.net`) instead of a fixed `workorders@watkinsroofing.net`, when
the client passes a job number — falls back to the original `FROM_EMAIL` default
when there isn't one. `jobNo` is sanitized to alphanumeric-only (real job numbers in
this system include characters like `#`, e.g. `"WO#10148"`, which aren't valid in an
email local-part) and capped at 30 chars. The domain itself is extracted from
`FROM_EMAIL` rather than hardcoded, so it follows whatever's actually configured
there rather than needing a second place to update if it ever changes.

**Feasibility, confirmed**: SPF/DKIM/DMARC authenticate at the *domain* level, not
per mailbox — there's no Resend concept of registering individual sending addresses,
so any address on an already-verified domain authenticates identically. Confirmed
empirically, not just by protocol theory: a live test send using `jobNo: "99999"`
(→ `WO99999@watkinsroofing.net`) against the deployed `dev` function returned `200
{"ok":true}` — Resend accepted it with no rejection.

**Deliverability nuance handled**: `WO1234@watkinsroofing.net` is not a real mailbox.
The root domain's MX is Microsoft 365, so a customer hitting Reply would otherwise
land on a nonexistent mailbox there and bounce. Added a `reply_to` header — Resend's
`reply_to` accepts an array, same as `to` — defaulting to **both**
`marks@<domain>` and `charlottew@<domain>`, Mark's and Charlotte's real monitored
mailboxes, confirmed by him directly (2026-07-09) as where replies should land, no
env var required for that to take effect. `REPLY_TO_EMAIL` still exists as an
override (parsed as a comma-separated list, so it can also carry multiple addresses)
if that ever needs to change.

**Verification**: three live test sends against the deployed `dev` function, all to
`marks@watkinsroofing.net` only — `jobNo: "99999"` (initial per-job From), `"88888"`
(after Reply-To changed to `marks@` alone), `"77777"` (after adding `charlottew@` as a
second Reply-To) — `200 {"ok":true}` every time, confirming Resend accepted the
per-job From address and both single- and dual-recipient Reply-To without error.
Visual confirmation of exactly how From/Reply-To render in an actual inbox is Mark's
to check.

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
