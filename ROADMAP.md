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
- ⚠️ **Scoped, blocked on a confirmed hard requirement**: pushing app-added phone photos
  to the matching CompanyCam project (currently the integration is pull-only — nothing
  uploads a photo to CompanyCam, only PDFs). Match-by-project-name (no auto-create) and
  dedupe-by-`ccPhotoId` are decided. **Confirmed (not just suspected) via CompanyCam's
  own API docs**: their photo-upload endpoint requires a publicly-fetchable URL, not
  raw bytes — this app has no way to produce one without reintroducing Firebase Storage
  or equivalent, which is its own gated decision. Waiting on Mark's call on the hosting
  question before any upload code gets written. See "Push app-added photos to
  CompanyCam" in `DEV_NOTES.md`.
- Review Firestore security rules for all collections currently touched by the app.
- Add lightweight manual QA steps for field workflows: create, save, reload, import CompanyCam photos, generate PDF, send email, and verify history logging.
- ✅ Shipped: duplicate-report detection on the building timeline (same work order +
  report type within 5 minutes flags a "possible duplicate" badge) as a safety net
  around report/history logging.

## Phase 2: Building/Site History Foundation

Goal: make every work order contribute to a durable customer/building record.

- Formalize `customers` and `buildings` as first-class Firestore collections.
- ✅ **Shipped**: an explicit "🔍 Select Existing Building" picker in the Edit tab —
  search/pick an existing building and its Job Name/Bill To/Location/Roof System fill
  in from the stored record instead of being re-typed. Additive alongside the existing
  derive-from-form behavior (same Firestore shape, same doc-id derivation), aimed at
  cutting down typo-created duplicate buildings/customers. See `DEV_NOTES.md`.
- Normalize building identifiers, customer relationships, addresses, roof system data, and CompanyCam project links.
- Expand report/history logging without interrupting field users.
- Prepare Firestore indexes for building history views and dashboard queries.
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
- Not yet built: manual anchoring for non-georeferenced (roof plan/sketch) maps
  (deliberately excluded by the spec), roof-section labels/filters.

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
