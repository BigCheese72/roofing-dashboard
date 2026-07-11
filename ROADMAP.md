# RoofOps Roadmap

This roadmap is intentionally phased so the current working field app remains stable while the product grows into a broader roof history and operations platform.

## Phase 1: Stabilize Current Field App

Goal: preserve and harden the existing RoofOps Field / Watkins work order workflow.

- Keep the current work order form, Firebase sync, CompanyCam import, PDF generation, and email/report sending working.
- Document the current architecture and environment variables.
- Avoid major UI redesigns until the data model and workflow are stable.
- Improve reliability around save/load, report logging, and failure messages.
- ✅ **Shipped**: fixed a real production "Storage is full" failure — merely
  *opening* an old photo-heavy report was silently caching its full photo bytes
  into the local `localStorage` fallback, filling its ~5–10MB quota. Viewing a
  report no longer caches its photos locally (everything else still does);
  only the actively-edited draft keeps full photo bytes, and a bounded cap
  (10 most-recent) auto-prunes older cached drafts as a safety net. Pure
  client-side fix, no data model change. See "Local work order cache" in
  `DEV_NOTES.md`.
- ✅ **Shipped**: emailing a work order now leaves a genuinely *visible* record, not
  just a technically-durable one — a real 2026-07-09 field send had logged correctly
  end-to-end but neither the office nor the tech could find any trace of it. Now shows
  as "📧 Emailed …" directly on the work order in the Saved tab (most discoverable
  spot), plus an explicit "Emailed to &lt;recipients&gt;" line (not just a checkmark)
  on the Building History timeline and Reports tab. See "Visible email-sent record" in
  `DEV_NOTES.md`.
- ✅ **Shipped**: work-order emails now send from a per-job `WO<jobnumber>@` address
  instead of one fixed sender, with a Reply-To safeguard so customer replies don't
  bounce against a mailbox that doesn't exist. See "Per-job From address" in
  `DEV_NOTES.md`.
