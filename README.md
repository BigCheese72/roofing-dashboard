# RoofOps Field / Watkins Work Order App

RoofOps Field is a lightweight commercial roofing field work order app for Watkins Roofing service work. Field users can create leak work orders, document roof investigation findings and repairs, attach or import job photos, generate PDF reports, email finished reports, and keep a growing building/site history.

The current app is intentionally simple: it is a single static page with Netlify Functions for server-side API calls. Do not rebuild or replace working behavior without a clear migration plan.

## Current Structure

```text
index.html
DEV_NOTES.md
netlify.toml
netlify/
  functions/
    companycam.js
    send-workorder.js
```

## Main Responsibility Map

| Area | Main file(s) | Notes |
|---|---|---|
| Work order form and UI | `index.html` | The edit, preview, saved work orders, building history, photo documentation, and CompanyCam modal UI all live in this file. The main work order form starts in the Edit view markup. |
| Work order state and save/load | `index.html` | Functions such as `collect()`, `saveOrder()`, `loadOrder()`, `cloudSaveOrder()`, and `cloudFetchOrder()` handle form state, local storage fallback, and Firestore sync. |
| Firebase connection | `index.html` | Firebase compat scripts are loaded from CDN. `FIREBASE_CONFIG` initializes Firestore for project `watkins-service-orders`. |
| Firebase data writes | `index.html` | Work orders write to `workorders` with a `photos` subcollection. Customer, building, report, and building history records are created by `ensureCustomerAndBuilding()` and `logReportAndHistoryEvent()`. |
| CompanyCam connection | `index.html`, `netlify/functions/companycam.js` | Browser code calls `/.netlify/functions/companycam`; the function proxies CompanyCam API requests so API tokens never reach the browser. |
| CompanyCam photo import | `index.html`, `netlify/functions/companycam.js` | `openCC()`, `ccLoadProjects()`, `ccLoadPhotos()`, and `ccImport()` support project search, photo listing, server-side image fetch, and client-side compression/import. |
| CompanyCam history sync | `index.html`, `netlify/functions/companycam.js` | `syncCompanyCamHistory()` stores project/photo metadata in Firestore collection `companycam_projects`. |
| PDF generation | `index.html` | `generatePdf()` uses jsPDF and jsPDF-AutoTable from CDN to build the work order PDF in the browser. |
| PDF download/share | `index.html` | `downloadPdf()` and `sharePdf()` generate, save, share, and log report events. |
| Email/report sending | `index.html`, `netlify/functions/send-workorder.js` | `sendEmailNow()` generates the PDF, posts it to `send-workorder`, and the Netlify Function sends through Resend. |
| PDF save-back to CompanyCam | `index.html`, `netlify/functions/companycam.js` | After successful direct email, `uploadPdfToCompanyCam()` can upload the PDF as a CompanyCam project document when a project is linked. |
| Netlify functions | `netlify/functions/companycam.js`, `netlify/functions/send-workorder.js` | Serverless API boundary for CompanyCam and Resend credentials. |
| Netlify deployment | `netlify.toml` | Publishes the repo root and points Netlify Functions at `netlify/functions`. |

## Firebase Usage

Firebase Firestore is used for cloud sync and early building history foundations. The app initializes Firestore in `index.html` using the public Firebase web config. The config values are safe to keep client-side; access control belongs in Firestore security rules.

Current and foundation collections used by the app:

| Collection | Purpose |
|---|---|
| `workorders` | Primary saved work order documents. Large photo payloads are stored in a `photos` subcollection per work order. |
| `workorders/{id}/photos` | Photo data and captions for a work order. |
| `customers` | Derived from the Bill To field for future customer/building organization. |
| `buildings` | Derived from customer and Job Name fields. Used by the Building History view. |
| `reports` | Flat log of generated/downloaded/emailed/shared reports. |
| `building_history_events` | Timeline events for building/site history. |
| `companycam_projects` | Lightweight CompanyCam project/photo metadata cache. Does not store image bytes. |

The app also keeps a local storage fallback so field work can still be saved on-device if cloud sync is unavailable.

## CompanyCam Usage

CompanyCam is integrated through `netlify/functions/companycam.js`, not directly from the browser. This keeps CompanyCam tokens in Netlify environment variables.

Supported actions:

| Action | Method | Purpose |
|---|---|---|
| `projects` | `GET` | Search/list CompanyCam projects. |
| `project_detail` | `GET` | Load one project's metadata. |
| `photos` | `GET` | Load paginated photo metadata for a project. |
| `image` | `GET` | Server-side fetch of one CompanyCam image URL, returned as a data URL for import. |
| `upload_document` | `POST` | Upload a generated work order PDF back to a linked CompanyCam project. |

Imported CompanyCam photos are compressed client-side before being added to the work order. The app stores `ccPhotoId` on imported photos so future report/history records can reference the CompanyCam source.

## PDF And Report Flow

PDFs are generated in the browser from the current form data and photo list. The app can:

- download the PDF locally;
- open native sharing/email fallback flows;
- send the PDF directly through Resend using `netlify/functions/send-workorder.js`;
- log report events to Firestore;
- upload the emailed PDF back to a linked CompanyCam project.

Firebase Storage is not currently the system of record for PDFs. CompanyCam is the preferred external record for saved report PDFs when a CompanyCam project is linked.

## Netlify Deployment

This repo is configured for Netlify in `netlify.toml`:

```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

There is no frontend build step. Netlify serves `index.html` from the repository root and deploys the functions in `netlify/functions/`. The connected Netlify site should auto-deploy when commits are pushed to the connected GitHub branch.

## Environment Variables

Set these in Netlify project environment variables:

| Variable | Required | Used by | Notes |
|---|---|---|---|
| `COMPANYCAM_TOKEN` | Yes | `netlify/functions/companycam.js` | Read token for CompanyCam project, photo, and image actions. |
| `COMPANYCAM_WRITE_TOKEN` | Optional | `netlify/functions/companycam.js` | Used for `upload_document`. Falls back to `COMPANYCAM_TOKEN` if unset. Recommended if write permissions should be separately scoped. |
| `COMPANYCAM_USER_EMAIL` | Optional | `netlify/functions/companycam.js` | Adds `X-CompanyCam-User` for document upload attribution. |
| `RESEND_API_KEY` | Yes | `netlify/functions/send-workorder.js` | Sends direct PDF emails. |
| `FROM_EMAIL` | Optional | `netlify/functions/send-workorder.js` | Defaults to `Watkins Roofing Work Orders <workorders@watkinsroofing.net>`. |

Firebase web config is currently hard-coded in `index.html`. Firestore access must be controlled with Firebase security rules.

## Local Development

Because this is a static app with Netlify Functions, the closest local environment is Netlify CLI:

```bash
netlify dev
```

Opening `index.html` directly can show the UI, but direct email and CompanyCam calls require the Netlify Functions routes.

## Documentation

- `DEV_NOTES.md` contains implementation notes for the current architecture.
- `ROADMAP.md` lays out phased product direction.
- `DATA_MODEL.md` proposes future Firebase collections for the broader RoofOps platform.
