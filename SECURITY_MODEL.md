# RoofOps Security Model

RoofOps security depends on Firebase Auth, Firestore rules, and Netlify Functions.

UI hiding is never the security boundary. Sensitive actions must be enforced server-side or by Firestore rules.

## Main Principles

- Secrets never go to the browser.
- Firebase web config is public by design; it does not grant database access by itself.
- Firestore rules control client SDK access.
- Netlify Functions protect external API keys and privileged Firebase Admin operations.
- Client-side deletes should be blocked where practical.
- Privileged actions should be audited.
- Production promotion requires Mark's explicit approval.

## Authentication

Firebase Auth is used for user identity.

Custom claims carry a compact enforcement identity:

```js
{
  owner: boolean,
  role: string,
  mfaOk: boolean
}
```

The full permission grid is not embedded in claims because Firebase custom claims have a 1000-byte limit. Server functions and Firestore rules resolve permissions from the live `roles/{roleId}` document.

## Roles

Current role ids:

- `owner`
- `admin`
- `service_manager`
- `superintendent`
- `ops_manager`
- `project_manager`
- `estimator`
- `field_tech`
- `billing`

Role definitions live in `roles/{roleId}` and are seeded through `netlify/functions/auth.js`.

## Permissions

Canonical permission keys live in `netlify/functions/lib/permissions.js`.

Permission checks must happen where the sensitive action happens:

- Firestore rule for direct client data access.
- Netlify Function for server-side operations.
- UI gate only as a convenience layer.

## Server Function Enforcement

Important helper:

- `netlify/functions/lib/authGuard.js`

Important patterns:

- `verifyCaller(event)` verifies a Firebase ID token.
- `requirePermission(event, permKey)` verifies identity and role permission.
- Owner-only operations should check `caller.owner === true` or an owner-only permission.

Privileged function areas:

- `admin.js`: building archive/purge, history delete, settings, audit list, feedback list, roof profile/base map work.
- `auth.js`: owner bootstrap, role seeding, create user, assign role, transfer owner.
- `photos.js`: photo migration/storage operations.
- `changeorders.js`: pricing approval.
- `send-workorder.js`: customer document email.
- `inspection-reports.js`: warranty report ingestion/review.
- `contacts-sync.js` and Microsoft Graph functions: mailbox/contact operations.

## Firestore Rules

Rules live in `firestore.rules`.

The current rules intentionally preserve compatibility for some legacy collections while locking down newer collections.

Legacy/open areas still requiring careful future migration:

- `workorders`
- `workorders/{id}/photos`
- some customer/building/report/history create/update flows

Closed or restricted areas include:

- `roles`: signed-in read, no client writes.
- `users`: self or owner/admin read, no client writes.
- `audit_logs`: permission-gated read, no client writes.
- `secrets`: no client access.
- `invites`: no client access.
- `warranty_review_queue`: no client access.
- `ingested_email_attachments`: no client access.
- `ai_training_labels`: signed-in create only; no client read/update/delete.
- `foundation_jobs`: signed-in read, no client writes.
- `foundation_sync_meta`: signed-in read, no client writes.

## External Secrets

These must not be committed:

- Firebase service account JSON
- CompanyCam tokens
- Resend API key
- Microsoft Graph client secrets and refresh tokens
- Foundation database credentials
- ArcGIS API key
- AI provider API keys
- poller shared secret
- owner bootstrap secret

Netlify environment variables are the current deployment secret mechanism.

## Integrations

### CompanyCam

The browser calls Netlify Functions. CompanyCam tokens stay server-side.

### Resend

Email sending goes through `send-workorder.js` and `send-feedback.js`.

### Microsoft Graph / Outlook

Graph auth and mailbox operations stay server-side.

### Firebase Admin

Server-only privileged Firestore/Auth operations use Firebase Admin SDK in Netlify Functions.

### ArcGIS

ArcGIS imagery key is proxied through `arcgis-tile.js`.

## Known Security Gaps / Migration Work

- Some legacy Firestore collections remain permissive for production compatibility.
- MFA for owner/admin is documented as a fast-follow, not complete unless verified otherwise.
- Role-aware UI is not the same as role-aware server enforcement; server enforcement wins.
- Any new direct client write to sensitive collections must be rejected.
- Any new external integration must use server-side secret handling.

## Security Review Checklist

For every security-sensitive change, verify:

- Does the browser receive any secret?
- Does the server verify the Firebase ID token?
- Is the specific permission checked?
- Do Firestore rules block direct client bypass?
- Is the action audited if it changes privileged state?
- Are negative tests included?
- Does production compatibility require a staged migration?
- Could a field tech perform an admin action by calling the endpoint manually?
