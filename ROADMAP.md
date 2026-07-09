# RoofOps Roadmap

This roadmap is intentionally phased so the current working field app remains stable while the product grows into a broader roof history and operations platform.

## Phase 1: Stabilize Current Field App

Goal: preserve and harden the existing RoofOps Field / Watkins work order workflow.

- Keep the current work order form, Firebase sync, CompanyCam import, PDF generation, and email/report sending working.
- Document the current architecture and environment variables.
- Avoid major UI redesigns until the data model and workflow are stable.
- Improve reliability around save/load, report logging, and failure messages.
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
- Decide how to handle duplicate building names, renamed customers, and multi-building sites (the picker reduces new dupes going forward; existing ones aren't merged).

## Phase 3: Roof History Timeline

Goal: turn each building into a long-term roof record.

- Build a richer building history timeline from work orders, reports, photos, warranty decisions, and CompanyCam metadata.
- Add filters by date, roof area, technician, warranty status, leak type, repair type, and report type.
- Add durable references to report PDFs and photo source records.
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
