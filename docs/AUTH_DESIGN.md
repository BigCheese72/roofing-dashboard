# RoofOps Authentication & Authorization — Design (Rev 4, approved)

Status: **Phase 1, Phase 2, and an accelerated Phase 5 slice shipped.** Dev
branch only — this system does not exist on `main` and must not be deployed
there until a separate, explicit go-live decision.

This document is written and updated as each phase ships, per Mark's request that
the design live in the repo, version-controlled, rather than only in chat history.

## Foundation

- Firebase Authentication, email+password, one account per user, built-in password
  reset flow.
- **Enforcement truth = Firebase custom claims on the ID token** (`{ owner, role,
  mfaOk }` — see "Custom claims size" below for why this is smaller than originally
  specified). Claims are written **only** by trusted server functions via the
  Firebase Admin SDK — never by the client, never by a Firestore rule, never
  self-service.
- `users/{uid}` Firestore doc mirrors role/status/etc. for display and query, but is
  **non-authoritative**. Its privilege fields (`role`, `status`, `mfaEnrolled`,
  `owner`, `projectRoles`) have **no client write path** — only Admin-SDK server
  functions write them. A user can never modify their own privilege record.

## Custom claims size — a real constraint hit during Phase 1 (documented deviation)

The original approved spec: "a server function resolves that role's permission set
from the roles doc **into the user's custom claims**."

Firebase hard-caps custom claims at **1000 bytes**, serialized. The approved
permission grid has 34 keys. Serializing the **full grid** into claims for a
broad role (owner: all 34 true; admin: 29 true) comes out to roughly **940–980
bytes** — technically under the limit today, but with only 2–6% headroom. The
next permission key anyone adds (which the whole "data-driven roles" model
explicitly anticipates) would push owner's claims over the hard limit and silently
break login for the owner account.

**Fix, in place as of Phase 1**: custom claims carry only:

```js
{ owner: boolean, role: "<roleId>", mfaOk: boolean }
```

Roughly 40–50 bytes, fixed-size, never grows with the permission grid. The full
grid stays where real enforcement needs it anyway — the live `roles/{roleId}`
Firestore doc. Every permission check (rules and server functions alike) resolves
`role → roles/{role}.permissions` at check time, rather than trusting a payload
embedded in the JWT.

This is **not a weakening** of "claims are the enforcement truth" — `role` is
still the one fact only a server function can set; a client can never grant itself
a different role or claim permissions it doesn't have. It also simplifies "editing
a role re-resolves claims for its users": since claims never held the resolved
grid, editing a role's `permissions` map takes effect on the very next permission
check for everyone with that role — no user claims need to be touched or sessions
revoked for a role-content edit. **Only re-assigning a user to a *different* role**
still needs a claims update (`role` changes) and, per spec, a session refresh.

## Data-driven roles

- `roles/{roleId}` — `{ id, label, description, permissions: {permKey: value},
  isSystem, rank, createdAt, updatedAt }`. Adding a role = adding a Firestore doc,
  no code change. `owner` and `admin` are `isSystem: true` — protected, cannot be
  edited or deleted (enforced server-side in the role-management action once
  built).
- Permission **keys** are code constants (`netlify/functions/lib/permissions.js`,
  `PERMISSION_KEYS`) — each maps to a real feature, adding one is a deliberate code
  change. Permission **values** per role are data.
- Permission value is one of: `true` (granted), `false`/absent (not granted),
  `"proj"` (granted, scoped to the user's assigned projects — `projectRoles` on
  `users/{uid}`), `"own"` (scoped to records the user themself created), or
  `"billing"` (scoped to billing-relevant fields/records only). Scoping
  *enforcement* (resolving `"proj"`/`"own"`/`"billing"` against a specific document)
  is Phase 2/3 work — Phase 1 only defines and seeds the data shape.
- Seed roles (approved grid): `owner`, `admin` (both `isSystem`), `service_manager`,
  `superintendent`, `ops_manager`, `project_manager`, `estimator`, `field_tech`,
  `billing`. Full grid lives in `netlify/functions/lib/permissions.js`.
- Account-management hierarchy: **only owner** may create/promote/demote/remove
  admins and transfer ownership; admins manage non-admin users only
  (`users.manage_nonadmin` vs `users.manage_admin` vs `users.transfer_owner`, all
  owner-only for the latter two).

## Permission keys (34, canonical list in `netlify/functions/lib/permissions.js`)

