# RoofOps Field App Overview

## What This App Does

RoofOps Field is a field work order app for commercial roofing service work. It lets a technician or manager create a leak/work order report, add roof investigation findings, document repairs, attach photos, generate a PDF, and send that report by email.

The app is currently built for the Watkins Roofing workflow, but the long-term direction is to grow it into a broader RoofOps platform where every building has a roof history over time.

## Home Screen

Opening the app shows a **Home** launcher — big tappable tiles for each work order
type (Leak Work Order, Change Order, Inspection, Repair, Warranty), plus RoofMapper,
Building History, and Reports as quick jumps to those tabs. Tapping a work-order-type
tile starts a brand-new work order already set to that type. It's a launcher, not a
gate: the existing header tabs (Edit, Preview, Saved, Building History, Reports,
RoofMapper) all still work exactly as before, opening/editing an existing saved work
order always goes straight to its form (never through Home), and **"+ New"** in the
header returns to Home to start something new rather than immediately blanking the
form. Tapping the Watkins logo in the header also returns to Home from anywhere.

## Main Workflow

1. Open the app — pick a tile on the Home screen to start, or use "+ New" any time
   from within an existing work order. Opening an existing/saved work order skips
   Home and goes straight to its form.
2. Optionally tap **"🔍 Select Existing Building"** at the top of Job Information to
   pick a building/customer that's already been worked on before — its Job Name, Bill
   To, Location, and Roof System fill in automatically instead of being re-typed
   (helps avoid accidentally creating a duplicate building record from a slightly
   different spelling). Skip this and just type if it's a brand-new job/customer.
3. The **Work Order Type** at the top of Job Information is already set from the tile
   picked on Home (defaults to Leak / Service for anything started another way) — change
   it here any time if needed. See "Work Order Types" below. Fill out the work order
   details:
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
   photo to the specific finding it documents. See "Managing Photos" below for
   reordering and viewing them enlarged.
5. Optionally place a pin on the roof map for any finding — see "How the Roof Map
   Works" below.
6. Preview the report.
7. Send, share, or download the PDF.
8. The app saves the work order and logs report/history information, including any
   pins placed, onto that building's permanent record.

## Work Order Types

Every work order has a type — **Leak / Service** (the default, and what every work
order was implicitly before this existed), **Change Order**, **Inspection**,
**Repair**, or **Warranty**. Pick it at the top of Job Information; everything else
about the form stays the same for most types.