- ✅ **Shipped**: fixed a real field bug (reported by Mark) — opening a placement map
  (roof asset, finding pin, RoofMapper's save flow, or the building picker) left the
  page underneath still scrollable on mobile, so the old map could visibly shift
  through the modal's dimmed backdrop mid-interaction. Body scroll is now locked
  while any full-screen modal is open. See "Old map visible behind a modal's
  placement map on mobile" in `DEV_NOTES.md`.
- ✅ **Shipped**: Work Order Type — Leak / Service (default, unchanged behavior),
  Change Order, Inspection, Repair, Warranty. Change Order reveals a Cost/Man-Hours/
  Materials/Description/PO Number/Date Completed section and generates its own
  distinct PDF template (a proper change-order/work-authorization layout — logo +
  "CHANGE ORDER" title, description, itemized materials, cost summary with a total,
  signature line — no findings/warranty framing), corrected same-day from an initial
  version that only added a section to the leak report. Inspection/Repair/Warranty
  still use the standard leak-report format for now. The type is also a filterable
  dimension on the Building History timeline and the Reports tab. See "Work order
  type" and "Change Order gets its own PDF template" in `DEV_NOTES.md`.
- ✅ **Shipped**: Home / launcher screen — the app now opens to a tile-based launcher
  (one tile per work order type + RoofMapper/Building History/Reports) instead of
  dropping straight into a blank Leak/Service form. Existing tabs and navigation are
  unaffected; opening an existing work order always skips Home. First real use of the
  extracted Watkins brand red (`#B4223F`) in the UI, scoped to this one new screen.
  See "Home / launcher screen" in `DEV_NOTES.md` and "Logo & Brand Palette" in
  `APP_OVERVIEW.md`.
- ✅ **Shipped**: fixed a real RoofMapper field bug (reported by Mark) — on desktop,
  GPS is IP-based and often lands far from the actual building; panning the map to the
  correct spot by hand left nothing clickable there, since RoofMapper only ever
  rendered footprints from the one search run around the (possibly wrong) GPS point.
  New **"🔍 Search This Area"** button re-runs the same footprint search centered on
  wherever the map is currently panned to, reusing the existing search/clear logic so
  there's never a stale/overlapping result set. A second, more ambitious option
  (tap anywhere on the map to search that exact point) was evaluated and deliberately
  deferred — real risk of firing an Overpass request on every stray/accidental tap.
  See "RoofMapper: recovering from a wrong GPS fix" in `DEV_NOTES.md`.
- ✅ **Shipped**: Warranty guidelines reference — a collapsible "Warranty Guidelines"
  section on the Warranty Determination card (every work order type) showing two plain
  tech-guideline lists (Typically Warrantable / Typically Not Warrantable). Simplified
  twice from an initial build that had a modal, per-finding classification, pin-color
  auto-sync, and manufacturer branding — Mark clarified these are informal tech
  guidelines, not an official program, and he just wanted the lists visible on the
  form. Final version is display-only: no fields, no data capture, one editable
  constant (`WARRANTY_GUIDELINES`). See "Warranty guidelines reference" in
  `DEV_NOTES.md`.
- ✅ **Shipped**: fleshed out the Repair work order type (project/small-project work —
  flashing a curb, several curbs and boots — not a leak diagnosis). Hides Roof
  Investigation Findings, adds a Repair Scope card (description + an itemized Repair
  Items list with type/quantity/notes, worded to match the roof-asset vocabulary).
  Everything else — job/work-order info, roof map context, Work Performed, Warranty
  Determination, photos — is unchanged from Leak/Service. Its report/PDF reuses the
  leak-report layout (not a separate template like Change Order), titled "Repair /
  Project Report" with the findings section swapped for Repair Scope. Leak/Service and
  Change Order are both unaffected. Inspection and Warranty remained on the base form
  at the time — Inspection was later built out into its own real form (see further
  below), Warranty still pending until Mark defines its fields. See "Repair work
  order type" in `DEV_NOTES.md`.
- ✅ **Shipped**: two Leak/Service-only refinements. The Warranty Guidelines reference
  (see above) is now gated to Leak/Service only — Mark: the lists are "for leaks and
  leaks only," not Repair/Change Order/Inspection/Warranty. Added an optional
  Manufacturer Service # field alongside it, for the manufacturer work order a
  warrantable leak usually has ("~9 times out of 10," per Mark) — a single text field,
  prints on the leak report when filled. See "Warranty guidelines restricted to
  Leak/Service + Manufacturer Service #" in `DEV_NOTES.md`.
- ✅ **Shipped**: fixed three real gaps behind report PDFs going missing from
  CompanyCam for several real jobs (Planet Fitness, St. Mary's Hospital, St. Joseph's,
  Westminster). Selecting an already-linked building via 🔍 Select Existing Building
  now carries that CompanyCam link into the work order (it never did before); Download
  PDF now attempts the CompanyCam save too, same as Send/Share (it never did before);
  and every report/timeline entry now shows a persistent "☁️ Saved to CompanyCam" /
  "⚠️ Not saved to CompanyCam" badge (with the error text on a real failure), so a skip
  or failure is never invisible again. See "CompanyCam PDF upload gaps" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: home-screen/PWA app icon, built from the new RoofOps logo
  Mark provided (metallic "RO" house monogram, cropped for legibility at real icon
  sizes). Wired via `manifest.json` + `apple-touch-icon`/`theme-color` tags. The dev
  build's icon carries a red "DEV" ribbon so it's visually distinct from production;
  clean (unbadged) production icons are generated and committed to `icons/prod/` but
  not yet wired in — that's the last step when this carries over to `main`. See
  "Home-screen app icon" in `DEV_NOTES.md` and `icons/README.md`.
- ✅ **Shipped (dev only)**: photo-capture rework, so photos are captured in context
  (right in a finding, or a change order's scope) instead of a separate section to
  link up afterward. **Increment 1**: "📷 Take Photo" opens the device camera
  directly and grabs GPS at capture time; associating that photo with a finding
  auto-drops a pin from it (never overwrites a manual placement). **Increment 2**:
  each finding now has its own capture buttons and photo strip, right in its card —
  caption/finding-link/auto-pin all in one action, no dropdown needed. Same
  underlying `photos[]` array as before (just filtered by finding), so every
  existing work order's photos display correctly with zero migration — verified
  against a legacy-shaped work order directly. **Increment 3**: Change Order gets its
  own photo capture too (it has no findings, so every photo on it just belongs to the
  change order) — each photo gets its own auto-pin (`photo.pin`, new/additive field),
  and photos already printed into the change-order PDF automatically since it already
  read from the same array. The global Photo Documentation section is unchanged
  throughout all three increments — still shows everything, still controls print
  order. See "Photo-capture rework" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: two cleanup items from Mark's review of the above. (1)
  Change Order's form now shows only what it needs — Roof Investigation Findings, the
  plain Work Performed list, and the global Photo Documentation section (which was
  showing the same photos twice, since Change Order has its own in-scope photo box)
  are all hidden for that type; every other type is unaffected. (2) Photo size is no
  longer a per-user toggle — it's one admin-controlled global setting
  (`app_settings/global` in Firestore, admin-PIN-gated write via `admin.js`),
  defaulting to small for everyone. See "Change Order form cleanup" and "Global photo
  size setting" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: Saved-tab access control. Delete, Export ("for the tax" —
  actually the device-to-device `.workorder.json` transfer mechanism, not an
  accounting export), and Import Work Order File are now all admin-only — a
  non-admin's Saved tab only offers Open. Delete was previously not gated at all
  (any user could delete any saved work order); all three are now dual-gated
  (hidden button + a function-level check), same pattern as every other admin-only
  action in the app. **Open still puts a non-admin into the fully-editable Edit
  form** (same as creating/editing any work order, complete with Save) — there is no
  read-only "review" mode yet; that's a decision still pending with Mark, not
  something this pass changed. See "Saved view access control" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: three more form changes from Mark's review. (1) Change
  Order drops its Warranty Determination section entirely — it's a scope-of-work
  document, not a warranty investigation. (2) Import from CompanyCam moved up into
  each finding's own card (attach + auto-pin in one action, same as camera/library
  captures); the lower/global section's Take Photo and Add Photos buttons are gone
  for Leak/Service, Inspection, and Warranty (Repair keeps them — it has no findings
  to capture into at all). (3) Every photo on a findings-based work order type now
  needs both a caption and an assigned finding before Save will succeed. See "Change
  Order: no Warranty Determination," "Leak-form photo restructure," and "Caption +
  finding enforcement" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: field-value memory/autocomplete, following
  up on the same-day research above that confirmed it didn't exist. Ten fields
  (Job Name, Location, Bill To, Billing/Site Contact, Contact Phone, Technician,
  finding/repair Location-Detail, Repair Item Notes, every photo caption, and roof
  asset Label) now remember the last ~25 distinct values typed into them and
  suggest them via a native `<datalist>` — on-device only (`localStorage`), no
  Firestore writes. See "Field-value memory / autocomplete" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: Export is gone entirely, superseding part of
  the Saved-tab access-control pass above — not just admin-gated, removed ("I don't
  need an export button at all"). Import is left in place for now, flagged as a
  possible next removal since its only source file (Export's output) no longer
  exists in-app. See "Export button removed" in `DEV_NOTES.md`.
- 🔄 **Built, then CANCELED by Mark (2026-07-10)**: view-only mode for an
  already-submitted work order. Mark clarified after the fact that non-admins CAN
  edit and re-save any work order, submitted or not — the same as it always worked.
  Fully removed the same day, before this reached him live; confirmed no trace of
  the lock code remains and a non-admin can open/edit/re-save a submitted work
  order again. See "View-only mode for a submitted work order — built, then
  CANCELED by Mark" in `DEV_NOTES.md`.
- ❌ **Decided against (2026-07-09)**: pushing app-added phone photos to a matching
  CompanyCam project. CompanyCam's photo-upload API requires a publicly-fetchable URL
  per photo, which this app can't produce without paying for Firebase Storage or
  equivalent hosting — Mark decided that cost isn't justified right now. **The
  integration stays pull-only**: importing photos FROM CompanyCam into a work order
  continues to work as-is (including the improved error messaging shipped alongside
  this decision). Not a "someday" item — closed. See "Push app-added photos to
  CompanyCam" in `DEV_NOTES.md` if it's ever revisited (matching-strategy preferences
  are preserved there).
- Review Firestore security rules for all collections currently touched by the app.
- Add lightweight manual QA steps for field workflows: create, save, reload, import CompanyCam photos, generate PDF, send email, and verify history logging.
- ✅ Shipped: duplicate-report detection on the building timeline (same work order +
  report type within 5 minutes flags a "possible duplicate" badge) as a safety net
  around report/history logging.
- ✅ **Shipped**: exactly one Building History timeline entry per work order, ever —
  fixed a real production bug where resending a report to more people, resharing, or
  resaving each added another timeline entry (2 of 5 real work orders had duplicates
  before this fix, up to 4 entries for one job). Now upserted by work order id instead
  of inserted fresh every time; recipients accumulate onto the single entry rather than
  the latest send overwriting the list. Existing duplicates from before the fix are
  left alone on purpose (a live-data cleanup needs separate sign-off — a proposal is
  written up, not performed). See "One timeline entry per work order" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: report-email "Send to" recipient defaults.
  Dropped the hardcoded "Office —"/"Manager —" role LABELS (Charlotte and Mark
  stayed as plain named quick-picks — an earlier pass mistakenly dropped them
  entirely, corrected same day). Final behavior after a second correction:
  Leak / Service defaults to `charlottew@watkinsroofing.net` alone (she handles
  billing); every other type has no default To at all. marks@ is deliberately
  **not** a default anywhere — the always-on BCC to marks@ (enforced
  server-side, unconditional) already covers him, so making him a default To
  too would double-send. He's still fully selectable on the quick-pick
  dropdown, just not pre-selected. Any address actually sent to via "Send
  Email Now" is remembered (name-prompted, deduped case-insensitively,
  persisted) as a future quick-pick. If marks@ ends up in To anyway (picked
  manually), the guaranteed BCC is skipped for that send so he never gets two
  copies. The separate Reply-To (marks@ + charlottew@, server-side) is
  unaffected. See "Email Send-to recipient defaults", "Email Send-to
  corrections", and "Email Send-to defaults, round 2" in `DEV_NOTES.md`.