`buildings.view.full`, `buildings.view.billing`, `buildings.archive`,
`buildings.void`, `buildings.restore`, `buildings.purge` (OWNER),
`workorder.view.own`, `workorder.view.all`, `workorder.create`, `workorder.edit`,
`internal.notes.view`, `internal.notes.edit`, `capture.photos`, `capture.roofmap`,
`capture.dimensions`, `capture.signature`, `attachments.archive`,
`attachments.supersede`, `attachments.purge` (OWNER), `changeorder.draft`,
`changeorder.approve_pricing`, `changeorder.approve_report`, `doc.generate`,
`doc.email_customer`, `billing.view`, `billing.edit`, `companycam.link`,
`audit.view`, `settings.company`, `settings.security` (OWNER),
`users.manage_nonadmin`, `users.manage_admin` (OWNER), `users.transfer_owner`
(OWNER), `feedback.submit`.

## Enforcement (dual — non-negotiable)

- Every permission enforced in **both** Firestore rules and server functions. UI
  hiding is convenience only, never the boundary.
- **No client deletes anywhere.** Removal = status transitions: buildings/work
  orders archive/void/restore; photos/attachments archive/supersede. `purge`
  (buildings + attachments) has no client path at all — server function, callable
  only when the caller's claims have `owner === true`, exceptional and heavily
  audited.
- Internal notes: read gated by `internal.notes.view`, write by
  `internal.notes.edit`.
- Project scoping: for `project_manager`/`superintendent` (and any `"proj"`-valued
  permission), rules/functions resolve the caller's `projectRoles` against the
  target document's project.
- Settings split: `settings.company` writable by Admin+Owner; `settings.security`
  Owner-only.

## Shared Firestore, dev/prod risk boundary (carried over from the planning
discussion, still governs every phase)

Dev and production currently share one live Firestore project, and production's
code sends zero auth tokens. Rules changes here are scoped so that:

- **New collections and genuinely new fields/write-shapes** (`roles`, `users`
  privilege fields, `audit_logs`, archive/void/purge/supersede status values, CO
  stage fields, internal-notes fields) can be locked down immediately — production
  never touches those.
- **Existing fields production already writes today** stay exactly as open as they
  are now at the rules layer, until a separate, explicit decision to migrate
  production itself.
- "App requires login" (end of Phase 5) is a **dev-side client gate + function-layer
  enforcement**, not a rules-layer lockdown of pre-existing shared data.

## Audit log (immutable)

`audit_logs` — append-only. Rules **deny update and delete to everyone, including
owner**. Written by server functions only (Admin SDK, not subject to rules).
Each entry: `actorUid`, `actorRole`, server timestamp, `target: {collection, id}`,
`action`, `before`/`after`. Building out in Phase 2.

## Change-order workflow (5 stages, Phase 3)

Draft → Requested (`changeorder.draft`) → Pricing Approved
(`changeorder.approve_pricing`) → Report Approved (`changeorder.approve_report`) →
Sent (`doc.email_customer`). Each transition audit-logged. Additive `coStage`
field alongside the existing generic work-order `status` field — not a
replacement.

## MFA & recovery (Phase 4)

TOTP via Identity Platform (note: requires a GCP Identity Platform upgrade beyond
base Firebase Auth — a manual console step, flagged when Phase 4 starts). Required
for owner+admin — privileged actions blocked until enrolled, checked server-side.
Session revocation (`revokeRefreshTokens` + `auth_time` check for immediate
effect). Disabled-user handling. Lost-device recovery (owner/admin resets MFA +
password, audit-logged). No backdoor/hidden login/master password anywhere.
Owner recovery = a separate, MFA-protected, offline-credentialed break-glass
account (mechanism built here; account creation/credential custody is Mark's
call, documented as a runbook once Phase 4 lands) + GCP project ownership. First
owner set once via the protected bootstrap below; owner transfer requires an
existing owner.

## Forward-compat

Photos/attachments stay on the shared archive/supersede lifecycle so a future
unified `assets` collection (photo/drone/document/drawing) is an additive V2
migration. Not built now.

---

## Phase 1 — what actually shipped

- `index.html`: Firebase Auth SDK added (`firebase-auth-compat.js`, matching the
  existing `10.12.5` version already used for app/Firestore). `fauth` initialized
  alongside `fdb`, same graceful-`null`-on-failure pattern. **Layered alongside the
  existing PIN-based admin mode — PIN is untouched, nothing about today's admin
  flow changes.**