**Change Order** reveals extra fields — Cost, Man-Hours, PO Number (optional), Date
Completed (optional), Materials, Description of Work Performed, and its own **Photos**
capture (📷 Take Photo / + Add Photos, right there in the Change Order card — since a
change order has no findings, every photo added here just belongs to the change order
itself; each gets its own auto-pin from GPS the same way a finding's photo does) — and
generates a **completely separate PDF**, styled like a real change-order/
work-authorization document rather than the leak inspection report: "CHANGE ORDER"
title in the Watkins red, job info, a prominent Description of Work Performed, an
itemized Materials list, a Cost Summary with a Total, an Approved By / Date signature
line, and those photos as a secondary grid at the end. No findings table or warranty
section — that framing belongs to the leak report, not a change order. The form
itself shows only what a Change Order needs: Roof Investigation Findings, the plain
"Work Performed" list, and the global Photo Documentation section are all hidden for
this type — its own Change Order Details card (with its own photo box) covers
everything, so nothing is duplicated or irrelevant.

**Repair** is for project/small-project work — flashing a curb, several curbs and
boots, that kind of scope — rather than a leak diagnosis. It hides the Roof
Investigation Findings section entirely (leak pins/conditions don't apply) and shows a
**Repair Scope** card instead: a Description of Work Performed, plus an itemized
Repair Items list (Type — Curb, Pipe Boot / Flashing, Seam, Vent, Drain, etc., worded
to match the existing roof-asset vocabulary — with a Quantity and Notes/Location per
item). Everything else on the form (job info, work order/job number, technician, roof
map context, Work Performed, Warranty Determination, photos) stays exactly the same as
a Leak/Service work order. Its report/PDF reuses the same leak-report layout — same
job info, same photo documentation — just titled "Repair / Project Report" with the
findings section swapped for Repair Scope.

Inspection and Warranty still use the standard leak report format for now (Mark is
defining their fields incrementally).

The type also shows up on that building's Building History timeline and in the
Reports tab (as a filterable "Work Order Type," alongside Report Type, Technician,
etc.) — so, for example, "every Change Order this month across every building" is a
real question the Reports tab can answer.

## Warranty Guidelines Reference (Leak / Service only)

The Warranty Determination card on a **Leak / Service** work order — and only that
type, since these lists are "for leaks and leaks only" — has a collapsible "Warranty
Guidelines (reference for techs)" section, closed by default, tap to expand. It's a
plain, display-only reference for two informal guideline lists (not tied to any
manufacturer program):

- **Typically Warrantable**: membrane seam failures, failed factory flashings,
  premature material defects, membrane splits/cracks from material defects, failures
  from warranted workmanship, water leaks from covered roofing system defects.
- **Typically Not Warrantable**: damage from other trades, foot traffic, dropped tools/
  punctures, cuts/gouges, vandalism, storm damage (unless covered), hail (unless
  purchased), animal damage, chemical contamination, lack of maintenance, clogged
  drains, settlement ponding, post-install modifications, unauthorized repairs, normal
  aging, cosmetic-only issues.

Nothing is selected, tagged, or saved — it's just a quick lookup for the tech while
filling out the Warrantable/Non-Warrantable Repairs textareas below it. The lists live
in one constant (`WARRANTY_GUIDELINES` in index.html) so they're easy to edit.

Right below it, also Leak/Service only, is an optional **Manufacturer Service #**
field — for a warrantable leak, there's usually also a manufacturer's own work order/
service number (Mark: "~9 times out of 10"). It's a single text field; when filled, it
prints on the leak report alongside Warrantable/Non-Warrantable Repairs.

## Managing Photos

**📷 Take Photo** opens the device camera directly (not a file picker) and, if
location access is available, grabs the device's current GPS at the moment of
capture. **+ Add Photos** (choose from library) never attaches a location guess,
since a library photo could be old or from somewhere else.

**Capture right in the finding it belongs to.** Each finding in Roof Investigation
Findings has its own "📷 Take Photo" / "+ Add Photos" buttons and a small photo
strip, right there in the finding's card — this is the fast path, since caption,
finding link, and map pin all attach in one action: capture the photo, and if GPS
was available, the pin drops on the roof map immediately, no extra step. Consumer
GPS is only accurate to ~10-30ft, so treat the pin as a starting point and drag to
fine-tune (from "📍 Pinned — move" on that finding) rather than a final placement.
No GPS available (denied, unsupported, or timed out) just means no auto-pin — the
photo itself always saves either way. A pin that's already been placed — manually or
from an earlier photo — is never overwritten by a later one.

The global **Photo Documentation** section (bottom of the form) still shows *every*
photo on the job — from a finding, general, or imported from CompanyCam — and is
where reordering (print order) and reassigning a photo's finding both happen. Adding
a photo there instead of inside a finding works exactly as before: it's just not
linked to a finding until you pick one from its dropdown. **Hidden for Change Order**
specifically, since that type has its own in-scope photo box instead (see "Work Order
Types" above) — showing both would just be the same photos twice.

Photo size (small/medium/large — how much a photo gets compressed/downscaled before
saving) isn't a per-user choice anymore — it's one setting for everyone, defaulting
to small (email-friendly), changeable only by an admin. See "Admin Mode" below.

Every photo — whether taken with the camera, added from the device library, or
imported from CompanyCam — shows up the same way in the Photo Documentation section,
in the order they'll print into the PDF:

- **Tap a photo's thumbnail** to open it enlarged, near-full-screen. Tap the dark
  background or the **✕ Close** button to dismiss it. Tapping the caption, the ▲/▼
  buttons, or ✕ (remove) never opens the enlarged view — only the thumbnail image
  itself does.
- **▲ / ▼** on each photo moves it up or down in the list. The order shown here is
  the order photos print into the generated PDF, so this is how to put the most
  important photo first, group related ones together, etc. Captions and any linked
  finding move together with their photo — reordering never mixes them up. On a
  desktop browser, dragging a photo by its row works too, as a shortcut for the same
  thing; on a phone, the ▲/▼ buttons are the reliable way to reorder (touch
  drag-and-drop is inconsistent across phones, so it's intentionally not the primary
  method).

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

**If GPS puts you in the wrong spot** (common on desktop — location is IP-based there,
often miles off; happens on phones too) — pan/zoom the map by hand to the actual
building, then tap **"🔍 Search This Area"** to re-run the same building-footprint
search centered on wherever the map sits now, instead of the original GPS point. The
old search results clear automatically so there's never overlap between an old and
new set of outlines. This is the recovery path whenever the GPS fix doesn't land on
a clickable building — GPS itself is unchanged, this only helps when it's wrong.

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

There is no manual sync button now. Importing CompanyCam photos is one way to link a work order to a project — the other is picking a building via **🔍 Select Existing Building** that's already linked (the picker shows "🔗 CompanyCam linked" next to those); the link now carries over automatically in that case too, unless the work order is already linked to something else. An admin (see "Admin Mode" below) can unlink a project from the CompanyCam banner if it was linked by mistake — field users cannot.

**Saving the report PDF to CompanyCam**: when a work order is linked, generating the report via **Send Email Now**, **Share / Email PDF**, or **Download PDF** all attempt to save the PDF back into that CompanyCam project as a document (Print does not — it prints the on-screen preview directly, no PDF file is produced to save). The result is shown as a persistent badge on that report's entry in Building History and the Reports tab: **☁️ Saved to CompanyCam** (green) or **⚠️ Not saved to CompanyCam** (red — shown whether the work order simply isn't linked, or a real upload attempt failed; a failure also shows the specific error text). A report generated before this shipped just shows no badge.

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
- An **app-wide Photo Size setting** (small/medium/large) — a small bar at the top of
  every screen while admin mode is on, since it's a global setting rather than
  something tied to whatever work order happens to be open. Setting it applies to
  every user's *new* photos from that point on; it doesn't reprocess anything already
  saved. Defaults to small (email-friendly) if never set.

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

## Logo & Brand Palette

The Watkins Roofing logo lives in exactly one place: `var LOGO` near the top of
`index.html`'s script — a single base64 PNG data URI. It's reused as-is in three
spots: the header (`#hdr-logo`), the on-screen report preview (`renderDoc()`), and
the actual generated PDF header (`generateLeakReportPdf()`/`generateChangeOrderPdf()`
both call `doc.addImage(LOGO, ...)`).

Extracted from the logo itself (sampling solid letter-stroke pixels to avoid
anti-aliasing noise), for use in future styling work:

| Color | Hex | Where it's from |
|---|---|---|
| Brand red | `#B4223F` | The "WATKINS" wordmark |
| Black | `#000000` | "ROOFING" outline + the roofline triangle icon |
| Muted charcoal | `~#4A4A4E` | "SINCE 1935" tagline (likely just anti-aliasing on thin text, not a deliberate third color) |

The app's *current* CSS palette (`--slate:#263238`, `--orange:#E8600A`) doesn't match
this at all — worth knowing before the planned aesthetic polish pass. The brand red is
already used in one new place as of 2026-07-10: the Home screen's work-order-type
tiles and the Change Order PDF's title, both deliberately scoped additions rather than
a broader restyle.

**Note**: `var LOGO` above is the older "Watkins Roofing" wordmark used *inside* the
app (header, PDF, preview) — unrelated to the newer "RoofOps" house-monogram logo
used for the home-screen icon below. The two haven't been unified; that's a
question for the aesthetic polish pass, not something this session decided.

## Home-Screen App Icon

Adding the app to an iOS home screen ("Add to Home Screen") now shows a real RoofOps
icon instead of a screenshot of the page — a metallic "RO" house monogram (cropped
from the new RoofOps logo; the "ROOF OPS" wordmark wasn't legible at real icon sizes)
on a black background. Wired via `manifest.json` (repo root) plus `apple-touch-icon`/
`theme-color` tags in `index.html`'s `<head>`.

The **dev build's icon has a red "DEV" ribbon** across the corner so it's obviously
different from production at a glance — useful since Mark may have both added to his
home screen at once. See `icons/README.md` for the full asset layout (source logo,
generation script, dev vs. prod icon sets) and "Home-screen app icon" in
`DEV_NOTES.md` for how it was built. Production icons (no ribbon) are already
generated and sitting in `icons/prod/`, just not wired in yet.

iOS caches home-screen icons per shortcut — after this ships, an *existing* dev
shortcut on a phone needs to be deleted and re-added to pick up the new icon; a
plain page reload won't do it.

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