- ✅ **Shipped**: Inspection work order type built out into a real form
  (previously just the generic Leak/Service form with almost no
  differentiation, per the Repair work-order-type entry above — now
  resolved for Inspection; Warranty still pending). No Reported
  Leak Area (not a leak-triggered visit); Warranty Determination hidden
  entirely; findings section kept but relabeled "Roofing Inspection
  Findings" (still manually-addable one at a time, same as Leak/Service).
  The core new piece: a fixed 8-component **Inspection Checklist**
  (Membrane/Field, Flashings & Terminations, Penetrations, Drainage incl.
  Ponding, Rooftop Equipment, Perimeter/Edge, Interior if accessible,
  Safety Hazards), each rated Good/Fair/Poor/Critical/N/A with optional
  notes + an optional photo — anything rated below Good automatically
  surfaces as a finding (created/updated/removed in step with the rating,
  never touching a tech's own manually-added findings). Also added the
  first roof-picker on the main work-order Edit form itself (previously
  roof selection only ever happened indirectly, inside the pin-placement
  modal) — shows up whenever the building has more than one roof. All
  three report outputs (text/HTML/PDF) updated to match: new title,
  checklist table, relabeled findings, Reported Leak Area and Warranty
  Determination both omitted. Deliberately scoped to rating+notes only — no
  weighted health-score rollup across components (flagged as a natural
  follow-up if it grows into something bigger). See "Inspection form
  overhaul" in `DEV_NOTES.md`.

## Phase 2: Building/Site History Foundation

Goal: make every work order contribute to a durable customer/building record.

- Formalize `customers` and `buildings` as first-class Firestore collections.
- ✅ **Shipped**: an explicit "🔍 Select Existing Building" picker in the Edit tab —
  search/pick an existing building and its Job Name/Bill To/Location/Roof System fill
  in from the stored record instead of being re-typed. Additive alongside the existing
  derive-from-form behavior (same Firestore shape, same doc-id derivation), aimed at
  cutting down typo-created duplicate buildings/customers. See `DEV_NOTES.md`.
- ✅ **Shipped**: opening a CompanyCam project (via Import from CompanyCam) now also
  fills Job Name — the form's building-identity field; there's no separate "Building
  Name" input, `jobName` is what `buildings.name` is derived from — from the project's
  name, alongside the existing Location-from-address autofill. Same
  fill-if-empty-or-upgrade-partial rule on both fields, never clobbers a different
  manual entry or the building picker's explicit pick. See "Linking a work order to a
  CompanyCam project" in `DEV_NOTES.md`.
- Normalize building identifiers, customer relationships, addresses, roof system data, and CompanyCam project links.
- Expand report/history logging without interrupting field users.
- Prepare Firestore indexes for building history views and dashboard queries.
- ✅ **Shipped (dev)**: a building can now have one or more roofs (`roofs[]` on the
  building doc), each with its own roof system, base map, assets, and outlines —
  additive and backward-compatible with production's still-singular-field reads. Roof
  selector + "+ Add Roof" in Building History; work orders/finding pins now record and
  filter by which roof they're for; RoofMapper's save-to-building and the admin
  base-map upload/clear are both roof-aware. Remaining known gap: the building
  picker/list's one-line summary still reads the legacy `roofSystem` field
  (display-only). See "Multiple roofs per building, part 1 & 2" in `DEV_NOTES.md` and
  `DATA_MODEL.md`.
- ⚠️ **Partially shipped**: possible-duplicate buildings (same customer, very similar
  name) are now flagged with a badge in Building History, conservatively (same
  customer required, to avoid false positives). Merging flagged duplicates is
  designed but intentionally not yet built — it's a destructive live-Firestore-write
  action pending explicit product sign-off, not just a code-level call. See
  "Duplicate building detection" in `DEV_NOTES.md`. Renamed customers and
  multi-building sites are still undecided.

## Phase 3: Roof History Timeline

Goal: turn each building into a long-term roof record.

- Build a richer building history timeline from work orders, reports, photos, warranty decisions, and CompanyCam metadata.
- ✅ **Shipped**: timeline filters — date range, roof area, technician, warranty
  status, and report type, all client-side over the already-fetched timeline (no new
  query/index/schema). See "Timeline filters" in `DEV_NOTES.md`. Leak type / repair
  type filters not yet built — those aren't currently their own fields on a
  `building_history_events` doc (only free-text `conditionsSummary`/`repairsSummary`).
- ✅ **Shipped**: manually logged activities — "+ Log Activity" in Building History
  creates a timeline entry without a generated PDF/report behind it (Service Call, Leak
  Investigation, Repair, Roof Replacement, Warranty Inspection, Drone Flight, Thermal
  Scan, Moisture Survey, Customer Conversation, Note/Other), roof-scoped, each its own
  separate entry (not merged like a resent report). Closes gap #2 from the 2026-07-09
  vision gap analysis. See "Manually logged activities" in `DEV_NOTES.md`.
- ✅ **Shipped**: admin-editable roof profile fields — install date/age, health score,
  condition, warranty (provider/expiration/status), manufacturer, deck type,
  insulation type, drainage notes, customer contacts, internal notes, replacement
  history, estimated remaining life — one profile per roof, visible to everyone,
  editable only in Admin mode via a new `netlify/functions/admin.js` action
  (`set_roof_profile`), matching the existing custom-base-map precedent. Closes gap #3
  from the 2026-07-09 vision gap analysis. See "Admin roof-profile fields" in
  `DEV_NOTES.md`.
- ⚠️ **Scoped, partially addressed — not fully built, and part of it is
  deliberately blocked**:
  - **Photo source records**: found and fixed a real bug undermining the
    *existing* mechanism (`companyCamPhotoIds` on `building_history_events`/
    `reports`) — `finding_id`/`ccPhotoId`/`gps` were silently dropped on every
    cloud save/reload round-trip. Fixed forward-only. See "Photo shape adds"
    in `DEV_NOTES.md`. Locally-uploaded (non-CompanyCam) photos still have no
    stable per-photo id, so they can't be individually reference-tracked the
    same way — doing that safely means restructuring the photo subcollection's
    doc-id scheme (currently positional, `p0`/`p1`/…), which touches the core
    save/sync path every work order goes through. Judged too risky to take on
    as a drive-by improvement; revisit deliberately if it's ever actually needed.
  - **Report PDFs**: still have no durable reference for work orders without a
    linked CompanyCam project — `pdfRef` stays `null` by design. Solving this
    means either Firebase Storage or some other persistence layer, and
    reintroducing Storage is explicitly gated behind checking with the user
    first (see README's ground rules) — a product decision, not a code one.
    Not built; not attempted.
- ✅ **Shipped**: roof maps and leak pins. Every finding can be pinned (satellite by
  default via free Esri tiles + Nominatim geocoding, photo-GPS as a corrected initial
  guess, a custom uploaded roof plan/sketch for roofs where satellite isn't legible
  enough, or a real georeferenced drone orthomosaic for full accuracy). Every building
  has a history map aggregating every pin from every past report, color-coded by
  warranty status. See `DEV_NOTES.md` for the full design, including
  `tools/geotiff_to_webmap.py`, the companion script that converts a drone GeoTIFF
  into what the app needs.
- ✅ **Shipped**: permanent roof asset markers (drains, scuppers, HVAC units, pipe
  flashings, vents, hatches, expansion joints, skylights, curbs, penetrations, core
  cuts, test cuts, safety hazards) on the same Roof Map — distinct from finding pins
  (permanent/independent of any report vs. historical/tied to one), any tech can
  add/move/remove them, no admin gating. See "Roof assets" in `DEV_NOTES.md`.
- ✅ **Shipped**: RoofMapper (Phase 1) — a new tab that GPS-locates the tech, searches
  free OpenStreetMap/Overpass building footprint data nearby, lets the tech tap the
  correct footprint, generates a clean roof outline (area/perimeter), and saves it to
  a building's `roof_outlines[]` (or locally if offline/unlinked) and/or exports
  SVG/PNG/PDF — all client-side, no paid services. Outlines also render on the
  existing building-wide Roof Map. See "RoofMapper" in `DEV_NOTES.md`. Explicitly out
  of scope for Phase 1 (future expansion, same additive array-on-building-doc
  pattern as roof assets): drains/HVAC/scuppers/pipe penetrations as outline-linked
  features, dimensions/measurements beyond area & perimeter, CompanyCam photo
  attachment to an outline, drone orthomosaic overlays for outline capture, and
  outline history/versioning beyond "array is append-only, newest is current."
  **Fixed after a real field test**: search radius was too tight (60–150m) and the
  Overpass query only matched `building=*`-tagged footprints — missed a real hospital
  because its OSM footprint is tagged `amenity=hospital` with no `building` tag at
  all. Radius ladder is now 150/300/500m (accuracy-aware starting point, "Search
  Wider" to expand) and the query also matches amenity/healthcare/shop/office/leisure
  tags. **Second fix, same field test**: the broadened query then surfaced the
  hospital's own polygon, but it's a whole-campus property boundary (~969,000 sq ft,
  no `building=*` tag at all in OSM) — not a roof. RoofMapper now classifies
  untagged, oversized polygons as a "site boundary," prefers real building
  footprints whenever any exist nearby, and only offers a site polygon as a
  clearly-labeled, confirm-gated fallback when nothing better was found. See
  "RoofMapper" in `DEV_NOTES.md`.
- Not yet built: manual anchoring for non-georeferenced (roof plan/sketch) maps
  (deliberately excluded by the spec), roof-section labels/filters.
- ✅ **Shipped (dev only)**: RoofMapper ↔ Roof Map unification — Phase 1 (connect).
  Mark's end-state vision: capture the roof outline in RoofMapper (or eventually
  drop in a satellite/drone image) → that outline becomes the canvas you place
  features on → drains, HVAC, leaks, repairs, all on the roof you just mapped →
  it all lives on the building's history. Phase 1 connects RoofMapper's
  outline-save straight into the existing roof-asset feature-placement flow: save
  an outline → automatically land on that roof's Building History roof map
  (outline already drawn there) → "+ Add Roof Feature" now also draws the outline
  inside the placement modal itself as you place the pin. Reused the existing
  roof-asset placement and multi-roof roof-scoping as-is — no rebuild. See
  "RoofMapper ↔ Roof Map unification" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: RoofMapper ↔ Roof Map unification — Phase 2
  (unified surface, zoom, full-roof export). "Map the roof, then mark it up
  on that same roof, then export the whole blueprint." Saving an outline no
  longer routes away to Building History (Phase 1's behavior, superseded) —
  RoofMapper reveals a "Roof Features" card right there, draws that roof's
  existing features on its own map, and "+ Add Feature"/tapping a marker
  opened the existing `openAssetModal()` placement engine (superseded by
  Phase 2.5 below, which moved placement directly onto RoofMapper's own map).
  Map height increased (55vh/460px → 70vh/640px),
  zoom/scroll/pinch explicitly confirmed on, and generating an outline now
  auto-zooms into it (previously stayed at the wide multi-candidate search
  view) — plus a manual "🔍 Zoom to Roof" button. Exports (SVG/PNG/PDF) now
  pull in that roof's permanent features and historical finding pins and
  draw them on the outline as one blueprint, with a legend — outline-only
  export is preserved byte-for-byte when the outline isn't linked to a
  building. **Flagged, not built**: finding-pin (leak/repair) placement
  itself stays outside RoofMapper — a pin belongs to a specific work order's
  finding, and RoofMapper has no "current work order" context to attach one
  to; those pins still get placed the existing way and do show up in the
  full-roof export once they exist. Assets/pins on a roof's custom base map
  (x/y, not georeferenced) can't be shown inline or in the export — same
  lat/lng-only limitation the outline itself already has. See "RoofMapper ↔
  Roof Map unification -- Phase 2" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only)**: RoofMapper ↔ Roof Map unification — Phase 2.5
  (feature placement folded directly onto RoofMapper's own map). Fully
  realizes "map it, then mark it up on that same roof" — "+ Add Feature"
  and tapping an existing marker no longer open the separate asset-modal
  overlay at all; a draggable marker appears right on `rmState.map` with a
  small inline form (Type/Label/Notes) in the Roof Features card, reusing
  `rmZoomToOutline()` from Phase 2 so there's room to work. The Firestore
  read-modify-write itself was extracted into shared `persistRoofAsset()`/
  `removeRoofAsset()` helpers used by BOTH this inline flow and Building
  History's modal, so there's one persistence path, not two that could
  drift apart — the modal itself still exists and still works standalone
  for Building History's "+ Add Roof Feature." **Still correctly out of
  scope, same as Phase 2**: finding-pin (leak/repair) placement stays
  outside RoofMapper (no "current work order" context to attach one to);
  custom (x/y) base-map assets still can't place/show inline (lat/lng
  only). Photo auto-pin is untouched — separate code path entirely. See
  "RoofMapper Phase 2.5" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only), part 1 of 3**: RoofMapper ↔ Roof Map unification —
  Phase 3, satellite view + manual trace. Lets a tech map a roof even where
  OpenStreetMap has no building footprint at all (the real case that
  prompted this — St. Joseph's Hospital). A "🛰️ Switch to Satellite View"
  toggle swaps RoofMapper's tile layer (same free Esri imagery already used
  elsewhere, no paid service); "✏️ Trace Manually Instead" auto-switches to
  satellite and lets the tech tap the roof's corners directly on the map to
  build an outline by hand (Undo/Finish/Cancel), producing the exact same
  outline shape as an OSM-captured one (just `source:"manual_trace"`
  instead of `"osm"`) — so saving, exporting, and Phase 2.5's inline
  feature placement all work on it with zero extra code. See "RoofMapper
  Phase 3, part 1" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only), part 2 of 3**: "🚶 Walk the Corners" GPS
  footprint capture — a third capture method alongside OSM search and
  manual trace, for when neither OSM nor satellite imagery is usable at
  all. Walk to each corner of the roof, tap "📍 Record This Corner"
  (reuses the same `rmGeoRequest()` geolocation wrapper `📍 Use My
  Location` already uses), repeat, tap Finish — reuses the exact same
  trace engine manual trace already built (`rmTraceState.mode` is the only
  difference: points come from a GPS fix per tap instead of a map tap),
  producing the same outline shape tagged `source:"walk_corners"`. GPS
  accuracy reality is flagged directly in the UI, not just documented: the
  mode's hint text states "roughly ±10–30 ft per corner... not
  survey-grade," and each recorded corner's actual accuracy shows in the
  confirmation toast. A rough-but-adjustable footprint, not survey-grade —
  exactly the field method needed when OSM/satellite both fail. See
  "RoofMapper Phase 3, part 2" in `DEV_NOTES.md`.
  **Part 3, explicitly NOT built — flagged for a product decision**:
  uploading a drone/custom image as the capture canvas. Researched the
  existing image pipeline (`renderBaseMapAdminCard`, `resizeImageFile()`,
  `tools/geotiff_to_webmap.py`) — the blocker is that the app's only way to
  get a public image URL is CompanyCam's `upload_document` API, which
  requires the building to already have a linked CompanyCam project.
  RoofMapper is meant to work on roofs that may not even have a RoofOps
  building record yet, let alone a linked CompanyCam project — building
  this properly needs Mark to decide either (a) require picking/linking the
  building before offering image upload (inverts RoofMapper's current
  locate-first flow), or (b) reintroduce some image-hosting mechanism
  (Firebase Storage is explicitly gated behind checking with the user
  first — see the Storage policy elsewhere in this doc and in
  `DEV_NOTES.md`). Not attempted; not routed around.
- ✅ **Shipped (dev only, 2026-07-10)**: RoofMapper refinements from
  Mark's real-world dev testing. Fixed a real bug where editing an existing
  feature left a duplicate, non-draggable ghost marker behind at its old
  spot (the actual cause of "moving them around" not feeling right) —
  markers now always redraw cleanly with exactly one hidden/editable at a
  time, verified even when switching directly between two markers mid-edit.
  Added "🗑️ Delete Outline" so there's finally a way to get rid of
  whatever RoofMapper just generated — clears the working canvas always; if
  the outline was already saved to a building, it does NOT delete that
  saved Firestore record (`roof_outlines[]` is append-only with no delete
  mechanism anywhere in the app, including Building History's own Roof Map
  — building real delete-from-Firestore for saved roof history is a bigger
  decision, flagged rather than quietly added). See "RoofMapper
  refinements" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: "Clear Base Map" surfaced from
  RoofMapper itself. The capability already existed (Building History's
  admin base-map card) — just wasn't reachable from where Mark is actually
  working now. RoofMapper shows a status line (admin-only Clear button,
  same gating as the existing card) when the linked roof has a custom base
  map, reusing the exact same admin-gated `clearRoofBaseMap()` path, not a
  new one. See "RoofMapper: surfaced Clear Base Map" in `DEV_NOTES.md`.
- **Dimensions** (next major RoofMapper capability after the movable/
  deletable-icons + delete work above; confirmed with Mark, not yet built).
  Two distinct parts:
  1. **Automatic per-edge perimeter dimensions**: the length in feet of
     EVERY side of the roof outline, computed and labeled automatically,
     shown right on the map — not just the single total-perimeter number
     RoofMapper already shows today. Applies to any captured outline
     (OSM footprint, manual trace, or the planned walk-the-corners method)
     since it's pure geometry off the existing `ring` points.
  2. **User-added dimension lines to features**: let the tech draw/add a
     measurement line FROM a placed feature (e.g. a drain) to a roof edge
     or to another feature, so the export/blueprint shows exactly how far
     things are from each other, not just where they are. Distinct from
     #1 (perimeter is automatic and roof-wide; this is manual and
     feature-specific).
- **Sections**: divide one roof outline into multiple labeled sections (e.g.
  by roof system or area), each with its own computed area, tying into the
  existing multi-roof/roof-section data model rather than a parallel one.
- **AI auto-detection of rooftop features (future / when-funded)**: a
  computer-vision pass over satellite or (especially) drone imagery that
  identifies RTUs/HVAC units and other larger rooftop features and suggests
  placements for the tech to confirm, instead of every feature being placed
  by hand. Explicitly a later, likely-paid capability — needs a vision
  service or a trained model, and only really works at drone resolution;
  small features like drains generally aren't detectable from satellite
  imagery. Not being built now. The near-term approach stays manual
  placement plus the existing photo-GPS auto-pin (see "photo-capture
  rework" in `DEV_NOTES.md`).
- ✅ **Shipped (dev only, 2026-07-10)**: RoofMapper footprint deselect. Real
  gap Mark hit — once a footprint was selected there was no way back if it
  was the wrong building. Added a "✕ Wrong Building? Choose Again" control,
  plus fixed a related latent bug found in the process: tapping a
  *different* footprint directly (without deselecting first) didn't clear a
  previously generated outline either, so a stale outline from the wrong
  building could persist. Both paths now share the same clearing logic — no
  way to end up with mismatched selection/outline state. Purely a local
  clear; doesn't delete anything already saved to Firestore. See "RoofMapper:
  deselect a wrong footprint" in `DEV_NOTES.md`.
- 🚧 **In progress (dev only)**: Outlook / Microsoft 365 integration, so emails
  become part of a building's history the way CompanyCam photos already are.
  **Phase 0 (auth + mailbox read) shipped**: `netlify/functions/outlook.js` +
  `lib/graphAuth.js`, app-only Microsoft Graph access to Mark's mailbox
  (`marks@watkinsroofing.net`), same server-side-secret pattern as the
  CompanyCam/Resend integrations. Access is scoped by an Exchange Application
  Access Policy to a specific security group, which can take up to ~30 minutes
  to propagate after a mailbox is added — see "Outlook / Microsoft 365
  integration" in `DEV_NOTES.md` for the live connection-test result and exact
  env vars. **Not yet built**: Phase 1 (organize mail into folders by sender —
  needs a broader Graph permission grant first) and Phase 2 (auto-file
  inspection-report PDFs to the matching CompanyCam project).
- ✅ **Shipped**: sharper satellite imagery for pin placement on large roofs. Field
  feedback: accurate placement, but big roofs need to zoom out to fit, and the
  imagery gets blurry there. Manual roof-tracing was floated as a fix and explicitly
  paused (not built). Verified Esri's `World_Imagery` service against live tile data
  (not just its schema) to find each location's true resolution ceiling, then set
  `maxNativeZoom`/`maxZoom` so Leaflet over-zooms (CSS-enlarges) the last real tile
  instead of wastefully re-fetching non-existent deeper tiles — bigger, easier-to-tap
  imagery on big roofs, no new information conjured, no cost, no pin-accuracy change.
  Researched and ruled out: a separate Esri "Clarity" endpoint (doesn't exist —
  that's the layer already in use), USGS imagery (no coverage at the test site), any
  paid provider (against the no-paid-services constraint). The existing
  drone-orthomosaic/uploaded-base-map path remains the answer for a roof where even
  over-zoomed satellite genuinely isn't enough. See "Satellite resolution for pin
  placement" in `DEV_NOTES.md`.

## Phase 4: Dashboard/Admin/Users

Goal: support office/admin workflows and controlled access.

- ✅ **Shipped, first Dashboard seed**: a read-only "Reports" tab — every generated
  report across every building, most recent first, filterable by search text, date
  range, roof area, technician, warranty status, and report type. Reads the `reports`
  collection (written since early in the project, never read until now) — no new
  index needed since it's a single unfiltered query with client-side filtering. Tap a
  report to jump to its building's timeline. See "All Reports view" in `DEV_NOTES.md`.
- ✅ Interim shipped ahead of this phase: a PIN-based "admin mode" gates
  unlink/delete controls from field techs, with the PIN check and the actual
  deletes both enforced server-side (`netlify/functions/admin.js` + Firestore
  rules) rather than just hidden in the UI. Real enforcement, but one shared PIN
  rather than per-user accounts — replace with real accounts/roles below rather
  than extending it further.
- Add user accounts, roles, and permissions.
- Add an admin/dashboard experience for searching customers, buildings, work orders, reports, and history events.
- Add account/company settings for branding, default emails, report templates, and integration settings.
- Add user assignment, technician tracking, and audit metadata.
- Decide whether the field app remains a single page or becomes one module in a larger app shell.

## Phase 5: Future SaaS Platform

Goal: evolve RoofOps into a multi-account SaaS platform.

- Introduce `accounts` as the top-level tenant boundary.
- Scope every customer, building, work order, report, photo, setting, and user permission by account.
- Add billing/subscription support outside the field app.
- Build repeatable onboarding for new roofing companies.
- Add customer portal, advanced analytics, external integrations, and configurable report templates.
- Plan data migration from the Watkins single-account structure to the multi-account structure.

## Guiding Constraint

Each phase should protect the working field workflow. Future modules should extend the current app through documented data contracts rather than replacing proven features prematurely.