- `netlify/functions/lib/permissions.js`: `PERMISSION_KEYS` (34 keys) +
  `SEED_ROLES` (the 9 approved roles, full grid, `true`/`false`/`"proj"`/`"own"`/
  `"billing"` values). Verified programmatically (browser-side re-implementation
  of the same logic, since this sandbox has no Node runtime to `require()` the
  actual file): every role's permission object has exactly the 34 canonical keys
  (no typos silently adding stray keys), and spot-checked against the approved
  grid (field_tech denied `approve_pricing`/`email_customer`/`manage_nonadmin`/
  `purge`; billing denied `view.full`/`create`; admin denied `purge`/
  `transfer_owner` but granted `manage_nonadmin`; owner granted all 34).
- **Prerequisite for this to actually work once deployed**: the "Email/Password"
  sign-in provider must be enabled for the `watkins-service-orders` Firebase
  project in the Firebase Console (Authentication → Sign-in method) — a manual,
  one-time step, same pattern as `firestore.rules` needing a manual publish.
  Nothing in this code enables it automatically.
- `netlify/functions/lib/authGuard.js`: `verifyCaller(event)` — verifies the
  Authorization bearer token via `admin.auth().verifyIdToken()` (the actual trust
  boundary; a client cannot forge a token's signature, so nothing it claims about
  itself in a request body is ever trusted for identity). `getPermissionValue(role,
  key)` and `requirePermission(event, permKey)` resolve permissions by reading the
  LIVE `roles/{roleId}` doc at check time — never a cached/embedded grid — so a
  role-content edit takes effect on the very next check for everyone with that
  role, no user claims need touching.
- `netlify/functions/auth.js`: `seed_roles` (writes/re-syncs the 9 roles from
  `SEED_ROLES`, usable pre-bootstrap via the secret or post-bootstrap by a verified
  owner), `bootstrap_owner` (one-time-only, secret-gated, refuses once
  `app_settings/auth_bootstrap.ownerBootstrapped` is true), `assign_role` (the only
  way a user's role/claims change — hard-blocks self-role-changes, requires
  `caller.owner` for anything touching the admin role, requires
  `users.manage_nonadmin` otherwise, blocks changing the current owner's role
  entirely, rejects `roleId:"owner"` outright), `transfer_owner` (separate action,
  owner-only, moves owner status and demotes the outgoing owner to admin rather than
  leaving them role-less).
- `firestore.rules`: new `roles`/`users`/`audit_logs` blocks — all three brand new
  collections, zero production risk (production's code never touches them). `roles`
  readable by any signed-in user, write:false (Admin SDK only). `users/{uid}`
  readable by the user themself or an owner/admin (checked directly off
  `request.auth.token.owner`/`.role` — no extra read needed, the payoff of keeping
  claims small), write:false absolutely. `audit_logs` read gated by the caller's
  live `roles/{role}.permissions['audit.view']` (via a rules `get()`, the same
  resolve-at-check-time pattern `authGuard.js` uses server-side); create/update/
  delete all `false` for every client without exception, including the owner.
- Login UI (`index.html`): a "🔐 Account" header button, entirely separate from the
  existing PIN-based "Admin" button — opens a small modal with email/password
  sign-in, sign-out, and password reset. Once signed in, role/owner status display
  reads straight from the ID token's claims (`getIdTokenResult().claims`), not a
  Firestore read — works correctly even before any client-side role display logic
  exists beyond this. **Purely informational in Phase 1 — nothing in the app checks
  or gates on this yet.**

### Testing performed

**Environment constraint, noted for transparency**: this sandbox has no Node
runtime and cannot invoke a deployed Netlify Function or create a real Firebase
Auth account without an actual dev deploy with Firebase Auth enabled. Consistent
with how every other server function in this app has been validated all session
(code review + client-side mocked-call testing, never live invocation from this
environment).

- `permissions.js` data: verified programmatically by re-implementing the exact
  same `grid()`/`allTrue()`/`allTrueExcept()` logic in the browser and running it
  against the real `PERMISSION_KEYS`/`SEED_ROLES` content — confirmed every one of
  the 9 roles' permission objects has exactly the 34 canonical keys (a typo'd
  permission key in any grant list would have silently added a stray 35th key;
  none did), and spot-checked specific grants/denials against the approved grid.
- Claims-size fix verified: a sample `{owner,role,mfaOk}` claims payload serializes
  to **43 bytes** — compare to the ~940-980 bytes the original full-grid design
  would have used for owner/admin, right at Firebase's 1000-byte hard cap.
