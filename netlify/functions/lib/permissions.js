// Canonical permission-key registry for RoofOps auth (Phase 1 of the
// auth build -- see docs/AUTH_DESIGN.md). This file is the SINGLE SOURCE
// OF TRUTH for both:
//   1. PERMISSION_KEYS -- every real permission the app can check. Adding
//      a new permission means adding a key HERE (a code change, on
//      purpose -- permission keys map to real features, not data).
//   2. SEED_ROLES -- the approved role -> permission grid. Roles
//      themselves ARE data (Firestore roles/{roleId} docs seeded from
//      this list) -- adding a new ROLE, or changing what an EXISTING role
//      can do, is a data change (edit the roles collection), not a code
//      change. This file only supplies the initial seed; the roles
//      collection is the live source of truth after that.
//
// Permission VALUES are one of:
//   true        -- granted, unconditionally
//   false       -- not granted (also the default for any omitted key)
//   "proj"      -- granted, but only within the user's assigned projects
//                  (projectRoles on users/{uid} -- resolved by rules/
//                  functions in a later phase, not enforced by this data
//                  alone)
//   "own"       -- granted, but only for records the user themself
//                  created/owns (e.g. field_tech's own attachments)
//   "billing"   -- granted, but scoped to billing-relevant fields/records
//                  only (billing role's view.all is narrower than a full
//                  view.all grant)
//
// Mirrored (display-only, non-authoritative) in index.html as
// PERMISSION_KEYS -- never used there for enforcement, only to render
// human-readable labels. Real enforcement always re-reads the LIVE
// roles/{roleId} doc server-side (rules + functions), never trusts a
// client-supplied or token-embedded copy of a permission grid -- see
// "Custom claims size" note in docs/AUTH_DESIGN.md for why the full grid
// deliberately does NOT live in the Firebase custom claims token.

const PERMISSION_KEYS = [
  "buildings.view.full",
  "buildings.view.billing",
  "buildings.archive",
  "buildings.void",
  "buildings.restore",
  "buildings.purge",
  "workorder.view.own",
  "workorder.view.all",
  "workorder.create",
  "workorder.edit",
  "internal.notes.view",
  "internal.notes.edit",
  "capture.photos",
  "capture.roofmap",
  "capture.dimensions",
  "capture.signature",
  "attachments.archive",
  "attachments.supersede",
  "attachments.purge",
  "changeorder.draft",
  "changeorder.approve_pricing",
  "changeorder.approve_report",
  "doc.generate",
  "doc.email_customer",
  "billing.view",
  "billing.edit",
  "companycam.link",
  "audit.view",
  "settings.company",
  "settings.security",
  "users.manage_nonadmin",
  "users.manage_admin",
  "users.transfer_owner",
  "feedback.submit",
  "warranty.manage_reports",
  "foundation.read"
];

// Every key granted `true`, for roles whose spec is "everything" or
// "everything except a short exclusion list".
function allTrue() {
  const o = {};
  PERMISSION_KEYS.forEach(k => { o[k] = true; });
  return o;
}
function allTrueExcept(excluded) {
  const o = allTrue();
  excluded.forEach(k => { o[k] = false; });
  return o;
}
// Builds a grid from an explicit grant list (default false for every key
// not listed) -- used for every role EXCEPT owner/admin, so each role's
// grants are exactly and only what was approved, nothing implied.
function grid(grants) {
  const o = {};
  PERMISSION_KEYS.forEach(k => { o[k] = false; });
  Object.assign(o, grants);
  return o;
}

