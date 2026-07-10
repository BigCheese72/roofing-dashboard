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
  pin to the exact spot. On a large roof, pinch/zoom in further than usual — the map
  now enlarges the sharpest available imagery instead of stopping short, giving a
  bigger, easier-to-tap target for precise placement. If a specific roof is still too
  hard to read even zoomed all the way in, ask an admin about setting a custom base
  map (roof plan/sketch, or a drone photo) for that building — see below.
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

## How RoofMapper Works

RoofMapper (a tab in the header, alongside Edit/Preview/Saved/Building History/Reports)
helps a tech capture a clean roof outline for a building on the spot:

1. Open the **RoofMapper** tab and tap **"📍 Use My Location"** — the app requests
   high-accuracy GPS and shows your current location and its accuracy on a map.
2. The app automatically searches free OpenStreetMap data for building footprints near
   you.
3. Tap the correct building's outline on the map — its name/address/type (if OSM has
   them) show below.
4. Tap **"✏️ Generate Roof Outline"** — the app cleans up that footprint into a roof
   outline and shows its area and perimeter.
5. Save it — **"💾 Save Outline to Building"** links it to an existing building (search
   by name) or creates a new one on the spot, or **"📱 Save on This Device Only"** if
   there's no signal or the building isn't in RoofOps yet (link it later from the
   "Saved On This Device" list).
6. Export **SVG**, **PNG**, or **PDF** any time — all generated on the device, no
   internet required once the outline exists.

Saved outlines also show up on that building's existing **Roof Map** in Building
History, alongside finding pins and permanent roof features. If GPS accuracy is poor,
no buildings are found nearby, or OpenStreetMap can't be reached, RoofMapper shows a
plain-language message and a way to try again rather than failing silently.

RoofMapper is Phase 1 — see `ROADMAP.md` for what's planned next (drains, HVAC,
scuppers, pipe penetrations, dimensions, CompanyCam photos, drone orthomosaic overlays,
roof history over time).

## Logging Activities

Not everything worth recording on a building's history comes from a generated PDF
report. **"+ Log Activity"** on a building's Building History page (in the Timeline
card) records something that happened without requiring a work order or a report:
Service Call, Leak Investigation, Repair, Roof Replacement, Warranty Inspection, Drone
Flight, Thermal Scan, Moisture Survey, Customer Conversation, or Note/Other. Fill in the
date, an optional technician/author, and a free-text note, then save — it shows up in
the timeline immediately alongside generated reports, and in the cross-building
**Reports** tab too. On a building with more than one roof, it logs to whichever roof
is currently selected on the page (a hint shows which one); a single-roof building
skips that entirely. Unlike resending the same report (which updates one timeline
entry in place), each logged activity is always its own separate entry — logging two
different things a few minutes apart never merges them together.

## Roof Profile

Every roof also has a permanent **Roof Profile** — a card in Building History, scoped
to whichever roof is currently selected, sitting above the Roof Map. It shows: roof
system, install date, estimated age, health score, condition, manufacturer, deck type,
insulation type, warranty provider/expiration/status, drainage notes, customer
contacts, internal notes, replacement history, and estimated remaining life. Anyone can
view it — a field with nothing entered just shows "Not set" rather than a blank or an
error. Only **Admin mode** can edit it (**"Edit Profile"**), the same PIN-gated
protection as the custom base map, since these are shared, building-wide facts rather
than something a tech should casually overwrite mid-job. On a building with more than
one roof, the roof picker's dropdown also shows each roof's condition right in the
list (e.g. "East Wing — Critical") — a quick way to spot roof health without opening
the profile itself.

## Timeline Filters

The Timeline on a building's Building History page can be filtered by **date range,
roof area, technician, warranty status, and report type**. The dropdown filters only
ever list values that actually appear on that building's own timeline — so you won't
see a technician's name in the filter unless they've actually logged a report for this
building, and logged activity types (Drone Flight, Customer Conversation, etc.) show up
in the "Report Type" filter the same way generated-report types do. Filters narrow
instantly (no waiting on the network) and can be combined — e.g. one technician's
non-warrantable reports from last month. **"Clear Filters"** resets back to the full
timeline. Note the date range filters by when the entry was logged, not the "Date of
Service" typed into a work order — those are usually the same day but aren't
guaranteed to be.