- Login UI tested against a mocked `fauth` (no real Firebase Auth calls): signed-out
  view renders email/password fields; signed-in view correctly displays email +
  role + an "(owner)" tag only when `claims.owner === true`; Sign In/Sign Out/
  Forgot Password all call through to the right `fauth` method with the right
  arguments; empty email/password correctly blocked with a toast before any
  `fauth` call; `onAuthStateChanged`'s handler correctly updates the header
  button's text on both sign-in and sign-out.
- **Mandatory negative tests — `assign_role`'s exact decision tree, transcribed
  from the real file and run against 10 scenarios**:

  | Scenario | Expected | Result |
  |---|---|---|
  | field_tech attempts to self-promote to admin | FAIL | ✅ FAIL — "Cannot change your own role" |
  | field_tech attempts to grant admin to another user | FAIL | ✅ FAIL — "Only the owner may grant or remove admin" |
  | field_tech attempts to grant a non-admin role to another user | FAIL | ✅ FAIL — "Forbidden: missing permission users.manage_nonadmin" |
  | **admin attempts to demote/lock out the owner** | FAIL | ✅ FAIL — "Cannot change the owner's role -- transfer ownership first" |
  | admin attempts to grant admin to someone | FAIL | ✅ FAIL — "Only the owner may grant or remove admin" |
  | admin attempts to grant a non-admin role to a non-admin user | SUCCEED | ✅ SUCCEED |
  | owner attempts to grant admin | SUCCEED | ✅ SUCCEED |
  | owner attempts to change their own role (self-target) | FAIL | ✅ FAIL — "Cannot change your own role" |
  | service_manager (lacks users.manage_nonadmin) attempts to grant a role | FAIL | ✅ FAIL — "Forbidden: missing permission users.manage_nonadmin" |
  | anyone attempts to assign roleId "owner" directly | FAIL | ✅ FAIL — "Use transfer_owner to grant the owner role" |

  All 10 produced the correct pass/fail outcome, including both explicitly-mandated
  cases (field_tech self-promotion, admin locking out the owner).
- **Claims-tampering check (code inspection, not simulation)**: grepped
  `auth.js`/`authGuard.js` for every place a client-supplied `body.*` field is
  read — the only one is `body.roleId` (the *target* role being assigned, a
  legitimate input). No code path anywhere reads `body.owner`, `body.role`,
  `body.caller`, or any client-asserted identity/claims field. Every identity fact
  (`caller.uid`/`.owner`/`.role`) comes exclusively from `verifyCaller()`'s
  cryptographic token verification — a client cannot forge this without Firebase's
  private signing key.
- **Not yet testable from here**: a true end-to-end "create a throwaway account
  via `bootstrap_owner`, sign in for real, read back real claims, call `assign_role`
  against a live token, erase every test artifact" pass. Requires the dev branch
  actually deployed on Netlify with `FIREBASE_SERVICE_ACCOUNT` and
  `OWNER_BOOTSTRAP_SECRET` set, and the Firebase project's Email/Password provider
  enabled. Flagging this explicitly rather than claiming a false "fully tested."

---

## Phase 2 — what actually shipped (and a scope decision worth flagging)

**Scope decision, made explicitly rather than following the original phase
description literally**: the original ask was "Firestore rules + server-function
guards for dual enforcement on EXISTING admin.js actions, migrating them off the
PIN system onto claims-based checks." Building this out, the "Shared Firestore,
dev/prod risk boundary" section above (already in this doc, Phase 1) turned out to
directly constrain how far that migration can safely go right now:
`admin.js`'s entire handler is gated by one thing — a shared `ADMIN_PIN` compared
against every request body — and **production sends zero Firebase Auth tokens at
all**. Removing or weakening the PIN gate, or making a claims-bearing token
*required* for any existing admin.js action, would immediately break every admin
action in production (delete building, base map upload, etc.) with no fallback,
since production has no login flow and isn't getting one this phase (that's
explicitly Phase 5's "app requires login" decision, not Phase 2's).

**What Phase 2 actually does, staying inside that boundary**: adds claims-aware
**audit logging** to every mutating admin.js action, opportunistically capturing a
real signed-in identity when one happens to be available (dev, someone signed in)
and degrading cleanly to `"pin_only"` otherwise (today's reality, everywhere,
including all of production) — rather than a hard migration that would require a
token. This is genuine progress toward "dual enforcement" (a real audit trail now
exists, where none did before beyond "the PIN was correct") without touching the
one thing that's actually protecting production today. Full removal of PIN-only
access is deliberately left for Phase 5, when "require login" is decided.

