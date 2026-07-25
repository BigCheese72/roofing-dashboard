# RoofOps Architecture

RoofOps Field is a static Netlify app with serverless functions and Firebase Firestore.

There is no frontend build step. The browser loads `index.html`, external CDN libraries, and local JavaScript modules directly.

## Runtime Shape

```text
Browser
  index.html
  css/app.css
  js/*.js
  CDN libraries

Netlify Functions
  CompanyCam proxy
  Resend email
  Firebase Admin operations
  Auth/user management
  AI summary/scope services
  Foundation sync
  Microsoft Graph / Outlook
  ArcGIS tile proxy

Firebase
  Firestore
  Firebase Auth
  Firestore rules
  Firestore indexes

External systems
  CompanyCam
  Resend
  Microsoft Graph / Outlook
  Foundation SQL data source
  ArcGIS imagery
  OpenStreetMap / Nominatim / Overpass
```

## Entry Point

`index.html` is the app shell. It includes:

- head metadata and PWA manifest/icon wiring
- CDN library scripts
- main markup for views/cards/modals
- version-stamped local scripts

Because local modules are plain scripts, global function compatibility and script load order matter.

## Frontend Modules

### `js/core.js`

App shell and shared coordination:

- Firebase initialization
- auth state
- view switching
- account/admin UI wiring
- shared helpers
- work order type display gating
- script-level app setup

### `js/workorders.js`

Shared work order behavior:

- collect/fill/save/load
- work order form state
- amendments / return visits
- building picker integration
- findings/repairs/materials behavior
- work order cloud/local persistence hooks

### `js/photos.js`

Photo pipeline:

- capture/import/add photo flows
- resizing/downscaling
- caption and assignment behavior
- GPS/pin helpers
- IndexedDB/local storage byte handling
- CompanyCam/import integration points

### `js/export.js`

Report output:

- text builders
- HTML preview builders
- PDF builders
- per-type report output logic

### `js/inspections.js`

Inspection-specific logic:

- checklist structure
- inspection checklist rendering
- checklist-to-finding behavior
- inspection photo and pin rules

### `js/buildinghistory.js` and `js/history.js`

Building and roof history:

- inline history on work orders
- building history list
- timeline filtering/rendering
- duplicate detection
- building maps
- report/history interactions
- warranty report review areas where applicable

### `js/roofmapper.js`

RoofMapper:

- roof outline capture
- OSM/Overpass footprint workflows
- manual trace / walk corners / drone image trace
- roof sections, labels, dimensions, holes
- roof features and markups
- map rendering

### `js/dpr.js`

Daily Progress Reports:

- DPR forms
- crew/hours/weather/toolbox/rented-equipment workflows
- CompanyCam integration for DPR photos
- Foundation job linkage

### `js/servicemanager.js`

Service Manager workflows:

- proposal/service management flows
- Outlook/contacts integration surfaces
- Foundation linkage where implemented

### `js/roles-admin.js`

Admin and user management UI:

- role/user management display and actions
- permission-aware admin controls

### `js/ailabels.js`

AI training label client support:

- issue-label vocabulary
- label validation
- confirmed-label write shape

### `js/help.js`

Help and assistant-facing support UI.

## Serverless Functions

Netlify functions are the server boundary for secrets and privileged actions.

Key functions:

- `companycam.js`: CompanyCam project/photo/document proxy.
- `send-workorder.js`: Resend work order email delivery.
- `send-feedback.js`: feedback email delivery.
- `admin.js`: privileged building/history/settings/audit/admin actions.
- `auth.js`: role seeding, owner bootstrap, user creation, role assignment, owner transfer.
- `photos.js`: photo migration/storage operations.
- `changeorders.js`: change order pricing approval gate.
- `generate-summary.js`: AI-generated report summaries.
- `generate-scope.js`: AI-generated scope drafts.
- `ai-service.js`: AI issue/service support.
- `foundation.js`: Foundation data reads.
- `foundation-sync.js`: Foundation job sync.
- `contacts-sync.js`: Microsoft contacts/mail workflows.
- `outlook.js`, `ms-auth-start.js`, `ms-auth-callback.js`: Microsoft Graph auth/mail integration.
- `inspection-reports.js`: warranty/inspection report ingestion.
- `arcgis-tile.js`: ArcGIS imagery proxy.

Shared function libraries live in `netlify/functions/lib/`.

## Deployment

Netlify is configured by `netlify.toml`.

Current build command:

```bash
npm install && node scripts/deploy-firestore-rules.js
```

The site publishes the repository root and uses `netlify/functions` for functions.

Firestore rules and indexes are configured through:

- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`
- `scripts/deploy-firestore-rules.js`

## Testing

The project uses Node's built-in test runner.

```bash
npm test
```

On Windows PowerShell, use `npm.cmd test` if script execution policy blocks `npm.ps1`.

Install dependencies first in a fresh clone.

## Architectural Constraints

- Preserve the no-build-step frontend unless a migration is explicitly approved.
- Keep secrets out of browser code.
- Keep privileged work in Netlify Functions.
- Keep Firestore rules in sync with server-function authorization.
- Keep report PDFs and CompanyCam records consistent.
- Keep large binary data out of Firestore where possible.
- Avoid cross-module rewrites during feature work.
