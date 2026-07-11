# RoofOps Authentication & Authorization — Design (Rev 3, approved)

Status: **Phase 1 in progress.** Dev branch only — this system does not exist on
`main` and must not be deployed there until a separate, explicit go-live decision.

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