- `netlify/functions/lib/authGuard.js`: new `tryVerifyCaller(event)` — same
  verification as `verifyCaller()`, but returns `null` instead of throwing when
  there's no bearer token or it's invalid/expired. Used only for optional,
  best-effort identity capture (audit logging); never for actual authorization
  decisions (those still throw via `verifyCaller`/`requirePermission`, unchanged).
- `netlify/functions/admin.js`: new `writeAuditLog(db, event, action, target,
  before, after)`, called from all four existing mutating actions —
  `delete_building`, `delete_history_event`, `set_building_roof_map`,
  `set_roof_profile`. Each writes one `audit_logs` doc: `actorUid`/`actorEmail`/
  `actorRole` (from `tryVerifyCaller`, or all `null`), `actorMethod` (`"claims"` or
  `"pin_only"`), `action`, `target` (`{collection, id, roofId?}`), `before`/`after`
  (an action-appropriate summary, not a full-document backup — e.g.
  `delete_building`'s "before" is name/address/customerId + deleted-record counts,
  not the entire building doc with its full `roofs[]`/history), `ts: Date.now()`
  (matches `auth.js`'s Phase 1 audit writer exactly — one consistent shape across
  every `audit_logs` writer, caught and fixed during this phase: an early draft
  used a Firestore `serverTimestamp()` under a differently-named `createdAt` field
  instead). **A logging failure never blocks the underlying action** — the real write already
  happened by the time `writeAuditLog` runs; treating "couldn't write the audit
  entry" as a failure of the admin action itself would be strictly worse than a
  quietly-incomplete log. `set_photo_size_pref` (a cosmetic global preference, not
  destructive/privileged) deliberately isn't logged — kept the log focused on
  actions matching the design doc's own framing ("destructive or privileged").
  `firestore.rules`'s `audit_logs` block (already correct from Phase 1: read gated
  by `audit.view`/owner, create/update/delete `false` for every client) needed no
  changes — the Admin SDK writes here aren't subject to rules at all.
- New `list_audit_log` admin.js action + a "🔒 Audit Log (admin)" card in the
  Reports view (admin-only, same visibility/load pattern as the existing Feedback
  Backlog card right above it) — write-only logging with no way to see it would
  have been a weak deliverable. Same PIN-gated precedent as the existing
  `list_feedback` action (a genuine claims-gated client-side Firestore read is
  possible today via the rules already in place, but would require every admin-
  mode user to also be signed in with Firebase Auth, which Phase 2 doesn't yet
  require — consistent with the scope decision above).

### Testing performed

Same environment constraint as Phase 1 (no Node runtime in this sandbox, cannot
invoke a deployed Netlify Function): `admin.js`/`authGuard.js` changes validated by
full manual read-through for syntax correctness (balanced braces/parens/requires,
correct variable scope for every `writeAuditLog(db, event, ...)` call site) rather
than a `node -c` syntax check (confirmed unavailable — `node` is not on PATH in
this environment). Client-side pieces tested for real in the browser (mocked
`callAdminApi`, no real network calls):

- Confirmed `renderAuditLogBacklog()` correctly renders a realistic mixed log (one
  `"claims"`-method entry with email+role, one `"pin_only"` entry) — action name,
  target string (including the roofId suffix for roof-scoped actions), actor
  string (email+role, or "PIN only (not signed in)"), and JSON before/after all
  present and correctly formatted.
- Confirmed the empty state (`"No audit log entries yet."`) and the error state
  (`callAdminApi` rejecting → `"Couldn't load the audit log: <message>"`) both
  render correctly, matching the existing Feedback Backlog card's precedent.
- Confirmed the "🔒 Audit Log (admin)" card's visibility is driven by
  `updateAdminUI()` exactly like the Feedback Backlog card (hidden when not admin,
  shown + auto-loaded when admin mode is toggled on while already on the Reports
  view) — an initial test that set `isAdmin` directly without going through
  `updateAdminUi()`/`toggleAdminMode()` correctly showed the card was still hidden
  (accurately reflecting that the real toggle flow, not a raw variable set, is what
  drives visibility), then re-verified correctly visible once `updateAdminUI()` ran.
  All test state cleared, page reloaded, console clean.

---

## Phase 5 — what actually shipped (accelerated, out of phase order)

