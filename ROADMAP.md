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
- ✅ **Shipped (dev only, 2026-07-10)**: in-app signature capture. That blank
  signature line on the Change Order PDF is now a real captured signature — a
  "✍️ Get Signature" action opens an on-device signature pad (canvas, finger/
  stylus/mouse) alongside a required "Print Name" field and an auto-filled
  date; saving embeds the drawn signature image, printed name, and date into
  the Change Order PDF, HTML preview, and plain-text output (a standard
  Signature/Print Name/Date block), replacing the blank line — no signature
  captured still falls back to the original blank line, unchanged. Built as a
  standalone reusable component (`openSignaturePad()`), not Change-Order-
  specific, so it can be wired into other forms later — e.g. leak/
  non-warranty service-order signing, once the email-doc-attach feature
  lands. See "In-app signature capture" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: "Select Existing Building" (Job
  Information card, every work order type — Mark hit this from a Change
  Order specifically) now surfaces the WHOLE CompanyCam project file, not
  just buildings already created in this app. A new "☁️ From CompanyCam"
  section alongside the existing app-buildings list, searchable (typing
  searches both — CompanyCam's search reaches its whole project file, not
  just an initial page); a CompanyCam project already linked to an app
  building shows once, as that building (never duplicated); picking a
  CompanyCam-only project fills the fields, links it, AND immediately
  creates/links a real building record so RoofMapper/history/reports all
  have something to attach to right away, not just at save time. Handles a
  slow/unavailable CompanyCam API gracefully — falls back to the existing
  buildings list with a message, never blocks it. Sheet-metal CompanyCam
  projects are NOT excluded here (that exclusion applies only to a future
  CompanyCam consolidation/merge cleanup task, not this picker) — every
  project is selectable. See "Change Order building picker" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: two small RoofMapper polish items
  from Mark. "📍 Use My Location" shrunk from an oversized full-width
  button to the same compact size as everything else on the card. Address
  search no longer requires standing at the GPS location or matching
  CompanyCam/an existing building — type any address and it geocodes
  (same Nominatim path pin placement uses) straight into the same
  location-found pipeline GPS success already uses, so a brand-new roof or
  scouting stop with zero CompanyCam/building match works exactly like any
  other located point. See "RoofMapper: compact locate button + free-typed
  address search" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: Send Feedback — a 💬 button reachable
  from every screen (fixed corner, present on all tabs) opens a quick-type
  picker (👍 Works great / 🤔 Confusing / 🐞 Bug / 💡 Feature request) plus
  comments and an optional screenshot (device screen capture via
  `html2canvas`, or attach a photo as a fallback). Every submission
  auto-captures its context with no typing needed — which screen, the
  technician (best-available identifier — there are no real accounts yet),
  admin-mode status, device, and the open work order (if any) — and both
  saves to a new `feedback` collection for an admin-only backlog view (on
  the Reports tab) AND emails Mark a copy, always with a stable
  `"[RoofOps Feedback]"` leading subject token (e.g. "[RoofOps Feedback] 🐞
  Bug — Inspection Form") regardless of type, specifically so a mail rule
  can file every one of these into one Outlook folder reliably once
  delegated auth/inbox rules are live (see "Outlook / Microsoft 365"
  below). **The `feedback` collection's Firestore rule needs a manual apply
  in the Firebase Console to take effect** (same as `app_settings`) — not
  automatic from this repo. See "Send Feedback" in `DEV_NOTES.md`.
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
- ✅ **Shipped**: Inspection checklist photo pinning — checklist items
  (Membrane/Field, etc.) now capture a photo via in-app camera ONLY (no
  library add, no CompanyCam import — Mark: the tech is photographing the
  exact condition they're rating, right there), and that capture
  **auto-drops a pin** at the tech's GPS location on the roof map, reusing
  the same auto-pin mechanism findings already use. The pin shows up on
  the building's Roof Map "reviewable by someone else," not just saved on
  the work order. **The payoff, captured here rather than built yet**:
  this pin is the anchor for **before/after comparison** — the inspection
  photo is the "before" at that exact spot, and when a repair is later
  made there, a repair photo at the same pin becomes the "after." The pin
  itself is what's shipped now; an actual side-by-side before/after
  comparison VIEW (matching a later repair photo against this inspection
  photo at the same location) is future work — the anchor has to exist
  first. See "Inspection checklist photo pinning" in `DEV_NOTES.md`.

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
- ✅ **Shipped (dev only, 2026-07-10)**: individual-roof tracing + labels —
  the multi-roof vision pillar above, made actually usable from RoofMapper
  itself. Mark: "no way to trace individual roofs, and each roof needs a
  LABEL." Saving an outline to an existing building now always offers
  **"+ Add a new roof…"** (previously a single-roof building saved with no
  picker at all, so a genuinely second roof had no way to become its own
  roof — it silently merged into roof #1's outline history; real bug,
  fixed). Roof labels are now **persistent on the map** (a small labeled
  pin at each outline's centroid, not just picker-dropdown text or a
  tap-triggered popup), **renameable any time** after creation (not just
  once, at creation), and Building History's roof map now shows **every
  roof on a building at once**, each labeled, instead of switching
  one-at-a-time — roofs genuinely "coexist" now. See "Individual-roof
  tracing + labels" in `DEV_NOTES.md` for the full scope. The one piece
  deliberately deferred here (showing already-traced roofs as a live
  reference layer while tracing a new one) is no longer deferred — Mark
  hit exactly this gap live, on a roof, blocked on it — see "Multi-roof:
  stay in RoofMapper, trace another roof" below.
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
- ✅ **Shipped (dev only, 2026-07-10)**: Buildings Near Me — realizes the
  vision's "GPS recognizes when the tech arrives and shows the building
  history" pillar. A "📍 Buildings Near Me" card at the top of Building
  History gets the tech's current GPS and lists the closest building(s)
  already in the system, nearest first, each with its distance; tapping one
  opens straight into its full Building History — which already links
  CompanyCam, job numbers, past reports, and the roof map, so arriving on
  site now means confirming a building rather than searching for one.
  Resolves each building's location cheapest-first (a cached geocode, then
  the most recent RoofMapper outline's centroid, then a live address
  geocode as a last resort — cached afterward so it's a one-time cost per
  building). GPS denied or unavailable, or nothing nearby, both fall back
  cleanly to the existing search/list, unchanged. See "Buildings Near Me" in
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
- ✅ **Shipped (dev only, 2026-07-10)**: duplicate a placed roof feature —
  Mark: "point is speed when a roof has several of the same thing" (multiple
  RTUs, a run of roof-fence sections, etc.). Double-click a placed marker,
  or tap "📋 Duplicate" in its edit form, and it's copied (same type/label/
  notes) with a small nearby offset to drag into place — works for every
  feature type, not just one. Same `persistRoofAsset()` write path every
  other roof-asset edit already uses. See "Duplicate roof feature" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: RoofMapper's save flow gets the
  full CompanyCam picker too — Mark: no way to attach a traced outline to a
  building that only existed as a CompanyCam project (not yet a saved
  report). Mirrors the Change Order picker's CompanyCam merge (`098ae77`)
  exactly — search reaches the whole CompanyCam project file, dedupes
  against every already-linked app building, sheet-metal included (not
  excluded). Selecting a CompanyCam-only project creates/links the
  building and lands on the same roof picker ("+ Add a new roof…"
  included) the app-buildings path already used — that roof-add flow now
  works from either origin for free, no new code needed there. See
  "RoofMapper save flow: full CompanyCam picker" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11), both parts complete**: trace
  directly on an uploaded drone orthomosaic — Mark: adding orthos to
  CompanyCam projects but no way to use one as RoofMapper's tracing base.
  **Part 1**: "📷 Trace on My Own Drone Image" button, local upload from
  the device as the PRIMARY path (no CompanyCam project needed first).
  Since an exported ortho carries no geodata, this reuses the existing
  trace/Square Up/vertex-edit/Calibrate pipeline anchored at a synthetic
  (Null Island) origin instead of attempting real georeferencing — that
  pipeline already operates in local meters relative to a centroid, so it
  works with zero changes to any downstream geometry code. Outlines
  tagged `source:"ortho_trace"` + `tracedOnOrtho:true`. **Part 2**:
  "☁️ Trace From CompanyCam Photo" — the secondary path, pick an existing
  photo from the building's linked CompanyCam project instead of a local
  upload; and the ortho image itself is now retained with the roof for
  reopening (admin mode + a linked CompanyCam project required for this
  specific piece — the traced outline always saves regardless). Saved as
  `roof_base_map_type:"sketch"` (not `"drone_ortho"`) — a real, reasoned
  deviation from the original ask, since `"drone_ortho"` is treated as
  georeferenced everywhere else in the app and this ortho's bounds are
  synthetic; see DEV_NOTES.md for the full reasoning. See "Trace directly
  on an uploaded drone orthomosaic" and "Ortho upload: persist with the
  roof + pick from an existing CompanyCam photo" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11)**: three accuracy fixes Mark flagged
  as "core to the multi-roof workflow actually being trustworthy" —
  **scale inheritance** (calibrate one roof's edge, every LATER
  manual_trace/ortho_trace roof on that same building automatically
  inherits the correction, no re-measuring; a clear "Scale inherited"
  note shows in the UI with a one-tap override); **vertex snapping**
  (tracing or dragging a vertex near an already-traced roof's corner or
  edge locks onto it exactly — pixel-distance threshold so the snap
  radius feels the same at any zoom level — toggleable, and explicitly
  never applies to walked GPS corners); and a **precision crosshair
  cursor** (replaces the default hand cursor with a crosshair while
  tracing/editing/placing, plus a fixed on-map reticle + "Place at
  Crosshair" button as a touch-friendly pan-to-aim alternative to tapping
  under a finger that occludes the target). Also fixed the ortho overlay
  getting torn down on every "Trace Another Roof" tap (forcing a re-
  upload of the same photo for every roof section) — it now stays up
  across roofs on the same building. See "Multi-roof accuracy: scale
  inheritance, vertex snapping, precision cursor" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11)**: true GeoTIFF support — Mark's real
  orthos (DJI Mavic 3T + WebODM + RTK) are genuine georeferenced GeoTIFFs
  with centimeter accuracy, not flattened images. Uploading one now reads
  its embedded geodata and renders it at its TRUE geographic position on
  the map via `geotiff.js` + `georaster-layer-for-leaflet` — tracing on it
  needs **zero manual calibration**, since every map click is already
  real, accurate lat/lng. Correctly reprojects a projected CRS (UTM zone,
  what WebODM actually outputs — meters, not lat/lng) with no extra
  library needed, verified directly before building on it. A plain flat
  image (PNG/JPG, or a TIFF with no real geodata) still falls back to the
  existing Calibrate-based path from the local-upload feature above;
  clearly announces which mode was detected either way ("✅ Georeferenced
  (RTK) — scale set automatically" vs. falls back with a clear message).
  Large-file memory use flagged as a real constraint (120MB cap, clear
  message + fallback suggestion rather than silently risking a crash).
  Two real bugs caught in testing, both fixed before shipping: a
  GeoTIFF-writing library injecting a default placeholder CRS that isn't
  real geodata (caught via an implausible world-spanning bounding box);
  and a plain non-georeferenced TIFF silently failing since most browsers
  have no native TIFF image decoder at all (now stops with a clear,
  actionable message instead). Retaining a GeoTIFF-traced roof's image
  with the roof for reopening (same as Finding A's persistence piece) is
  a deliberate follow-up, not built this pass. See "GeoTIFF georeferenced
  ortho support" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-12)**: KMZ/KML GroundOverlay import for
  RoofMapper. The existing "Trace on My Own Drone Image" picker now accepts
  `.kmz` and `.kml` files; KMZ is opened as a ZIP, KML GroundOverlay metadata
  is parsed, the referenced orthomosaic image is extracted/matched, and the
  overlay is drawn from its north/south/east/west bounds for tracing. The real
  North College Street KMZ is a Google Earth super-overlay, so the importer also
  follows tiled KML/image folders, selects the highest-detail level, and renders
  those georeferenced tiles for tracing. Saved outlines use
  `source:"kml_groundoverlay_trace"` and preserve the overlay metadata; when the
  user is an owner/admin and the building has CompanyCam linked, the image is
  also retained through the existing georeferenced `drone_ortho` base-map path.
  KML rotation/quads are detected and warned about, but not rendered warped or
  rotated yet.
- 🐛 **Fixed (dev only, 2026-07-11)**: roof rename was undiscoverable from
  RoofMapper itself — Mark accidentally saved a second roof also named
  "Roof 1" and had no way to fix it. The rename function existed
  (`promptRenameRoof`, line 336 above claimed roofs are "renameable any
  time") but its only entry point was buried in Building History, and it
  navigated away on completion — unreachable and unusable from wherever
  Mark actually was. Now: the roof's own label on the map is directly
  tappable (shows a pencil hint) and RoofMapper's outline panel has an
  explicit **"🏷️ Rename Roof"** button, visible whenever a roof is linked
  including through Edit Shape mode — both stay on RoofMapper, no
  navigation away. Also closed the root cause: **duplicate-name
  detection**, shared by renaming and by "+ Add a new roof…" — reusing an
  existing roof's name (case/whitespace-insensitive) now warns and
  auto-suggests a unique alternative ("Roof 1 (2)") instead of silently
  allowing the collision. Rename propagates everywhere the label is read
  live (map, roof picker, Building History, exports) — none of it is a
  cached copy. See "Rename a roof, discoverable from RoofMapper" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11)**: split a roof outline into multiple
  labeled sections ("blob-splitting") — an auto-pulled OSM footprint or
  hand trace is often really several distinct roof sections at once (a
  warehouse + office annex, several buildings on one parcel). Tap
  **"✂️ Split Into Roof Sections"** before saving, then tap two points on
  the outline's own boundary to draw a straight split line — each
  resulting section is independently re-splittable (unlimited times),
  individually labeled ("Roof A"/"Roof B", or "Roof A1"/"Roof A2" when
  splitting a section further), shown in its own color on the map, and
  becomes its own real roof (own roofId/label/area/features) in one batch
  save. The same duplicate-name guard from the rename fix above applies
  here too. Geometry validated against synthetic test polygons (a plain
  rectangle and an L-shape, including a chord that correctly gets rejected
  for cutting outside the L-shape's own notch) before any UI was built.
  Deliberately out of scope: splitting an ALREADY-saved single roof (a
  more involved operation, replacing one roof's real history with
  several); adjusting a pending section's shape before saving (once saved,
  the existing Edit Shape / vertex dragging already covers it like any
  other roof). See "Split a roof outline into labeled sections" in
  `DEV_NOTES.md`.
- 🐛 **Fixed (dev only, 2026-07-11), HIGH PRIORITY**: RoofMapper export was
  badly broken — Mark's actual exported file showed the outline missing
  entirely, features as unlabeled floating dots, layout crammed into one
  corner of an empty canvas, dark background, no edge dimensions. Root
  cause: PDF export was a totally separate, hand-drawn jsPDF implementation
  that had silently diverged from SVG/PNG/Preview (no fill, no dimensions,
  no feature labels, fixed-size markers). Fix: PDF now rasterizes the exact
  same `rmBuildOutlineSvg()` every other format uses and embeds it as one
  image — no more second render path to drift out of sync, so Preview is
  finally a true guarantee across all three formats. Also added: edge
  dimension labels (using real calibrated lengths) and feature name labels
  to the shared drawing itself, so every format gets them; building name/
  address/roof label in the header; a canvas-size cap so large roofs don't
  produce absurdly oversized exports; `compress:true` on the PDF (an
  embedded image was coming out ~22MB uncompressed, ~<100KB with it). See
  "RoofMapper export: fix broken PDF / single shared render path" in
  `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11), URGENT (Mark live on a roof,
  blocked)**: multi-roof workflow actually works end-to-end now. After
  saving a traced roof, RoofMapper stays right there and offers "➕ Trace
  Another Roof" — no more backing out and re-entering (which also lost
  the building link, forcing a fresh search) to trace a second roof on
  the same building. While tracing the new one, the building's already-
  traced roofs show as a dimmed, labeled reference layer — outlines AND
  their pins/features, not just outlines — so a new roof is never traced
  blind next to one that already exists. Two more live bugs fixed via a
  different entry point (Building History → View Timeline → "Add another
  roof"): it was a dead end (created an empty, untraceable roof record —
  now routes into the real trace flow, same shared code path as the
  RoofMapper button) and its reference layer was outline-only (now shows
  pins/features too, same fix). Folded in: the map now zooms/fits to the
  known roof location on open instead of starting wide — fit-to-outline,
  then geocoded address, then GPS, in that order. See "Multi-roof: stay in
  RoofMapper, trace another roof" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-11)**: mobile header/toolbar pass — Mark:
  the top banner and buttons eat too much screen on mobile. Measured
  first: the header was 264–288px tall on a 375px phone (9 nav buttons
  wrapping to ~5 rows). Fix: icon-first buttons in one non-wrapping
  horizontally-scrollable row instead of wrap, slimmer logo/title, tighter
  spacing across `.wrap`/`.card`/`.btn`/`.rm-bigbtn` on mobile (padding
  only, not font-size, so tap targets stay comfortably finger-friendly —
  measured 41×40px), RoofMapper's map height bumped to use the reclaimed
  space, and an auto-hide-on-scroll header (down hides, up or top-of-page
  shows, skipped while a modal is open). Entirely scoped to a mobile media
  query — desktop/tablet unchanged. Caught two real bugs while building
  this: `updateAdminUI()`/`updateAccountUI()` were replacing the button's
  full `innerHTML` with plain text on every state change, silently wiping
  the new icon-only mobile markup after the first toggle. See "Mobile
  header/toolbar pass" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: easier map navigation — Mark found
  the map "a little hard to navigate." `touch-action:none` on the map
  container (the likely actual cause — without it the page's own scroll
  gesture can fight Leaflet's touch pan/pinch-zoom on mobile), bigger
  38px zoom +/- buttons (Leaflet's default 26px is a tight thumb target),
  and a floating "🎯" recenter button always reachable on the map itself —
  fits to the outline if drawn, else the footprint search results, else
  the located GPS point. See "Easier map navigation" in `DEV_NOTES.md`.
- ✅ **Shipped (dev only, 2026-07-10)**: export preview — a "👁️ Preview
  Export" button shows the outline + labels + placed features as SVG/PNG
  exports will actually look, before exporting. Reuses the exact same
  `rmBuildOutlineSvg()` pipeline those two exports already call (PNG
  literally rasterizes this same SVG), so the preview is guaranteed to
  match rather than being a second render path that could drift out of
  sync — PDF has its own from-scratch page layout, noted explicitly rather
  than implied to pixel-match. See "Export preview" in `DEV_NOTES.md`.
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
  "RoofMapper Phase 3, part 2" in `DEV_NOTES.md`. Its known roughness is
  exactly what the **Calibrate-by-known-edge** item under Dimensions below
  is for — a single tape-measured edge, entered by editing that edge's
  auto-shown dimension, rescales the whole footprint to be accurate; build
  it together with Dimensions, not as a separate walk-the-corners-only fix.
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
- ✅ **Shipped (dev only, 2026-07-10)**: RoofMapper UI cleanup, from Mark
  testing the trace flow live. Search-again buttons (Search This
  Area/Wider/Relocate) no longer linger once an outline exists or is being
  traced; mode-switch buttons (satellite/trace/walk) shrunk from full-width
  to small/compact, three in a row; trace controls (Undo/Finish/Cancel/
  Record) moved to sit directly below the map instead of a separate card
  requiring a scroll to reach; and once an outline is saved, all of that
  capture-phase clutter disappears and "Roof Features" (Add Feature) is the
  very next thing visible below the map. One centralized
  `rmUpdateControlVisibility()`, called at every phase transition, drives
  all of it. See "RoofMapper UI cleanup" in `DEV_NOTES.md`.
- **Dimensions** (next major RoofMapper capability after the movable/
  deletable-icons + delete work above; confirmed with Mark). Three parts:
  1. ✅ **Shipped**: automatic per-edge perimeter dimensions — the length
     in feet of EVERY side of the roof outline, computed and labeled
     automatically, shown right on the map (small label at each edge's
     midpoint) — not just the single total-perimeter number RoofMapper
     already showed. Applies to any captured outline (OSM footprint,
     manual trace, or walk-the-corners) since it's pure geometry off the
     existing `ring` points, using the same distance helper the perimeter
     total already used. Labels display the GPS/geometry-derived length;
     tapping one to calibrate is #3 below (shipped). See "RoofMapper UI
     cleanup: contextual controls + per-edge dimensions" in `DEV_NOTES.md`.
  2. **User-added dimension lines to features**: let the tech draw/add a
     measurement line FROM a placed feature (e.g. a drain) to a roof edge
     or to another feature, so the export/blueprint shows exactly how far
     things are from each other, not just where they are. Distinct from
     #1 (perimeter is automatic and roof-wide; this is manual and
     feature-specific).
  3. ✅ **Shipped (dev only, 2026-07-10)**: Calibrate-by-known-edge (Mark's
     idea — GPS corner-walking gives an accurate SHAPE but only a rough
     absolute SIZE, consumer GPS being ~10–30 ft off per corner; this turns
     that rough polygon into an accurately-scaled one from a single tape
     measurement). Exact UX, per Mark: the tech taps ONE of #1's per-edge
     dimension labels and edits it to the real field-measured length
     (tape-measured on site) — the app rescales the ENTIRE footprint
     proportionally off that one calibrated edge, so every other edge's
     dimension label, plus total area and perimeter, all update to match
     automatically. One field measurement, one edit, the whole footprint
     becomes accurate — not a separate calibration screen/flow, just
     editing a dimension that was already on screen. The calibrated edge
     stays visibly marked (green highlight + checkmark) on the map, and
     tapping a different edge re-calibrates off that one instead — no
     limit on re-calibrating. Works on any outline (OSM/manual-trace/
     walk-corners) and, if the roof already has features placed, rescales
     them right along with the outline so nothing visually detaches.
     Persists immediately if the outline's already saved; otherwise rides
     along with the next Save Outline like any other edit. The optional
     second-edge confidence-check / best-fit-across-two-edges refinement
     described below is **not built** — the single-edge-edit interaction
     ships as the complete core capability. See "Self-scaling dimension
     calibration" in `DEV_NOTES.md`.

     *Original spec, kept for the not-yet-built refinement*: a second edge
     can optionally be entered/verified afterward as a confidence check (how
     far off is it from what the first edge's scaling predicted) and/or
     folded into a best-fit scale across both known edges rather than
     trusting the single edge alone — a refinement on top of the core
     single-edge-edit interaction, not required for it to work.
  4. ✅ **Shipped (dev only, 2026-07-10)**: Square Up (orthogonal snapping —
     Mark: roofs are mostly rectilinear, a trace should "look square").
     "🟦 Square Up" (manual button, with Undo — never automatic on every
     trace) snaps near-90° corners and near-axis edges clean, within
     ~10–15° of the outline's own dominant rotation. A real diagonal cut
     (e.g. a 45° angle) or an arc/curve run stays exactly as traced —
     never snapped. Preserves each edge's original length exactly (corners
     move, real measured lengths don't). Recommended flow: trace → Square
     Up → Calibrate (#3 above), run last, so whichever edge gets
     calibrated reflects its final post-square length. Works together with
     calibration cleanly — verified corners stay exactly 90° after
     calibrating a squared outline. See "Square Up" in `DEV_NOTES.md`.
  5. ✅ **Shipped (dev only, 2026-07-10)**: vertex editing — closes a real
     gap (Mark asked how to adjust an already-traced outline; the honest
     answer at the time was that there was no way at all). "✏️ Edit Shape"
     shows a draggable handle on every corner — drag any of them to move
     that specific point, with area/perimeter/dimension labels updating
     live. Deliberately visible (a primary button + hint text + distinctly
     styled handles), not a hidden gesture. Scope: moving existing points
     only — adding/removing a vertex is a bigger follow-up, not built here.
     A manual move clears any prior Square Up / Calibrate metadata, since
     those guarantees no longer hold once a corner's been hand-adjusted.
     See "Vertex editing" in `DEV_NOTES.md`.
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

## Vision Pillar: Retroactive Entry — the Past Must Be Enterable, Not Just the Future

Mark, framing the whole point of the product: "That's the only way I can see how
it can go retroactive. You just have to have the ability to add them." The
product's premise is a building's roof history as its permanent digital memory —
but that's only true if EXISTING jobs (most of them, on day one) can have their
past folded in, not just newly-generated reports going forward. A roof history
that only starts the day the app was adopted isn't a history, it's a blank slate
with a start date.

Three things this actually requires, first two shipped 2026-07-11:

- **Add a roof map to any existing building with none yet** — including a
  CompanyCam-only project that's never been a real building in this app before.
  Verified end-to-end (not assumed): RoofMapper's save flow already handles this
  correctly — searching/picking a CompanyCam-only project in the save modal
  (`rmBpSelectCompanyCamProject()`) creates the real building record on the spot,
  then the normal roof picker (now with inline roof-naming, see DEV_NOTES.md)
  takes over exactly as if the building already existed. No gap found, no fix
  needed — this rode entirely on the RoofMapper/save-flow work already shipped
  this session.
- ✅ **Shipped: back-dating on manually logged activities** — required, not
  optional, per Mark ("otherwise the timeline is a lie and the whole history is
  worthless"). A tech backfilling a past repair/inspection/drawing/photo set sets
  the real date it happened; the timeline now sorts by that event date
  (`parseMDYDate()`), not by when the record was typed in. Both dates are kept —
  `date` (the real event) and `enteredAt`/`enteredBy` (the truth about the save
  action itself, automatic + optional override) — and a backfilled entry gets a
  subtle "🕓 Added later" flag so nobody mistakes it for a live, same-day record.
  See "Retroactive backfill: back-dating" in `DEV_NOTES.md`.
- ✅ **Shipped, scoped to photos**: attaching EXISTING photos to a backfilled
  activity (`attachActivityPhotos()`, a device-library multi-picker, same
  `resizeImageFile()` pattern Send Feedback's own photo-attach already uses).
  **Not yet built**: drawings, standalone documents, and orthos as their OWN
  distinct attachable artifact types (as opposed to a roof outline traced through
  RoofMapper, or a photo through this path) — a real, larger follow-up (a generic
  attachment/document model, likely its own Firestore collection rather than
  more inline base64 fields) rather than something to rush into the same pass as
  the photo case. Flagging explicitly here rather than letting "attach existing
  artifacts" quietly read as fully done.

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
- 🔄 **In progress (dev only, Phases 1-2 of 5 shipped 2026-07-11)**: real user
  accounts, data-driven roles, and permissions — this is that line, underway.
  Full 5-phase plan and design in `docs/AUTH_DESIGN.md`. **Phase 1 shipped**:
  Firebase Auth (email+password) added alongside the existing PIN-based admin
  mode (PIN untouched, still fully functional); a data-driven `roles`
  collection seeded with the 9 approved roles (owner/admin/service_manager/
  superintendent/ops_manager/project_manager/estimator/field_tech/billing) and
  their full permission grid (34 keys); a `users/{uid}` privilege mirror with
  **no client write path at all** — every write goes through
  `netlify/functions/auth.js`'s Admin-SDK-only actions
  (`bootstrap_owner`/`assign_role`/`transfer_owner`/`seed_roles`); a "🔐
  Account" sign-in UI (separate from the PIN toggle, controls nothing yet).
  **Real deviation from the original spec, documented**: custom claims carry
  only `{owner, role, mfaOk}`, not the full resolved permission grid —
  Firebase's 1000-byte claims cap made embedding the full 34-key grid
  fragile (owner/admin were already at ~95%+ of the limit with zero room for
  future permission keys); permissions now resolve from the live `roles` doc
  at check time instead, server-side (`authGuard.js`) and in Firestore rules
  alike, via `request.auth.token.role`. **Mandatory negative tests passed**
  (10 scenarios, including "admin attempts to lock out the owner" and "a
  field_tech attempts to self-promote") — see `docs/AUTH_DESIGN.md` for the
  full results table. **Phase 2 shipped**: immutable audit logging expanded
  from Phase 1's 3 highest-risk actions to every mutating `admin.js` action
  (`delete_building`, `delete_history_event`, `set_building_roof_map`,
  `set_roof_profile`), with a new "🔒 Audit Log (admin)" view in Reports.
- ✅ **Shipped (dev only, 2026-07-11), Phase 5 accelerated ahead of Phases
  3-4, per Mark's direct order ("kill the PIN and finish the logins")**: the
  shared `ADMIN_PIN` is now fully removed as an authorization mechanism —
  not weakened, not kept as a fallback, gone. Every privileged server
  action (`admin.js`'s 10 actions, `photos.js`'s migration actions, the new
  `changeorders.js`'s `changeorder.approve_pricing` gate, `send-workorder.js`'s
  `doc.email_customer` gate, `auth.js`'s `assign_role`/`transfer_owner`/new
  `create_user`) requires a verified Firebase ID token + the caller's live
  role permission — 17 privileged actions checked, all reject cleanly with
  no token, verified against the real deployed dev site, not just mocked.
  New **user-management screen** (Account → Manage Users, owner/admin only)
  lets Mark create crew accounts and assign roles without touching Firebase
  Console — a new account's password is a throwaway random value generated
  server-side and never seen by anyone; the new user sets their own via
  Firebase's built-in password-reset email. The app now **requires login**
  (dev only) behind a one-time owner-bootstrap screen Mark completes
  himself. **All mandatory negative tests passed, including the new "any
  privileged action with no auth token at all" case** — see the Phase 5
  section of `docs/AUTH_DESIGN.md` for the full results table.
  **MFA deferred as an explicit fast-follow, not silently dropped**: TOTP
  for owner/admin (needs a GCP Identity Platform upgrade) did not ship
  tonight — privileged actions are gated on claims + permission only right
  now, not claims + MFA. Should land before any wider crew rollout beyond
  Mark himself. Full 5-stage change-order workflow (only the pricing-
  approval gate is real so far) and blanket dual enforcement across all 34
  permission keys (buildings/workorders/customers still use the existing
  open rules for production-compatibility reasons) remain later-phase work.
  **Dev only — production's `main` branch has none of this code and is
  completely unaffected.**
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