const SEED_ROLES = [
  {
    id: "owner",
    label: "Owner",
    description: "Full, unrestricted access. Only the owner may create/promote/demote/remove admins and transfer ownership.",
    isSystem: true,
    rank: 100,
    permissions: allTrue()
  },
  {
    id: "admin",
    label: "Admin",
    description: "Everything except owner-only actions (purge, security settings, admin/owner account management).",
    isSystem: true,
    rank: 90,
    permissions: allTrueExcept([
      "buildings.purge", "attachments.purge", "settings.security",
      "users.manage_admin", "users.transfer_owner"
    ])
  },
  {
    id: "service_manager",
    label: "Service Manager",
    description: "Full service authority: pricing + report approval, customer send, service billing edit.",
    isSystem: false,
    rank: 70,
    permissions: grid({
      "buildings.view.full": true,
      "workorder.view.all": true,
      "workorder.create": true,
      "workorder.edit": true,
      "internal.notes.view": true,
      "internal.notes.edit": true,
      "capture.photos": true,
      "capture.roofmap": true,
      "capture.dimensions": true,
      "capture.signature": true,
      "companycam.link": true,
      "changeorder.draft": true,
      "changeorder.approve_pricing": true,
      "changeorder.approve_report": true,
      "doc.generate": true,
      "doc.email_customer": true,
      "billing.view": true,
      "billing.edit": true,
      "buildings.archive": true,
      "buildings.void": true,
      "buildings.restore": true,
      "attachments.archive": true,
      "attachments.supersede": true,
      "audit.view": true,
      "feedback.submit": true,
      "warranty.manage_reports": true,
      "foundation.read": true
    })
  },
  {
    id: "superintendent",
    label: "Superintendent",
    description: "Project-scoped field authority. Can approve the report stage of a change order, not pricing; no customer send or billing edit.",
    isSystem: false,
    rank: 60,
    permissions: grid({
      "buildings.view.full": "proj",
      "workorder.view.all": "proj",
      "workorder.create": "proj",
      "workorder.edit": "proj",
      "internal.notes.view": "proj",
      "internal.notes.edit": "proj",
      "capture.photos": "proj",
      "capture.roofmap": "proj",
      "capture.dimensions": "proj",
      "capture.signature": "proj",
      "companycam.link": "proj",
      "changeorder.draft": true,
      "changeorder.approve_report": "proj",
      "doc.generate": true,
      "billing.view": "proj",
      "attachments.archive": "proj",
      "attachments.supersede": "proj",
      "feedback.submit": true
    })
  },
  {
    id: "ops_manager",
    label: "Ops Manager",
    description: "Broad operational authority across buildings/work orders/change orders, not billing edit or user/settings management.",
    isSystem: false,
    rank: 65,
    permissions: grid({
      "buildings.view.full": true,
      "workorder.view.all": true,
      "workorder.create": true,
      "workorder.edit": true,
      "internal.notes.view": true,
      "internal.notes.edit": true,
      "capture.photos": true,
      "capture.roofmap": true,
      "capture.dimensions": true,
      "capture.signature": true,
      "attachments.archive": true,
      "attachments.supersede": true,
      "changeorder.draft": true,
      "changeorder.approve_pricing": true,
      "changeorder.approve_report": true,
      "doc.generate": true,
      "doc.email_customer": true,
      "billing.view": true,
      "buildings.archive": true,
      "buildings.void": true,
      "buildings.restore": true,
      "companycam.link": true,
      "audit.view": true,
      "feedback.submit": true,
      "warranty.manage_reports": true,
      "foundation.read": true
    })
  },
  {
    id: "project_manager",
    label: "Project Manager",
    description: "Project-scoped grants, including project-scoped pricing/report approval and customer send.",
    isSystem: false,
    rank: 55,
    permissions: grid({
      "buildings.view.full": "proj",
      "workorder.view.all": "proj",
      "workorder.create": "proj",
      "workorder.edit": "proj",
      "internal.notes.view": "proj",
      "internal.notes.edit": "proj",
      "capture.photos": "proj",
      "capture.roofmap": "proj",
      "capture.dimensions": "proj",
      "capture.signature": "proj",
      "attachments.archive": "proj",
      "attachments.supersede": "proj",
      "changeorder.draft": true,
      "changeorder.approve_pricing": "proj",
      "changeorder.approve_report": "proj",
      "doc.generate": true,
      "doc.email_customer": "proj",
      "billing.view": "proj",
      "companycam.link": "proj",
      "feedback.submit": true
    })
  },
  {
    id: "estimator",
    label: "Estimator",
    description: "Views and drafts, no create/edit of work orders, no approvals, no customer send.",
    isSystem: false,
    rank: 40,
    permissions: grid({
      "buildings.view.full": true,
      "workorder.view.all": true,
      "workorder.view.own": true,
      "internal.notes.view": true,
      "internal.notes.edit": true,
      "capture.photos": true,
      "capture.roofmap": true,
      "capture.dimensions": true,
      "capture.signature": true,
      "changeorder.draft": true,
      "doc.generate": true,
      "billing.view": true,
      "feedback.submit": true
    })
  },
  {
    id: "field_tech",
    label: "Field Tech",
    description: "Own work orders + capture, no company-wide view, no approvals, no billing.",
    isSystem: false,
    rank: 20,
    permissions: grid({
      "buildings.view.full": true,
      "workorder.view.own": true,
      "workorder.create": true,
      "workorder.edit": true,
      "internal.notes.view": true,
      "internal.notes.edit": true,
      "capture.photos": true,
      "capture.roofmap": true,
      "capture.dimensions": true,
      "capture.signature": true,
      "attachments.archive": "own",
      "attachments.supersede": "own",
      "changeorder.draft": true,
      "doc.generate": true,
      "companycam.link": true,
      "feedback.submit": true
    })
  },
  {
    id: "billing",
    label: "Billing",
    description: "Billing-scoped building/work-order visibility (not full), billing view+edit, customer doc send.",
    isSystem: false,
    rank: 30,
    permissions: grid({
      "buildings.view.billing": true,
      "workorder.view.all": "billing",
      "workorder.view.own": true,
      "internal.notes.view": true,
      "doc.generate": true,
      "doc.email_customer": true,
      "billing.view": true,
      "billing.edit": true,
      "feedback.submit": true
    })
  }
];

module.exports = { PERMISSION_KEYS, SEED_ROLES };