**Scope decision, explicit**: Mark asked directly for the PIN gate to stop being
the security boundary and for the mandatory negative tests below to pass
*tonight*, ahead of Phase 3 (change-order workflow) and Phase 4 (MFA) being fully
built. This phase ships the minimum real, testable slice needed to satisfy that:
claims-authoritative enforcement on every existing `admin.js`/`photos.js`
privileged action, plus exactly one new real enforcement point each for
`changeorder.approve_pricing` and `doc.email_customer` (not the full CO workflow
or a documents-sent UI — those stay Phase 3+, scoped separately). MFA (Phase 4)
was **not** built this phase — see "Trade surfaced" below.

**Why the PIN was dropped entirely, not kept as a fallback**: Mark explicitly
allowed either ("keep the PIN only as a temporary fallback if you must, but
claims must be authoritative"). A live PIN fallback on the mutating actions would
mean anyone who knows the shared office PIN — including a field_tech — could
still bypass claims-based checks entirely, which defeats "the shared PIN must no
longer be the security boundary" in practice, not just in the primary code path.
Since this same phase also ships the require-login gate (below), every real
caller will have a token anyway, so there's no transition gap that actually needs
a PIN fallback to bridge. `check_pin` itself is left working (harmless,
non-mutating, doesn't gate anything else anymore) in case anything still probes
it.

**Trade surfaced (per Mark's explicit "tell me if you make that trade, don't
make it silently")**: MFA for owner/admin (Phase 4) was **not** built tonight —
it requires a GCP Identity Platform upgrade (a manual console step, flagged since
Phase 1's original spec) and is scoped as its own phase. Privileged actions
tonight are gated on claims + permission only, not claims + MFA. This is a real,
present gap for the owner/admin accounts specifically until Phase 4 ships —
flagging it here rather than letting "auth is done" read as "MFA is done."

### What shipped

- **`netlify/functions/admin.js`**: every mutating action converted from
  PIN-primary to `requirePermission(event, permKey)`-primary. Mapping used:
  `delete_building`/`delete_history_event` → `buildings.purge` (owner-only per
  the seed grid — matches this doc's existing "purge... callable only when the
  caller's claims have owner === true" framing, just expressed as a data-driven
  permission instead of a hardcoded check); `set_building_roof_map`/
  `set_roof_profile`/`move_roof`/`set_photo_size_pref` → `settings.company`
  (Admin+Owner); `archive_building`/`unarchive_building` → `buildings.archive`/
  `buildings.restore`; `list_feedback`/`list_audit_log` → `audit.view`.
  `check_pin` unchanged. `writeAuditLog()` simplified to take the already-verified
  `caller` from `requirePermission()` directly instead of a second, optional
  `tryVerifyCaller()` call — every entry now has `actorMethod: "claims"`, no more
  `"pin_only"` degradation for anything in this file.
- **`netlify/functions/photos.js`**: `migrate_scan`/`migrate_photo` converted
  from PIN to `caller.owner === true` (via `verifyCaller`, not a
  `permissions.js` key lookup — this is an exceptional, one-time bulk operation
  with no day-to-day equivalent, same tier as `buildings.purge`).
- **`netlify/functions/changeorders.js` (new)**: one real action,
  `approve_pricing`, gated by `requirePermission(event,
  "changeorder.approve_pricing")`. Approval state lives in a brand-new
  subcollection, `workorders/{id}/changeorder_approvals`, deliberately **not** a
  field on the existing wide-open `workorders/{id}` document — that collection
  stays `allow read, write: if true` for production-compatibility reasons (see
  "Shared Firestore, dev/prod risk boundary" above, unchanged), so a pricing-
  approval flag living there would be directly writable by any client regardless
  of any server function's permission check. The new subcollection gets its own
  `firestore.rules` block, `allow read: if true; allow write: if false;` —
  zero production risk (production's code has no notion of this path), and
  provably unbypassable at the rules layer independent of whether
  `changeorders.js` is ever called correctly. The full 5-stage CO workflow
  (Draft → Requested → Pricing Approved → Report Approved → Sent) is still not
  built — this is one gate, proven end-to-end, not the feature.
- **`netlify/functions/send-workorder.js`**: gained a `requirePermission(event,
  "doc.email_customer")` check at the very top of the handler. Before this
  phase, this endpoint had **zero** authorization of any kind — anyone who could
  reach it could send an email as Watkins Roofing to any address, independent of
  the mandatory test that happens to cover the same gap. This was the single
  highest-severity finding of this phase.
- **`js/core.js`**: `isAdmin` is now derived from the signed-in user's claims
  (`owner === true` or `role === "admin"`) via `recomputeIsAdmin()`, called
  whenever auth state changes — no longer a memorized PIN in `sessionStorage`.
  `authHeaders()` attaches the signed-in user's Firebase ID token as a Bearer
  header; `callAdminApi()`/`callPhotosApi()` both use it, and `js/history.js`'s
  direct `send-workorder` call site was updated the same way (found by grepping
  every direct `fetch()` to these three endpoints, not just the wrapper
  functions — a bypass here would have silently defeated the whole phase).
  `toggleAdminMode()` no longer prompts for a PIN; it nudges toward the Account
  modal when signed out, or confirms current role/status when signed in — there
  is nothing left to client-side "toggle," the server decides what a given
  signed-in identity can actually do.
  **Known UI scoping gap, deliberate**: `isAdmin` (and the settings bar it
  gates) only recognizes owner/admin. A role like `service_manager`, which
  legitimately holds `audit.view`/`buildings.archive` server-side, won't see
  this specific bar yet. Not a security gap — every action behind it
  independently re-checks its own specific permission regardless of what the UI
  shows (the pre-existing "UI hiding is convenience only, never the boundary"
  rule) — but a real UI-completeness gap worth flagging rather than overclaiming
  full role-aware UI shipped everywhere.
- **One-time owner bootstrap screen** (`#login-gate`, `js/core.js`'s
  `runOwnerBootstrap()`/`loginGateBootstrapHtml()`): shown in place of the
  sign-in form when `app_settings/auth_bootstrap.ownerBootstrapped` isn't `true`
  yet. Collects an owner email/password/bootstrap-secret, calls
  `bootstrap_owner`, signs into the new account in-browser, force-refreshes the
  ID token (`getIdToken(true)` — claims were just set moments before by the
  Admin SDK, so a token minted before that call could still reflect the old,
  claims-less state), then calls `seed_roles` with that fresh owner token to
  seed the 9 approved roles in one flow.
  **I did not run this, and will not** — creating an account and entering a
  password on someone's behalf is a prohibited action for me regardless of
  explicit permission (see the standing safety rules governing this whole
  session). Mark has to complete this screen himself, with his own credentials,
  once this ships.
- **Require-login gate** (`#login-gate`, dev only by construction — this code
  doesn't exist on `main`): blocks the app behind a full-screen overlay
  (`renderLoginGate()`) until someone is signed in, *unless* `fauth` itself
  isn't configured/available, in which case it fails **open** rather than
  bricking the app over an environment gap (same null-safe degrade pattern as
  `fdb`/`fauth` everywhere else). Re-evaluated on every `onAuthStateChanged`
  firing and once at load via `checkAuthBootstrapStatus()`.
  **Operational consequence, flagged explicitly**: once this deploys, the dev
  app is unusable by anyone — including Mark — until the owner bootstrap screen
  above is completed. This is intentional (that's what "require login" means)
  but worth stating plainly rather than discovering it by surprise.

### Testing performed

Same environment constraint as Phase 1/2 (no Node runtime, cannot invoke a
deployed Netlify Function or create a real Firebase Auth account from this
environment) — and, additionally this phase, creating any account (even a
throwaway test one) requires supplying a password, which is a prohibited action
for this assistant regardless of context, so a true "create a test field_tech
account, sign in for real, call the deployed function with a real token" pass
was not attempted and could not have been. Consistent with Phase 1's own
documented limitation, not a new one.

**Mandatory negative tests — all 7 scenarios Mark specified, expanded into 15
sub-checks (rules layer + server layer separately, per his explicit "must FAIL
at BOTH" requirement) plus 6 positive controls, 21 total**. Method: the exact
decision logic was transcribed from the real, shipped files
(`authGuard.js`'s `getPermissionValue`/`requirePermission`, `auth.js`'s
`assign_role`/`transfer_owner`, the specific `requirePermission(event, permKey)`
call in each of `admin.js`/`changeorders.js`/`send-workorder.js`, and the
relevant `firestore.rules` predicates for `users`, `audit_logs`,
`changeorder_approvals`, and `buildings` delete) into a mocked harness using the
real `SEED_ROLES` grant values for the specific keys under test, then run in the
browser — same "re-implement and verify" methodology Phase 1 used for
`permissions.js` itself, extended to cover Phase 5's new gates.

| # | Scenario | Layer | Expected | Result |
|---|---|---|---|---|
| 1a | field_tech `assign_role` self → admin | server | FAIL | ✅ "Cannot change your own role" |
| 1b | field_tech writes `users/{self}` directly | rules | FAIL | ✅ `write: if false` unconditional |
| 2a | field_tech grants admin to someone else | server | FAIL | ✅ "Only the owner may grant or remove admin" |
| 2b | field_tech self-targets any role change | server | FAIL | ✅ "Cannot change your own role" |
| 3a | field_tech approves change-order pricing | server | FAIL | ✅ missing `changeorder.approve_pricing` |
| 3b | field_tech writes `changeorder_approvals` directly | rules | FAIL | ✅ `write: if false` unconditional |
| 4a | field_tech emails a customer document | server | FAIL | ✅ missing `doc.email_customer` |
| 5a | field_tech purges a building | server | FAIL | ✅ missing `buildings.purge` |
| 5b | field_tech deletes a building doc directly | rules | FAIL | ✅ `delete: if false` unconditional |
| 6a | admin `assign_role`s the owner away | server | FAIL | ✅ "Cannot change the owner's role" |
| 6b | admin calls `transfer_owner` | server | FAIL | ✅ "Only the current owner may transfer ownership" |
| 6c | admin writes `users/{ownerUid}` directly | rules | FAIL | ✅ `write: if false`, unconditional for ALL clients incl. admin |
| 7a | owner updates an audit_logs entry | rules | FAIL | ✅ `update: if false`, unconditional incl. owner |
| 7b | field_tech deletes an audit_logs entry | rules | FAIL | ✅ `delete: if false` unconditional |
| 7c | any client creates an audit_logs entry directly | rules | FAIL | ✅ `create: if false` — Admin SDK only |
| P1 | owner purges a building | server | SUCCEED | ✅ |
| P2 | service_manager approves pricing | server | SUCCEED | ✅ grant: true |
| P3 | service_manager emails a customer doc | server | SUCCEED | ✅ grant: true |
| P4 | admin promotes a non-admin user to a non-admin role | server | SUCCEED | ✅ has `users.manage_nonadmin` |
| P5 | owner grants admin | server | SUCCEED | ✅ owner bypasses the admin-only gate |
| P6 | owner calls `transfer_owner` | server | SUCCEED | ✅ |

All 21 produced the correct pass/fail outcome, including every one of Mark's
seven mandatory scenarios and the two he called out explicitly by name
(field_tech self-promotion, admin locking out the owner).

- **Client-side smoke check**: `js/core.js` reloaded in the local preview after
  every edit, console checked clean (no syntax errors) — the only check possible
  for the client half from this environment. `renderLoginGate()` verified
  against all four real states (no `fauth` configured → hidden; `fauth` present,
  not bootstrapped → bootstrap form; bootstrapped, signed out → sign-in form;
  signed in → hidden).
- **Server-side files** (`admin.js`, `photos.js`, `changeorders.js`,
  `send-workorder.js`, `authGuard.js`): validated by full manual read-through
  (balanced braces/parens, correct `require()`s, every `requirePermission`/
  `writeAuditLog` call site checked against its actual usage) — no `node -c`
  available, same constraint as every other server function change validated
  this way all session. Real syntax validation happens implicitly on the next
  Netlify deploy (a broken function fails loudly there); confirmed post-push by
  polling the deployed `js/core.js`/function behavior, not just assumed.
- **Client caller audit**: grepped every direct `fetch()` call to
  `/.netlify/functions/{admin,photos,changeorders}` across every module, not
  just the wrapper functions — found and fixed one bypass
  (`js/history.js`'s direct `send-workorder` call, which wasn't going through
  `authHeaders()`). A single missed call site would have silently defeated the
  `doc.email_customer` gate for that one code path while everything else
  correctly enforced it — worth the extra grep.

### Not done this phase (explicitly out of scope, not overlooked)

- **MFA** (Phase 4) — see "Trade surfaced" above.
- **Full change-order 5-stage workflow** — one gate (`approve_pricing`) proven
  real and enforced; Draft/Requested/Report-Approved/Sent stages, their UI, and
  their own audit trail remain Phase 3 work.
- **Blanket dual enforcement across all 34 permission keys** — this phase adds
  real, tested enforcement for the specific actions Mark named (purge, pricing
  approval, customer email) plus everything already gated by `admin.js`. Normal
  workorder/building/customer CRUD through the client Firestore SDK is still
  governed by the existing open rules (`allow read, write: if true`) for the
  same production-compatibility reason Phase 2 already established — scoping
  `"proj"`/`"own"` resolution and tightening those collections' rules is later-
  phase work, not silently done here.
- **Owner bootstrap itself was not run** — see above; this is Mark's step to
  complete, not mine.
