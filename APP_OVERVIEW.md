# RoofOps Field App Overview

## What This App Does

RoofOps Field is a field work order app for commercial roofing service work. It lets a technician or manager create a leak/work order report, add roof investigation findings, document repairs, attach photos, generate a PDF, and send that report by email.

The app is currently built for the Watkins Roofing workflow, but the long-term direction is to grow it into a broader RoofOps platform where every building has a roof history over time.

## Main Workflow

1. Open the app.
2. Fill out the work order details:
   - job name
   - location
   - date of service
   - job number
   - bill-to/customer
   - technician
   - roof system
   - leak area
   - findings
   - repairs
   - warranty determination
   - summary
3. Add photos from the device or import them from CompanyCam.
4. Preview the report.
5. Send, share, or download the PDF.
6. The app saves the work order and logs report/history information.

## How CompanyCam Works

CompanyCam is used as the source for project photos and as the preferred place to save generated report PDFs.

When the user clicks **Import from CompanyCam**:

1. The app searches CompanyCam projects through a Netlify Function.
2. The user selects a CompanyCam project.
3. The app loads that project's photos.
4. The user selects photos to import.
5. The app automatically locks the work order to that CompanyCam project.
6. The app pulls the CompanyCam project address into the Location field if Location is blank.
7. The app imports selected photos into the work order.
8. The app automatically saves the work order.
9. The app automatically syncs CompanyCam project/photo history metadata to Firebase.

There is no manual sync button now. Importing CompanyCam photos is the action that links and syncs the project. An admin (see "Admin Mode" below) can unlink a project from the CompanyCam banner if it was linked by mistake — field users cannot.

## How Firebase Works

Firebase Firestore stores saved work orders and the early building history records.

The app uses Firestore for:

- saved work orders;
- work order photo data;
- customers derived from the Bill To field;
- buildings derived from the Job Name and Bill To fields;
- report history;
- building history events;
- CompanyCam project/photo metadata.

The app also saves locally in the browser as a fallback, so work is not immediately lost if cloud sync is unavailable.

## How PDFs And Email Work

PDFs are generated in the browser using jsPDF.

When the user sends or shares a report:

1. The app auto-saves the work order.
2. The app generates a PDF from the current form and photos.
3. For **Send Email Now**, the PDF is sent through a Netlify Function using Resend.
4. The report event is logged to Firebase.
5. If the work order is linked to a CompanyCam project, the PDF is uploaded back to CompanyCam as a project document.

This means the user should not have to remember to manually save before sending.

## Admin Mode

Field techs should not be able to unlink a CompanyCam project or delete building
history. A small "Admin" button in the header prompts for a PIN, which is verified
server-side (not just checked in the browser — see DEV_NOTES.md); once unlocked it
reveals:

- **Unlink** on the CompanyCam banner.
- **Delete (admin)** per building in Building History (removes the building and its
  report/history records; leaves the underlying work orders alone).
- **Delete (admin)** per timeline entry inside a building's "View Timeline" panel.

The timeline also auto-flags **possible duplicate entries** — same work order + same
report type logged within 5 minutes of each other, almost always a double-click or a
retried Send/Share/Download. This is a visual flag only; an admin decides whether to
delete the flagged entry.

## How Netlify Fits In

The app is hosted on Netlify as a static site.

Netlify also runs the serverless functions that protect private API keys:

- `netlify/functions/companycam.js`
  - talks to CompanyCam;
  - keeps CompanyCam tokens out of the browser;
  - searches projects;
  - loads project details;
  - loads photos;
  - fetches selected image data;
  - uploads generated PDFs back to CompanyCam.

- `netlify/functions/send-workorder.js`
  - sends direct PDF emails through Resend;
  - keeps the Resend API key out of the browser.

The app should be tested from the deployed Netlify site or from `netlify dev`. Opening `index.html` directly with a `file://` URL will show the page, but CompanyCam and email functions will not work because Netlify Functions are not available there.

## Important Environment Variables

These are set in Netlify:

| Variable | Purpose |
|---|---|
| `COMPANYCAM_TOKEN` | Reads CompanyCam projects/photos/images. |
| `COMPANYCAM_WRITE_TOKEN` | Optional separate token for uploading PDFs to CompanyCam. Falls back to `COMPANYCAM_TOKEN` if not set. |
| `COMPANYCAM_USER_EMAIL` | Optional CompanyCam upload attribution. |
| `RESEND_API_KEY` | Sends direct report emails. |
| `FROM_EMAIL` | Optional sender email override. |

## What Not To Break

The current app is intentionally simple and mostly working. Future development should protect these working pieces:

- work order form;
- Firebase save/load;
- CompanyCam photo import;
- automatic CompanyCam project locking/sync;
- PDF generation;
- email sending;
- PDF upload back to CompanyCam (fires on Send Email Now, Share, and Download alike);
- admin-gated unlink/delete controls staying hidden from field techs by default;
- Netlify deployment.

Major redesigns or new modules should be added carefully after the current field workflow is stable.
