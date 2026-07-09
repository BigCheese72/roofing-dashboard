# RoofOps Field App Overview

## What This App Does

RoofOps Field is a field work order app for commercial roofing service work. It lets a technician or manager create a leak/work order report, add roof investigation findings, document repairs, attach photos, generate a PDF, and send that report by email.

The app is currently built for the Watkins Roofing workflow, but the long-term direction is to grow it into a broader RoofOps platform where every building has a roof history over time.

## Main Workflow

1. Open the app.
2. Optionally tap **"🔍 Select Existing Building"** at the top of Job Information to
   pick a building/customer that's already been worked on before — its Job Name, Bill
   To, Location, and Roof System fill in automatically instead of being re-typed
   (helps avoid accidentally creating a duplicate building record from a slightly
   different spelling). Skip this and just type if it's a brand-new job/customer.
3. Fill out the work order details:
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
4. Add photos from the device or import them from CompanyCam. Optionally link each
   photo to the specific finding it documents.
5. Optionally place a pin on the roof map for any finding — see "How the Roof Map
   Works" below.
6. Preview the report.
7. Send, share, or download the PDF.
8. The app saves the work order and logs report/history information, including any
   pins placed, onto that building's permanent record.

## How the Roof Map Works

Every finding can get a pin showing where on the roof it was found. Tap **"📍 Place on
Map"** on a finding to open a map:

- **Default**: a satellite view, centered on the job address automatically. Drag the
  pin to the exact spot.
- **If a linked CompanyCam photo has GPS data**, the pin starts there instead — still
  drag it to correct if the phone's GPS wasn't precise (roofs are small; GPS often
  isn't accurate enough on its own).
- **"📍 Use My Location"** drops the pin from your device's own GPS instead — best
  option if you're standing at the spot right now.
- **If a building has a custom roof plan or sketch uploaded** (an admin-only setting,
  see below), pins go on that image instead of satellite.

Already have a pin? The button becomes **"📍 Pinned — move"** — reopens the same map,
drag/tap to correct it, then Save. A correction updates immediately, including on any
past report that already showed that finding — no need to re-download or re-send a PDF
just to fix a pin's location.

Every building also has a **Roof Map** in the Building History tab showing every pin
from every past report at once, color-coded by warranty status (green = warrantable,
red = non-warrantable, amber = undetermined). Tap a pin to see the date, work order
number, condition, and warranty status — **"View Work Order"** jumps to the full work
order, or **"Adjust Pin"** jumps straight into that finding's editable pin map in one
tap (the Roof Map itself is a read-only summary across every report, so this is the
shortcut to actually move something you see on it).

## Roof Features (permanent roof assets)

Separate from finding pins, the Roof Map also shows **permanent features of the roof
itself** — drains, scuppers, HVAC units, pipe flashings, vents, hatches, expansion
joints, skylights, curbs, penetrations, core cuts, test cuts, safety hazards. Unlike a
finding pin (tied to one report, historical), these exist independent of any work
order and are meant to be kept current as the roof itself changes.

Tap **"+ Add Roof Feature"** on a building's Roof Map, pick a type, optionally add a
label and notes, and place it — no admin PIN needed, any tech can add, move, or remove
one. Each type gets its own icon/color so they're easy to tell apart from finding pins
at a glance. Tap an existing feature's marker to edit or remove it.

**Custom base maps** (admin-only): a building can use something other than satellite.
Requires the building to already have a CompanyCam project linked. Set from the
Building History tab, in admin mode.

- **Roof plan or sketch** — useful when satellite imagery isn't detailed enough
  (heavy rooftop equipment, complex multi-section roofs). Just an image upload.
- **Drone orthomosaic** — for full GPS accuracy. Drone orthomosaic files are too large
  and specialized for the app to process directly, so there's a companion script
  (`tools/geotiff_to_webmap.py`) that converts the raw file into a small image plus
  the exact GPS coordinates of its corners, which get pasted into the upload form
  alongside the image.

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
- roof map pin placement (satellite default, photo-GPS guess, custom base maps) and
  the building-wide history map;
- Netlify deployment.

Major redesigns or new modules should be added carefully after the current field workflow is stable.