## How CompanyCam Works

CompanyCam is used as the source for project photos and as the preferred place to save generated report PDFs.

When the user clicks **Import from CompanyCam**:

1. The app searches CompanyCam projects through a Netlify Function.
2. The user selects a CompanyCam project.
3. The app loads that project's photos.
4. The user selects photos to import.
5. The app automatically locks the work order to that CompanyCam project.
6. The app pulls the CompanyCam project's name and address into Job Name and Location — filling them in if blank, or upgrading a shorter/partial entry to the fuller CompanyCam value. It never overwrites a Job Name or Location that's already something different.
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

The app also saves locally in the browser as a fallback, so work is not immediately lost if cloud sync is unavailable. That local fallback has a small storage limit (a browser thing, not a Firebase one), so it only keeps full offline photo copies for **the work order you're actively editing** and a handful of your most recently saved ones — just *opening* an old report to look at it no longer uses up that space, though its photos won't show if you reopen it later with no internet at all.

## How PDFs And Email Work

PDFs are generated in the browser using jsPDF.

When the user sends or shares a report:

1. The app auto-saves the work order.
2. The app generates a PDF from the current form and photos.
3. For **Send Email Now**, the PDF is sent through a Netlify Function using Resend.
4. The report event is logged to Firebase.
5. If the work order is linked to a CompanyCam project, the PDF is uploaded back to CompanyCam as a project document.

This means the user should not have to remember to manually save before sending.

After **Send Email Now** succeeds, that work order shows **"📧 Emailed [date/time]"**
right on its card in the **Saved** tab — so anyone (office or tech) can tell at a
glance whether a report actually went out, without having to dig through Building
History. The full detail (exact recipients, subject, which report) is also recorded on
that building's timeline and in the **Reports** tab, shown as an explicit
"Emailed to …" line.

Each email now sends from a job-specific address (e.g. `WO1234@watkinsroofing.net`)
instead of one shared sender, using the work order's Job No. — makes it obvious which
job an email is about at a glance, even before opening it. If a customer hits Reply,
it's routed to a real monitored inbox rather than that per-job address (which isn't a
real mailbox).

## Admin Mode

Field techs should not be able to unlink a CompanyCam project or delete building
history. A small "Admin" button in the header prompts for a PIN, which is verified
server-side (not just checked in the browser — see DEV_NOTES.md); once unlocked it
reveals:

- **Unlink** on the CompanyCam banner.
- **Delete (admin)** per building in Building History (removes the building and its
  report/history records; leaves the underlying work orders alone).
- **Delete (admin)** per timeline entry inside a building's "View Timeline" panel.
- **Edit Profile** on a roof's Roof Profile card — age, warranty, condition, and the
  rest of that roof's permanent facts.
- Uploading/clearing a roof's custom base map.

The timeline also auto-flags **possible duplicate entries** — same work order + same
report type logged within 5 minutes of each other, almost always a double-click or a
retried Send/Share/Download. This is a visual flag only; an admin decides whether to
delete the flagged entry.

The **building list** in Building History similarly flags **possible duplicate
buildings** — same customer, very similar building name (a typo or a slightly
different spelling of the same site). This is currently a visual flag only, same as
the duplicate-entry flag above; there's no merge button yet.

## All Reports Tab

The **Reports** tab lists every generated report across every building, most recent
first — read-only, no admin needed. Filter by search text (building or customer name),
date range, roof area, technician, warranty status, or report type. Tap any report to
jump straight to that building's full timeline in Building History.

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
- RoofMapper (GPS locate, Overpass building-footprint search, outline generation,
  save-to-building/local, SVG/PNG/PDF export);
- Netlify deployment.

Major redesigns or new modules should be added carefully after the current field workflow is stable.
