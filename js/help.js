// RoofOps Help Center + tap-to-reveal tooltips + first-run walkthrough.
//
// Ownership note: this file, css/app.css, and netlify/functions/auth.js are
// the only files this session touches. js/core.js, js/photos.js, js/export.js,
// and the other modules are other sessions' active work, so this module is
// deliberately self-contained -- it builds its own DOM (FAB buttons + modals)
// at runtime instead of requiring markup in index.html, and where it needs to
// react to app state (which screen is showing, whether someone just signed
// in), it wraps the relevant global function from the outside (see
// helpWrap()) rather than editing the function itself. index.html only needs
// one new <script src="js/help.js"></script> line to load this at all.
//
// Reads (never writes) these globals defined in core.js: currentAuthClaims,
// isAdmin, currentViewName, esc(), toast(). If any of them aren't defined yet
// when this file first runs (script load order), everything here degrades to
// "treat as signed-out / no role" rather than throwing.
"use strict";

/* ============================= Content ============================= */
// Every article: id, title (the real question a tech would type), screens
// (which showView() screens it's most relevant to -- used for "Help for this
// screen"), roles ('all' or 'admin' -- 'admin' matches the exact same
// isAdmin check every other privileged control in this app already uses, so
// an article never claims a control exists that the viewer can't actually
// see), keywords (extra search terms beyond the title), body (array of
// paragraphs/steps -- rendered as a simple list, kept short for one-handed
// phone reading).
var HELP_ARTICLES = [
  // ---- Getting started ----
  { id: "gs-new-wo", title: "How do I start a new work order?", screens: ["home"], roles: "all",
    keywords: "new create start leak change order repair inspection warranty tile",
    body: [
      "From Home, tap the tile for the type of work order you're starting (💧 Leak Work Order, 📝 Change Order, 🔍 Inspection, 🔧 Work Order, 🛡️ Warranty).",
      "From anywhere else in the app, tap ➕ New in the header -- it takes you back to Home instead of blanking your current screen.",
      "You can change the Work Order Type any time from the dropdown at the top of Job Information, if you picked the wrong tile."
    ] },
  { id: "gs-existing-building", title: "How do I fill in a job faster instead of typing everything?", screens: ["home", "edit"], roles: "all",
    keywords: "existing building customer duplicate autofill select job foundation picker",
    body: [
      "At the top of Job Information, tap \"🔍 Select Job\" and search by job # or name.",
      "The picker shows three groups: Jobs (from the accounting job list -- picking one fills Job Name, Location, Job No., Project Manager, and Bill To), buildings already in this app (fills Job Name, Bill To, Location, and Roof System), and \"☁️ From CompanyCam\" projects that aren't a building here yet -- picking one of those creates the building and links CompanyCam in one step.",
      "Everything stays editable after it fills in -- review the fields before saving. A \"🔗 Linked job\" line under the buttons shows what's linked; tap \"unlink\" to disconnect.",
      "Using the picker also avoids accidentally creating a duplicate building from a slightly different spelling of the same job name. Don't see the job yet? Just type it in by hand -- the job list refreshes automatically during the work day."
    ] },
  { id: "gs-reopen-wo", title: "How do I reopen a work order I already saved?", screens: ["home", "saved"], roles: "all",
    keywords: "reopen open saved work order find",
    body: [
      "Tap 💾 Saved in the header.",
      "Find it in the list and tap Open -- it's fully editable, same as when you first filled it out.",
      "Everyone can open and edit any saved work order. Only an admin can delete one."
    ] },

  // ---- Work order types ----
  { id: "wo-types", title: "Which work-order type do I pick?", screens: ["home", "edit"], roles: "all",
    keywords: "types which pick choose leak change order inspection work order warranty difference",
    body: [
      "💧 Leak Work Order -- investigating a leak: findings, photos, pins, and a warranty determination. It's a pure investigation, with no Work Performed section.",
      "🔧 Work Order -- executing work already sold on a proposal: a repair scope, itemized repair items, and a material list.",
      "📝 Change Order -- extra work found on a job: cost, man-hours, PO number, materials, and a customer signature. It prints its own CHANGE ORDER PDF.",
      "🔍 Inspection -- the 8-item checklist rated Good / Fair / Poor / Critical. Anything rated Fair or worse becomes a finding automatically.",
      "🛡️ Warranty -- a warranty call: findings AND Work Performed on the same form, plus the Warrantable / Non-Warrantable determination boxes.",
      "Picked the wrong one? Change the Work Order Type dropdown at the top of Job Information any time -- nothing you've typed is lost."
    ] },
  { id: "wo-leak", title: "How do I fill out a Leak Work Order?", screens: ["edit"], roles: "all",
    keywords: "leak service report finding warranty determination investigation",
    body: [
      "This is the default type, and it's a pure leak investigation -- job info, findings, the roof map and pins, photos, a Warranty Determination, and a Summary. There's no Work Performed section on it: work you actually carry out belongs on a Work Order (the type that executes scope already sold on a proposal).",
      "Each finding you add gets its own \"📷 Take Photo\" / \"+ Add Photos\" / \"Import from CompanyCam\" buttons right in its card -- capture the photo right there and it's automatically linked to that finding.",
      "A collapsible \"Warranty Guidelines (reference for techs)\" section sits above the Warrantable/Non-Warrantable Repairs boxes -- tap it open for a quick reminder of what's typically covered."
    ] },
  { id: "wo-co", title: "How do I create a Change Order?", screens: ["edit"], roles: "all",
    keywords: "change order cost materials work performed",
    body: [
      "Pick 📝 Change Order from Home, or switch Work Order Type to \"Change Order\" on an existing form.",
      "Fill in Cost, Man-Hours, PO Number, Materials, and Description of Work Performed in the Change Order Details card -- it has its own photo box, separate from findings.",
      "A Change Order generates its own PDF (\"CHANGE ORDER\"), not the leak-report layout."
    ] },
  { id: "wo-co-signature", title: "How do I get a signature on a Change Order?", screens: ["edit"], roles: "all",
    keywords: "signature sign approve change order",
    body: [
      "On the Change Order card, tap \"✍️ Get Signature.\"",
      "Have the customer sign with a finger or stylus, type their name into \"Print Name\" -- the date fills in automatically.",
      "Save it. It now shows \"✅ Signed by [name] on [date]\" with a thumbnail. Tap \"Re-sign\" to redo it, or \"Clear Signature\" to remove it.",
      "The signature prints directly into the Change Order PDF as a real signature block."
    ] },
  { id: "wo-repair", title: "How do I do a Work Order?", screens: ["edit"], roles: "all",
    keywords: "work order repair project scope curb boot flashing proposal",
    body: [
      "A Work Order is for executing work that's already been sold on a proposal. Pick 🔧 Work Order from Home. There's no findings section -- instead you get a Repair Scope card with a Description of Work Performed and an itemized Repair Items list (Type, Quantity, Notes/Location).",
      "Photos work the old way here -- the Photo Documentation section at the bottom keeps its own Take Photo / Add Photos / Import from CompanyCam buttons, since a Work Order has no findings to capture into."
    ] },
  { id: "wo-inspection", title: "How do I do a Roof Inspection?", screens: ["edit"], roles: "all",
    keywords: "inspection checklist component rating good fair poor critical",
    body: [
      "Pick 🔍 Inspection from Home. Fill in the 8-item Inspection Checklist (Membrane/Field, Flashings & Terminations, Penetrations, Drainage, Rooftop Equipment, Perimeter/Edge, Interior, Safety Hazards).",
      "Rate each Good / Fair / Poor / Critical / N/A. Each item has \"📷 Take Photo\" (live camera) and \"+ Add Photos\" (pick from your phone's library) -- use either. (CompanyCam import stays off the checklist.)",
      "Taking a live photo with 📷 automatically drops a pin on the roof map from where you're standing; a library photo is added un-pinned (place it manually if needed). Rating something Fair, Poor, or Critical automatically adds it to Findings too -- you never write it twice.",
      "If the building has more than one roof, a checklist appears near the top asking which roof(s) this inspection covers."
    ] },
  { id: "wo-warranty", title: "How do I fill out a Warranty work order?", screens: ["edit"], roles: "all",
    keywords: "warranty claim determination warrantable non-warrantable",
    body: [
      "Pick 🛡️ Warranty from Home. You get Job Information, Roof Investigation Findings (with per-finding photos and map pins), a Work Performed section, and the Warranty Determination boxes (Warrantable / Non-Warrantable Repairs).",
      "Because Warranty has both findings and Work Performed, you can pair each repair to the finding it resolves -- see \"How do I pair a before photo with an after photo?\"",
      "The report and email it produces are labeled Warranty, so the office can tell it apart at a glance."
    ] },
  { id: "wo-leak-no-job", title: "What does the \"⚠️ Leak – No Job ticket\" banner mean?", screens: ["edit"], roles: "all",
    keywords: "leak no job ticket banner warning foundation job number charlotte",
    body: [
      "It means this leak doesn't have a real accounting job number yet -- the job is still a \"Leak - No Job\" ticket.",
      "Charlotte needs to create the job in the accounting system. Once it exists, tap \"🔍 Select Job\" and link it -- the banner clears on its own.",
      "Until then, the outgoing report email automatically includes a LEAK – NO JOB TICKET note so the office knows to set the job up. You don't need to do anything extra."
    ] },
  { id: "wo-materials", title: "How do I add a Material List?", screens: ["edit"], roles: "all",
    keywords: "material list add materials quantity unit repair area",
    body: [
      "On a 🔧 Work Order or 💧 Leak Work Order, scroll to the Material List card and tap \"+ Add Material.\"",
      "Each row has Material / Description, Quantity, Unit (rolls, tubes, sq ft…), Notes, and \"For Repair Area\" -- tie the material to one specific repair, or leave it \"General / whole job.\"",
      "Removing a repair never deletes its materials -- they just go back to General / whole job.",
      "Change Orders don't use this card -- they have their own free-text Materials box inside the Change Order card (one item per line). The list is for the report only; nothing is ever written back to accounting."
    ] },
  { id: "wo-suite", title: "What is the Suite field for?", screens: ["edit"], roles: "all",
    keywords: "suite strip mall multi tenant unit tag pin label",
    body: [
      "It's for strip malls and multi-tenant sites: one address, one roof, one building record -- Suite is a label, never a separate building.",
      "Type it (e.g. \"Suite 12\") and every map pin you place on this work order gets stamped with it, so pins from different tenants on a shared roof stay tellable-apart later.",
      "Single-tenant building? Just leave it blank."
    ] },
  { id: "wo-roof-type", title: "How do I add a roof type that isn't in the list (like SSM)?", screens: ["edit"], roles: "all",
    keywords: "roof system type add new ssm epdm tpo pvc dropdown list",
    body: [
      "Open the Roof System dropdown and pick \"➕ Add new roof type…\" at the very bottom.",
      "Type the new name -- it's added to the shared list for every future work order, on every device (that's how SSM got added).",
      "If it's already on the list under a slightly different spelling, the app selects the existing one instead of creating a near-duplicate.",
      "No connection? The type still works on your device right away and joins the shared list when you're back online."
    ] },
  { id: "wo-before-after", title: "How do I pair a before photo with an after photo (finding → repair)?", screens: ["edit"], roles: "all",
    keywords: "before after pair link resolves finding repair same spot photo",
    body: [
      "On a Work Performed row, use the \"Resolves Finding (before → after, same spot)\" dropdown to pick the finding this repair fixes.",
      "The finding's photo is the BEFORE and the repair's photo is the AFTER of that exact spot. Linking also copies the finding's location and map pin onto the repair, if the repair's own fields are still empty.",
      "The finding then shows a green \"🔧 Resolved by Repair #N\" chip, and the report prints the pairing.",
      "You'll see this on types that have both findings and Work Performed on one form (Inspection and Warranty). Removing a finding never deletes a paired repair -- it just unlinks it."
    ] },
  { id: "wo-repair-pin", title: "How do I pin a repair area on the roof map?", screens: ["edit"], roles: "all",
    keywords: "repair area pin place map scope work performed marker",
    body: [
      "Every Work Performed / Repair row has its own \"📍 Place on Map\" button. Tap it, tap the map (or drag the marker) where the work happened, then Save Pin.",
      "The map is the building's saved base map (roof plan or drone photo) when it has one, satellite otherwise.",
      "Once placed, the button reads \"📍 Pinned — move.\" If the work order has a Suite, the pin is stamped with it automatically.",
      "The app won't save a pin you never touched -- tap or drag first, so a default marker position can't sneak into the report."
    ] },
  { id: "wo-summary-ai", title: "What does ✨ Draft Summary do?", screens: ["edit"], roles: "all",
    keywords: "draft summary ai generate write automatic placeholder",
    body: [
      "On Leak, Inspection, and Work Order types, tap \"✨ Draft Summary\" in the Summary card -- it writes a draft from the report's findings, checklist, repair scope, and photo captions into the Summary box.",
      "It only runs when you tap it, and it never sends anything by itself -- the draft lands in the editable box for you to review and fix before saving or sending. If the box already has text, it asks before replacing.",
      "The little message afterward tells you what happened: an AI-written draft (and how many photos it reviewed), or a plain placeholder if AI isn't available on this site or didn't answer.",
      "Always read the draft like you'd read a new guy's writeup -- you're the author, it's just the first pass."
    ] },
  { id: "wo-call-directions", title: "How do the 📞 Call and 🧭 Directions links work?", screens: ["edit"], roles: "all",
    keywords: "call phone tap dial directions navigate maps tel",
    body: [
      "Type a phone number into Contact Phone -- it formats itself as (XXX) XXX-XXXX and a \"📞 Call\" link appears under the field. Tap it to dial straight from the form.",
      "Same idea under Location: once there's an address, \"🧭 Directions\" opens turn-by-turn in Apple Maps (iPhone/iPad) or Google Maps (everything else), in a new tab so you never lose the form.",
      "Both update live as you type, and right after picking a job from \"🔍 Select Job.\""
    ] },
  { id: "wo-companycam-link", title: "How does CompanyCam linking work?", screens: ["edit", "history"], roles: "all",
    keywords: "companycam link project inherit building unlink locked",
    body: [
      "The link lives on the BUILDING, not the individual work order -- link it once and every future leak, work order, change order, and inspection for that address inherits it automatically.",
      "Link from the Photo Documentation card (\"🔗 Link / Import from CompanyCam\") by picking the existing CompanyCam project. The app never creates CompanyCam projects on its own -- it only links ones that already exist.",
      "Once linked, the banner shows \"🔗 Locked to CompanyCam project,\" imported photos come in map-pinned, and every sent or downloaded PDF is saved into the project automatically.",
      "Unlinking is admin-only, and it asks whether to unlink just this one work order or the building itself."
    ] },

  // ---- Daily Progress Report ----
  { id: "dpr-start", title: "How do I fill out a Daily Progress Report?", screens: ["dpr"], roles: "all",
    keywords: "daily progress report dpr start new foreman date job",
    body: [
      "Tap 📅 Daily Report in the header, then \"🔍 Select Job\" -- customer, address, and job number fill in automatically (Recent jobs are listed first).",
      "Pick your name under \"Foreman — who's filling this out.\" Only Job Name and Date are required, and the date defaults to today.",
      "There's ONE report per job per day, shared by everyone on the job. If another crew already started today's report, it opens automatically and you just add your part -- the green notice at the top shows who last updated it.",
      "Tap \"Save Report\" when you're done. Daily reports save straight to the cloud, so they need a connection."
    ] },
  { id: "dpr-crew", title: "How do I record the crew and hours?", screens: ["dpr"], roles: "all",
    keywords: "crew hours roster headcount time clock punches squares",
    body: [
      "In Crew & Hours, tap \"+ Add Crew Member\" and pick names -- or tap \"⏱ From Time Clock\" to pull in everyone who punched in on this job today.",
      "Per-person hours fill in from the time clock where available (look for the ⏱ badge). Type over any of them -- your edit always wins.",
      "Headcount and Hours Worked total themselves from the crew list, and a live line shows \"Total hours today\" as you go. A hand-typed different total sticks.",
      "Approx. Squares Applied is optional -- fill it in when it's useful."
    ] },
  { id: "dpr-sections", title: "What are the Yes/No sections on the daily report?", screens: ["dpr"], roles: "all",
    keywords: "delays quantities jsa incidents near miss equipment visitors yes no sections",
    body: [
      "Delays, Material Quantities, Job Safety Analysis (JSA), Incidents / Near Misses, Equipment On Site, Rented Equipment, and Site Visitors all start at \"No.\" Flip one to \"Yes\" and its fields appear.",
      "Left on No, a section stores nothing and stays out of the PDF -- the report only ever shows what actually happened today.",
      "JSA asks who conducted it, whether all crew were present, and the topics/hazards covered. Incidents ask the type (Injury, Near Miss, Property Damage, Other), who it was reported to, and what happened.",
      "Delays ask the cause (Weather, Material Delivery, Equipment, Access, Site, Other Trades, Other), hours lost, and what happened."
    ] },
  { id: "dpr-lift-checklist", title: "When do I fill out the lift pre-use safety checklist?", screens: ["dpr"], roles: "all",
    keywords: "lift checklist pre-use skytrak boom scissor rented equipment osha ansi tag out",
    body: [
      "Under Rented Equipment, add the machine (SkyTrak, boom lift, scissor lift, forklift…). If it's a lift, the \"Daily Pre-Use Safety Checklist (lift equipment)\" appears automatically.",
      "Work through the 35 checks in order -- walk-around with the engine OFF, operator station & safety devices, function test with the engine ON, then the worksite -- each machine, each day, before first use (OSHA 1910.178 / ANSI A92).",
      "Set the Result: \"Machine SAFE to operate,\" or \"Defects found — REMOVED from service & tagged.\" Any failed item means the machine is out of service and tagged -- no exceptions. Note the defects and who completed the checklist.",
      "The checklist prints into the PDF with every item marked, so there's a record of the check."
    ] },
  { id: "dpr-section-trace", title: "How do I show which section of roof we did today?", screens: ["dpr"], roles: "all",
    keywords: "trace today section progress map area square footage",
    body: [
      "In \"Roof Section Worked Today,\" tap \"✏️ Trace Today's Section\" and tap the corners of today's area on the map (at least 3) -- it figures the approximate square footage for you.",
      "\"📊 Progress Map (all days)\" stacks every day's traced section on one map, newest brightest -- the whole job's progress at a glance.",
      "The map uses the building's roof plan or drone photo when it has one, satellite otherwise."
    ] },
  { id: "dpr-photos-pdf", title: "How do daily report photos and the PDF work?", screens: ["dpr"], roles: "all",
    keywords: "dpr photos caption pdf download history sign lock view only",
    body: [
      "In Photos, use \"📷 Take Photo\" (camera -- grabs GPS for a 📍 Located badge) or \"+ Add Photos\" (library). Give each one a caption -- captions print under the photos in the PDF.",
      "\"Download PDF\" makes the Daily Progress Report PDF. Only sections you flipped to Yes print, so it stays tight.",
      "\"History\" lists recent daily reports across all jobs -- tap Open on any of them. \"➕ New\" starts a fresh one.",
      "\"✍️ Sign & Lock\" is coming in a separate update -- once it ships, a signed report locks read-only. And if you don't see a Save button at all, your role is view-only for daily reports -- ask an admin if that's wrong."
    ] },

  // ---- Photos ----
  { id: "ph-add-finding", title: "How do I add a photo to a finding?", screens: ["edit"], roles: "all",
    keywords: "photo camera add capture finding caption",
    body: [
      "Open the finding's card in Roof Investigation Findings. Its own \"📷 Take Photo,\" \"+ Add Photos,\" and \"Import from CompanyCam\" buttons are right there.",
      "Capturing or importing a photo this way links it to that finding automatically -- you only need to type the caption.",
      "Every photo needs both a caption and a linked finding before you can save. If Save is blocked, the message tells you exactly which photo is missing what."
    ] },
  { id: "ph-gps-pin", title: "Why didn't my photo drop a pin on the map?", screens: ["edit"], roles: "all",
    keywords: "gps pin location missing photo map",
    body: [
      "📷 Take Photo (the in-app camera) grabs your device's GPS at the moment you shoot, if location access is available, and drops a pin automatically.",
      "+ Add Photos (picking from your library) never guesses a location -- an old or unrelated photo could be from anywhere.",
      "If location access was denied, timed out, or unavailable, the photo still saves fine -- there's just no pin. You can still place one by hand."
    ] },
  { id: "ph-move-pin", title: "How do I move a pin that's in the wrong spot?", screens: ["edit"], roles: "all",
    keywords: "move pin correct drag place map location",
    body: [
      "On the finding, the button now reads \"📍 Pinned — move.\" Tap it.",
      "Drag or tap the map to the correct spot, then Save. This updates immediately, including on any report already generated -- no need to resend a PDF.",
      "Phone GPS is usually only accurate to 10-30 feet, so treat any auto-dropped pin as a starting point to fine-tune, not a final placement."
    ] },
  { id: "ph-companycam-import", title: "How do I import photos from CompanyCam?", screens: ["edit"], roles: "all",
    keywords: "companycam import photo project",
    body: [
      "Tap \"Import from CompanyCam\" on the finding you want the photo linked to.",
      "Pick the project, then tap photos to select them (a running counter shows how many), then \"Import Selected.\"",
      "This also links the whole work order to that CompanyCam project, and can fill in Job Name/Location if they're still blank."
    ] },
  { id: "ph-reorder", title: "How do I reorder photos before sending the report?", screens: ["edit"], roles: "all",
    keywords: "reorder order photos print sequence",
    body: [
      "Scroll to Photo Documentation at the bottom of the form -- it shows every photo on the job in the order they'll print.",
      "Use ▲ / ▼ on each photo to move it up or down. This is the reliable way to reorder on a phone.",
      "On a desktop browser you can also drag a photo by its row, as a shortcut for the same thing."
    ] },

  // ---- RoofMapper ----
  { id: "rm-step-guide", title: "RoofMapper, start to finish (step-by-step)", screens: ["roofmapper"], roles: "all",
    keywords: "roofmapper guide steps how to full walkthrough directions start finish",
    body: [
      "1. Open 🗺️ RoofMapper. Tap \"📍 Use My Location\" if you're standing at the job, or type the address and tap 🔍 Search, or pull the job with \"🔍 Select Job.\"",
      "2. Tap the correct building's outline, then \"✏️ Generate Roof Outline.\" No outline shown? Tap \"🛰️ Satellite View\" then \"✏️ Trace Manually\" to tap the corners yourself, or \"🚶 Walk the Corners\" to record them by walking the roof edge.",
      "3. While tracing: tap the corners in order, all the way around (at least 3). Drag any numbered point to move it, tap a + between points to insert one, double-tap (or right-click) a point to delete it, \"↩️ Undo Last Point\" for the most recent. Leave \"🧲 Snap\" on so corners lock onto roofs already traced next door. Tap \"✓ Finish Outline\" when you're back at the start.",
      "4. Clean it up: \"🟦 Square Up\" snaps near-90° corners straight (a real diagonal is left alone). Then calibrate: tap any edge's length label on the map (like \"142 ft\") and type the tape-measured length -- the whole roof rescales to match. Trace → Square Up → Calibrate, in that order.",
      "5. Tap \"💾 Save Outline to Building\" and link it to an existing building or create a new one. Save before you leave the screen -- an unfinished trace does not survive a page refresh.",
      "6. From there: add permanent Roof Features (drains, RTUs), mark it up (arrows, notes, clouds, measurements), and \"👁️ Preview Export\" for the SVG/PNG/PDF. Finding and repair pins get placed from the work order, not here."
    ] },
  { id: "rm-trace-points", title: "How do I add, move, or delete a point while tracing?", screens: ["roofmapper"], roles: "all",
    keywords: "trace points vertex add move delete insert drag undo corner",
    body: [
      "While a trace is open, every point you've placed is a numbered dot: drag it to move it, double-tap or right-click it to delete it, and tap the small + between two dots to insert a new point on that edge.",
      "\"↩️ Undo Last Point\" removes the most recent one; \"✕ Cancel\" throws the whole trace away.",
      "After the outline is finished and saved, \"✏️ Edit Shape\" lets you drag corners to new spots -- moving only. To add or remove a corner on a finished roof, re-trace it.",
      "Moving a corner by hand resets Square Up and calibration, since a hand edit can change what those relied on."
    ] },
  { id: "rm-first-trace", title: "How do I map a roof for the first time?", screens: ["roofmapper"], roles: "all",
    keywords: "roofmapper trace new roof outline generate",
    body: [
      "Open the RoofMapper tab and tap \"📍 Use My Location,\" or type an address and tap Search.",
      "Tap the correct building's outline on the map, then tap \"✏️ Generate Roof Outline.\"",
      "No footprint shown for this building? Tap \"🛰️ Satellite View\" then \"✏️ Trace Manually\" to tap the corners by hand, or \"🚶 Walk the Corners\" to record them by walking the roof.",
      "Once you have an outline, tap \"💾 Save Outline to Building\" to link it to a building (existing or brand-new)."
    ] },
  { id: "rm-reopen-roof", title: "How do I reopen a roof I already traced?", screens: ["roofmapper", "history"], roles: "all",
    keywords: "reopen open saved roof map switch edit existing",
    body: [
      "This is not done from the RoofMapper tab itself yet -- it only starts new traces.",
      "Instead: tap 🏢 Building History → open the building → find the roof in the Roof Map card → tap \"🗺️ Open in RoofMapper.\"",
      "That's currently the only path back into a saved roof to keep editing it. If a building has just one roof, there's no dropdown to pick from -- the \"🗺️ Open in RoofMapper\" button sits right next to the roof's name.",
      "Opening a roof this way also reloads the building's saved drone ortho under it, if there is one -- which is why it's the right starting point before tracing another roof on that image."
    ] },
  { id: "rm-rename-roof", title: "How do I rename a roof?", screens: ["roofmapper", "history"], roles: "all",
    keywords: "rename roof label name change",
    body: [
      "From RoofMapper (once the roof is open/traced): tap the roof's name label directly on the map, or tap \"🏷️ Rename Roof\" next to Edit Shape.",
      "From Building History: tap \"✏️ Rename\" next to the roof picker.",
      "All three do the same thing -- use whichever you find first. If the new name is already used by another roof on that building, you'll be offered a ready-made alternative instead of two roofs with the same name."
    ] },
  { id: "rm-square-up", title: "What does Square Up do?", screens: ["roofmapper"], roles: "all",
    keywords: "square up corners 90 degrees snap edges",
    body: [
      "It snaps near-90° corners and near-straight edges of your traced outline clean, since most roofs are rectilinear.",
      "It only appears after you've generated an outline, in the Roof Outline panel.",
      "Use it right after tracing, before you calibrate a measurement -- a genuine diagonal cut or curved section is always left exactly as traced, never forced square. Not happy with it? \"↩️ Undo Square Up\" puts it back."
    ] },
  { id: "rm-calibrate", title: "How do I fix a roof's measurements (Calibrate)?", screens: ["roofmapper"], roles: "all",
    keywords: "calibrate measurement scale accurate edge length feet",
    body: [
      "On the map, tap any edge's floating length label (a small pill showing something like \"142 ft\").",
      "Enter the real, tape-measured length for that edge. The whole outline rescales proportionally off that one measurement -- every other edge, the area, and the perimeter all become accurate.",
      "Do this last -- after Edit Shape / Square Up -- so the edge you measure ends up exactly right.",
      "Once you calibrate one roof on a building, later roofs on that same building inherit the same scale automatically."
    ] },
  { id: "rm-edit-shape", title: "How do I move a corner that's not quite right?", screens: ["roofmapper"], roles: "all",
    keywords: "edit shape corner vertex drag move",
    body: [
      "Tap \"✏️ Edit Shape.\" A dot appears on every corner -- drag any one of them and the shape, area, and dimensions update live.",
      "Tap \"✓ Done Editing\" when it looks right.",
      "Moving a corner by hand resets Square Up and any prior calibration, since a hand edit can change the shape those relied on."
    ] },
  { id: "rm-features", title: "How do I add roof features like drains or HVAC units?", screens: ["roofmapper"], roles: "all",
    keywords: "roof features drains hvac vents scuppers permanent assets",
    body: [
      "Once your outline is saved, a \"Roof Features\" card appears below the map. Tap \"🔧 Add Feature.\"",
      "Drag the marker into position on the map (or tap the map to place it), pick a type, add an optional label/notes, then Save.",
      "Tap any existing feature's marker to edit or remove it. Double-tap a marker, or tap \"📋 Duplicate\" on it, to quickly place another of the same thing nearby (multiple RTUs, a run of fence, etc.)."
    ] },
  { id: "rm-markup", title: "How do I mark up a roof map with arrows, notes, or measurements?", screens: ["roofmapper"], roles: "all",
    keywords: "markup arrow text callout circle cloud measure count annotate",
    body: [
      "Once your outline is saved, a \"Markup\" card appears with seven tools: ↗️ Arrow, 💬 Text, ▭ Rectangle, ⭕ Circle, ☁️ Cloud, 📏 Measure, 🔢 Count.",
      "Tap a tool, then tap the map to place it. Most tools finish automatically after your last tap -- ☁️ Cloud is the one exception, since it needs at least 3 points: tap \"✓ Finish\" when you're done outlining it.",
      "Pick a color from the row of dots before placing -- it applies to the next markup you place, not to anything already on the map.",
      "Tap any markup on the map, or its entry in the list below, to delete it. Every markup remembers who added it and when."
    ] },
  { id: "rm-export", title: "How do I export or print a roof map?", screens: ["roofmapper"], roles: "all",
    keywords: "export svg png pdf print preview",
    body: [
      "Tap \"👁️ Preview Export\" to see exactly what you'll get -- the outline, edge measurements, every placed feature with its icon and name, a legend, and a scale bar.",
      "Export SVG, PNG, or PDF from inside the preview, or from the buttons below it any time.",
      "On a building with more than one roof, a checklist lets you export just one roof, several, or the whole building on one shared page."
    ] },
  { id: "rm-multi-roof", title: "This building has more than one roof -- how do I trace the second one?", screens: ["roofmapper"], roles: "all",
    keywords: "multiple roofs another building annex warehouse",
    body: [
      "In the Roof Features card, tap \"➕ Trace Another Roof\" (or use \"+ Add Roof\" from Building History).",
      "Already-traced roofs on this building show dimmed on the map so you can trace the new one accurately next to them -- tracing near an existing roof's edge snaps to it automatically, so there are no gaps or overlaps.",
      "Name the new roof, trace it, and save it the same way as the first."
    ] },
  { id: "rm-split", title: "I traced one big shape but it's really two roofs -- how do I split it?", screens: ["roofmapper"], roles: "all",
    keywords: "split roof sections divide separate",
    body: [
      "Before saving, tap \"✂️ Split Into Roof Sections,\" then tap two points on the outline's edge to draw a split line.",
      "Rename each section if you want, then tap \"💾 Save All N Sections as Roofs.\"",
      "If you're splitting an already-saved roof, the first section keeps that roof's existing history and features -- the rest start brand-new and blank, so double check nothing needs to move over by hand afterward."
    ] },
  { id: "rm-basemap-vs-ortho", title: "Base map vs. drone ortho -- what's the difference?", screens: ["roofmapper", "history"], roles: "all",
    keywords: "base map ortho orthomosaic drone image satellite roof plan sketch difference",
    body: [
      "The BASE MAP is the permanent roof drawing that follows the job everywhere -- it's what you see behind pins in Building History, on the work-order form, and in the daily report's section trace. Out of the box it's satellite imagery.",
      "A DRONE ORTHO is an optional upgrade to that base map: a georeferenced top-down drone image, far sharper than satellite. Because it's georeferenced (the app knows the exact GPS of its corners), pins and traced outlines sit on it as real GPS points.",
      "That's why replacing an old ortho with a new flight doesn't lose anything -- traces and pins are stored as GPS coordinates, not as marks on the picture, so they land in the right spot on the new image automatically.",
      "A roof plan or sketch can also be the base map -- but those aren't georeferenced, so their pins are tied to that exact image. The app will refuse to swap out a plan/sketch that already has pins or outlines tied to it."
    ] },
  { id: "rm-ortho-update", title: "How do I upload or update a drone ortho after a flight?", screens: ["history", "roofmapper"], roles: "admin",
    keywords: "upload update drone ortho orthomosaic geotiff bounds north south east west base map replace",
    body: [
      "1. On a computer, run tools/geotiff_to_webmap.py on the flight's GeoTIFF (from DJI Terra, DroneDeploy, Pix4D…). It shrinks the huge file to a web-sized JPG and prints the exact North / South / East / West numbers you'll paste into the app. (It can also upload directly -- ask for the --upload option -- and then there's nothing left to do in the app.)",
      "2. In the app: Building History → open the building → the \"Roof Base Map (admin)\" card. This card, not any of the photo buttons -- photos added elsewhere become report photos, not the base map.",
      "3. Set the type to \"Drone Orthomosaic — needs an extra step first, see below,\" paste the four North/South/East/West numbers from step 1, pick the JPG, and tap \"Upload Base Map.\" (The card also shows this building's ID with a Copy button, for the script.)",
      "4. Updating after a NEW flight is the exact same steps -- the new ortho replaces the old one in place. Traces and pins carry over automatically because they're stored as GPS, not drawn on the image.",
      "The building needs a linked CompanyCam project (the image is stored there). \"Clear Base Map\" puts the building back on satellite."
    ] },
  { id: "rm-ortho-reload", title: "Why isn't my drone image showing when I trace another roof?", screens: ["roofmapper", "history"], roles: "all",
    keywords: "ortho missing gone satellite trace another roof add roof reload drone image",
    body: [
      "\"➕ Trace Another Roof\" and \"+ Add Roof\" start a fresh trace on whatever's currently on the map -- they don't go fetch the building's saved drone ortho on their own.",
      "To trace on the ortho: Building History → open the building → \"🗺️ Open in RoofMapper\" on an existing roof (that's what loads the saved drone image) → THEN tap \"➕ Trace Another Roof.\" The ortho stays under your new trace.",
      "Cold-starting a trace from the RoofMapper tab or \"+ Add Roof\" shows plain satellite -- your trace still lands in the right place (it's all GPS), you just won't have the sharp drone picture to trace against."
    ] },
  { id: "rm-dont-refresh", title: "Will I lose my trace if the page refreshes?", screens: ["roofmapper"], roles: "all",
    keywords: "refresh reload lose trace unsaved fail safe saved device",
    body: [
      "An UNFINISHED trace (corners tapped, outline not finished) lives only on the screen -- a refresh, a closed tab, or a dead battery loses it. Finish and save before you put the phone away.",
      "A FINISHED outline whose save couldn't reach the server is protected: it's kept on your device, a red status bar tells you (\"your roof is saved on THIS DEVICE ✓\"), and the app retries automatically when you're back on signal.",
      "So the habit is: trace it, ✓ Finish Outline, 💾 save it -- then relax. Everything after that point can survive bad signal."
    ] },
  { id: "rm-own-drone-image", title: "What does \"📷 Trace on My Own Drone Image\" do?", screens: ["roofmapper"], roles: "all",
    keywords: "trace own drone image upload jpg png geotiff kmz kml flat canvas",
    body: [
      "It lets any tech trace a roof on top of their own image, right now, no admin needed. What you get depends on the file:",
      "A GeoTIFF or KMZ/KML keeps its real GPS -- every tap during the trace is a true location, and no calibration is needed.",
      "A plain JPG or PNG has no GPS at all, so it becomes a flat canvas: the SHAPE you trace is exact, but you must calibrate one edge (tap its length label, enter the tape measurement) to make the sizes real.",
      "This is different from the admin \"Roof Base Map\" card in Building History -- that one sets the permanent, georeferenced base map the whole building uses for pin placement. Use this button to get an outline traced; use the base-map card to make a drone ortho the job's permanent background."
    ] },

  // ---- Building History ----
  { id: "bh-near-me", title: "How do I find the closest building to where I'm standing?", screens: ["history"], roles: "all",
    keywords: "buildings near me gps closest nearby",
    body: [
      "In Building History, tap \"📍 Buildings Near Me\" at the top.",
      "It lists buildings nearest first, with distance to each. A very close match is highlighted, but you still tap to confirm -- nothing opens automatically.",
      "No GPS fix or nothing nearby? It just tells you so -- search for the building by name like normal instead."
    ] },
  { id: "bh-log-activity", title: "How do I log something that happened without filling out a full report?", screens: ["history"], roles: "all",
    keywords: "log activity note service call drone flight thermal scan",
    body: [
      "Open the building in Building History, then tap \"+ Log Activity\" in the Timeline card.",
      "Pick a type (Service Call, Leak Investigation, Repair, Roof Replacement, Warranty Inspection, Drone Flight, Thermal Scan, Moisture Survey, Customer Conversation, or Note/Other), fill in the date and a note, and save.",
      "It shows up in the timeline right away, alongside generated reports."
    ] },
  { id: "bh-recover-unlogged", title: "I saved a work order but it's not showing up on the building's timeline -- what do I do?", screens: ["history"], roles: "all",
    keywords: "recover unlogged missing report timeline backfill",
    body: [
      "A work order only gets a timeline entry once it's actually Downloaded, Emailed, or Shared -- saving alone doesn't create one.",
      "Open the building in Building History and tap \"🔄 Recover Unlogged Work Orders.\" It scans that building's recent saved work orders and backfills any that were saved but never sent, after confirming the count with you."
    ] },
  { id: "bh-filters", title: "How do I filter a building's history?", screens: ["history"], roles: "all",
    keywords: "filter timeline date technician warranty status report type",
    body: [
      "On the building's Timeline, use the filter row: date range, roof area, technician, warranty status, and report type.",
      "The dropdowns only ever list values that actually appear on that building's own timeline. Tap \"Clear Filters\" to reset."
    ] },
  { id: "bh-open-wo", title: "How do I open the work order behind a timeline entry?", screens: ["history"], roles: "all",
    keywords: "timeline open work order tap entry source badge",
    body: [
      "In a building's Timeline, entries created from a work order show a blue \"📂 Open work order ›\" badge -- tap anywhere on the entry and that work order opens, fully editable.",
      "Entries without the badge (manually logged activity, or history from before linking existed) have no work order behind them -- tapping just tells you so.",
      "Buttons inside an entry (View saved PDF, Delete) still do their own thing without opening the order."
    ] },
  { id: "bh-inline", title: "Why is there a Building History card on my work-order form?", screens: ["edit"], roles: "all",
    keywords: "inline building history card form prior events read only",
    body: [
      "Type a Job Name on a Leak, Inspection, or Work Order and a read-only Building History card appears right on the form -- the building's roof map with its existing pins, plus its most recent prior events (up to 8).",
      "It's there so you can see what's been done on this roof before, without leaving the form. Entries here are deliberately not tappable -- opening another order mid-edit would swap your work out from under you.",
      "On an Inspection, tick \"Hide existing pins\" to declutter the map while you place new ones.",
      "For the full, filterable history, tap 🏢 Building History in the header."
    ] },

  // ---- Sending reports ----
  { id: "send-report", title: "How do I send or share a report?", screens: ["preview"], roles: "all",
    keywords: "send email share download pdf report print copy text recipients",
    body: [
      "From Preview: \"Send Email Now\" emails the finished PDF directly from the app -- no mail app needed. Pick recipients from the \"Send to…\" dropdown or type any email (commas for several).",
      "\"Share / Email PDF\" hands the PDF to your device's share sheet instead; \"Download PDF\" saves it to the device. \"Email (text only),\" \"Copy Text,\" and \"Print\" are there too.",
      "All of these save the work order and generate the PDF automatically first -- you don't need to save separately.",
      "Every send, download, or share is logged on the building's timeline, and the PDF is uploaded to the linked CompanyCam project automatically."
    ] },
  { id: "send-all-reports", title: "Where can I see every report that's been generated?", screens: ["reports"], roles: "all",
    keywords: "all reports list history filter every report tab",
    body: [
      "Tap 📋 Reports -- every generated report across every building, most recent first, read-only.",
      "Filter by search (building or customer), date range, roof area, technician, warranty status, report type, or work-order type.",
      "Tap any report to jump straight to that building's timeline."
    ] },
  { id: "send-verify", title: "How do I tell if a report was actually emailed?", screens: ["saved", "history"], roles: "all",
    keywords: "emailed sent confirmation badge",
    body: [
      "After a successful Send Email Now, the work order's card in the 💾 Saved tab shows \"📧 Emailed [date/time]\" -- a quick way to check without digging into Building History.",
      "The full detail (exact recipients, subject) is also on that building's timeline and in the 📋 Reports tab."
    ] },

  // ---- Account & roles ----
  { id: "acct-roles", title: "Why can't I see some buttons other people have?", screens: ["home", "edit", "history", "saved", "reports", "roofmapper"], roles: "all",
    keywords: "role permission admin owner missing button hidden",
    body: [
      "RoofOps shows different controls depending on your role. Things like deleting a saved work order, unlinking a CompanyCam project, or managing users are owner/admin only -- they simply don't appear for anyone else, which is intentional, not a bug.",
      "If you need something you can't see or do, ask an owner or admin."
    ] },
  { id: "acct-feedback", title: "How do I send feedback about a problem or idea?", screens: ["home", "edit", "history", "saved", "reports", "roofmapper"], roles: "all",
    keywords: "feedback bug report suggestion feature request",
    body: [
      "Tap the 💬 button in the bottom-right corner, on any screen.",
      "Pick a type (👍 Works great, 🤔 Confusing, 🐞 Bug, 💡 Feature request -- picking a type is required), add a comment if you want, and optionally attach a screenshot.",
      "You don't need to explain where you were or what you were doing -- the app already knows and sends that along automatically."
    ] },
  { id: "acct-home-screen", title: "How do I add RoofOps to my phone's home screen?", screens: ["home"], roles: "all",
    keywords: "home screen install app icon iphone android",
    body: [
      "iPhone/iPad: open RoofOps in Safari (this only works in Safari), tap the Share button, scroll down, tap \"Add to Home Screen,\" then Add.",
      "Android: open RoofOps in Chrome, tap the three-dot menu, tap \"Install app\" or \"Add to Home screen.\"",
      "This makes it open like a real app, full screen, one tap from your home screen -- much faster than digging through browser tabs on a roof."
    ] },

  // ---- Admin / owner only ----
  { id: "admin-invite", title: "How do I invite a new user?", screens: ["home"], roles: "admin",
    keywords: "invite user add account create resend token expired disable",
    body: [
      "Tap 🔐 Account in the header, then \"Manage Users.\"",
      "Enter their email, an optional display name, and pick a role, then tap \"Invite User.\"",
      "They get a \"Set Your Password and Sign In\" email -- the link works for 7 days and exactly once. Nobody, including you, ever sees or types their password.",
      "Link expired or lost? Tap \"Resend invite\" on their row -- a fresh link arrives in seconds and the old one stops working. Rows also have Disable / Re-enable, and the owner can Delete an account."
    ] },
  { id: "admin-role", title: "How do I change someone's role?", screens: ["home"], roles: "admin",
    keywords: "change role reassign promote demote",
    body: [
      "🔐 Account → \"Manage Users.\" Find their row in the Existing Users table and pick a new role from the dropdown, then Save.",
      "You can't change your own role, and only the owner can grant or remove the admin role, or change the owner's own role."
    ] },
  { id: "admin-delete-archive", title: "How do I delete or archive a building?", screens: ["history"], roles: "admin",
    keywords: "delete archive building remove",
    body: [
      "In Building History's building list, admin-only \"Archive (admin)\" and \"Delete (admin)\" controls appear on each building.",
      "Archive is reversible (Unarchive puts it back and hides it from the normal list in the meantime). Delete removes the building and its report/history records, but leaves the underlying work orders themselves alone."
    ] },
  { id: "admin-basemap", title: "How do I set a custom roof base map (drone photo or sketch)?", screens: ["history"], roles: "admin",
    keywords: "base map drone orthomosaic sketch roof plan custom upload",
    body: [
      "Open the building in Building History -- the \"Roof Base Map (admin)\" card lets you upload a Roof Plan, Sketch, or Drone Orthomosaic to replace the default satellite view for pin placement, everywhere the building's map appears.",
      "Roof Plan and Sketch images are ready to use as-is. A Drone Orthomosaic needs one extra step first: run tools/geotiff_to_webmap.py on the flight's GeoTIFF to get the web-sized JPG and the North/South/East/West numbers -- the full walkthrough is under RoofMapper: \"How do I upload or update a drone ortho after a flight?\"",
      "This is separate from RoofMapper's \"📷 Trace on My Own Drone Image\" -- that's for tracing an outline and any tech can do it; this card sets the building's permanent background."
    ] },
  { id: "admin-logs", title: "How do I check the audit log or feedback backlog?", screens: ["reports"], roles: "admin",
    keywords: "audit log feedback backlog admin review append only before after",
    body: [
      "Open 📋 Reports -- two admin-only cards sit at the top: 🗣️ Feedback Backlog (every 💬 submission, filterable by type; each one is also emailed to Mark) and the 🔒 Audit Log.",
      "The Audit Log records every privileged or destructive action -- building deletes and archives, base-map changes, roof moves, role-permission changes -- with who did it, when, and before/after snapshots.",
      "It's append-only: nothing in it can be edited or deleted, not even by the owner."
    ] },
  { id: "admin-roles-editor", title: "How do I change what each role can do?", screens: ["home"], roles: "admin",
    keywords: "roles permissions grid matrix editor owner scope",
    body: [
      "On the 🔧 Admin tab, the \"🔑 Roles & Permissions\" card (owner only) is a grid: permissions down the side, roles across the top. Tick or untick a cell; some rows use a scope instead (Off / Own records / Project / On).",
      "The Owner column is locked (🔒) so you can never lock yourself out. Tap \"Save Changes\" -- changes apply immediately, and every save is recorded in the Audit Log.",
      "Changing the ADMIN role, or your own role's security-sensitive permissions, asks for an extra confirm first -- read it before tapping through."
    ] },
  { id: "admin-tools", title: "What are the maintenance tools on the Admin tab?", screens: ["home"], roles: "admin",
    keywords: "admin tools photo size migrate sync foundation thumbnails backfill inspection review queue",
    body: [
      "The 🔧 Admin tab's orange card holds the one-tap maintenance jobs: photo size (applies to every user), ☁️ Scan & Migrate Photos, 🔄 Sync Foundation Jobs Now (refreshes the 🔍 Select Job list), 🖼️ Scan & Backfill Thumbnails, and 🏢 Backfill Photos to CompanyCam.",
      "Inspection Reports (from the CCM Inspect email): \"🔄 Check for New Inspection Reports\" runs on demand -- it also auto-checks every 30 minutes -- and anything it can't match to a building lands in the \"📋 Review Queue\" to be matched by hand."
    ] }
];

/* ============================ State ============================ */
var HELP_SEEN_KEY = "roofops_walkthrough_seen_v1";
var helpState = { query: "" };

function helpEsc(s) {
  return typeof window.esc === "function" ? window.esc(s) : String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c];
  });
}
function helpIsAdmin() { return !!window.isAdmin; }
function helpCurrentScreen() { return window.currentViewName || "home"; }

/* ====================== Wrapping globals safely ======================
   We never edit core.js/history.js/roofmapper.js -- instead we wrap the one
   global function each needs, from out here, so this file is the only place
   that changes. showView() already exists and is called throughout the app;
   wrapping it lets Help react to screen changes without modifying it. */
function helpWrap(name, after) {
  var orig = window[name];
  if (typeof orig !== "function") return; // degrade quietly if not loaded yet
  window[name] = function () {
    var result = orig.apply(this, arguments);
    try { after.apply(null, arguments); } catch (e) { /* never let a help hook break the app */ }
    return result;
  };
}

/* ============================ FAB button ============================ */
function buildHelpFab() {
  var btn = document.createElement("button");
  btn.id = "help-fab";
  btn.title = "Help";
  btn.setAttribute("aria-label", "Help");
  btn.textContent = "❓";
  btn.style.cssText = "position:fixed;right:16px;bottom:130px;z-index:400;width:48px;height:48px;" +
    "border-radius:50%;background:#E8600A;color:#fff;border:none;font-size:22px;line-height:1;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;display:flex;align-items:center;" +
    "justify-content:center;padding:0";
  btn.onclick = function () { openHelpCenter(); };
  document.body.appendChild(btn);
}

/* ============================ Help modal ============================ */
function buildHelpModal() {
  var wrap = document.createElement("div");
  wrap.id = "help-modal";
  wrap.style.display = "none";
  wrap.className = "help-modal-overlay";
  wrap.onclick = function (e) { if (e.target === wrap) closeHelpCenter(); };
  wrap.innerHTML =
    '<div class="help-modal">' +
      '<div class="help-modal-head">' +
        '<b>Help Center</b>' +
        '<button class="btn help-close-btn" onclick="closeHelpCenter()">Close</button>' +
      '</div>' +
      '<div class="help-modal-body">' +
        '<input type="text" id="help-search" class="help-search" placeholder="Search — e.g. \'reopen a roof\', \'photo pin\', \'change order\'" oninput="helpOnSearch(this.value)">' +
        '<div id="help-quicklinks"></div>' +
        '<div id="help-article-list"></div>' +
        '<div id="help-article-detail" style="display:none"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
}

function openHelpCenter() {
  var m = document.getElementById("help-modal");
  if (!m) return;
  m.style.display = "";
  document.getElementById("help-article-detail").style.display = "none";
  document.getElementById("help-article-list").style.display = "";
  helpState.query = "";
  var box = document.getElementById("help-search");
  if (box) box.value = "";
  renderHelpQuickLinks();
  renderHelpArticleList();
}
function closeHelpCenter() {
  var m = document.getElementById("help-modal");
  if (m) m.style.display = "none";
}
window.openHelpCenter = openHelpCenter;
window.closeHelpCenter = closeHelpCenter;

function helpVisibleArticles() {
  var admin = helpIsAdmin();
  return HELP_ARTICLES.filter(function (a) { return a.roles === "all" || (a.roles === "admin" && admin); });
}

function helpOnSearch(v) {
  helpState.query = v || "";
  renderHelpArticleList();
}
window.helpOnSearch = helpOnSearch;

// Role-aware quick links: the client only distinguishes admin vs. everyone
// else in what's actually SHOWN in the app (see the AUTH_DESIGN.md "Known UI
// scoping gap" note), so this doesn't hide anything by finer role -- it just
// surfaces a few likely-relevant articles first based on currentAuthClaims.role,
// a real signal even though the rest of the UI can't act on it yet.
var HELP_ROLE_QUICKLINKS = {
  field_tech: ["gs-new-wo", "dpr-start", "ph-add-finding", "bh-near-me"],
  superintendent: ["dpr-start", "dpr-lift-checklist", "rm-reopen-roof", "bh-log-activity"],
  ops_manager: ["bh-recover-unlogged", "admin-delete-archive", "send-verify"],
  project_manager: ["wo-co", "wo-co-signature", "admin-basemap"],
  billing: ["send-verify", "send-report"],
  service_manager: ["bh-recover-unlogged", "admin-logs"]
};
function renderHelpQuickLinks() {
  var host = document.getElementById("help-quicklinks");
  if (!host) return;
  var screen = helpCurrentScreen();
  var onScreen = helpVisibleArticles().filter(function (a) { return a.screens.indexOf(screen) !== -1; }).slice(0, 4);
  var role = window.currentAuthClaims && window.currentAuthClaims.role;
  var roleIds = (role && HELP_ROLE_QUICKLINKS[role]) || [];
  var roleArticles = helpVisibleArticles().filter(function (a) { return roleIds.indexOf(a.id) !== -1; });
  var html = "";
  if (onScreen.length) {
    html += '<div class="help-quicklinks-row"><span class="help-quicklinks-label">Help for this screen:</span>' +
      onScreen.map(function (a) { return '<button class="btn help-chip" onclick="openHelpArticle(\'' + a.id + '\')">' + helpEsc(a.title) + "</button>"; }).join("") +
      "</div>";
  }
  if (roleArticles.length) {
    html += '<div class="help-quicklinks-row"><span class="help-quicklinks-label">Popular for your role:</span>' +
      roleArticles.map(function (a) { return '<button class="btn help-chip" onclick="openHelpArticle(\'' + a.id + '\')">' + helpEsc(a.title) + "</button>"; }).join("") +
      "</div>";
  }
  host.innerHTML = html;
}

var HELP_SECTION_ORDER = [
  { key: "gs", label: "Getting Started" },
  { key: "wo", label: "Work Orders" },
  { key: "dpr", label: "Daily Progress Report" },
  { key: "ph", label: "Photos" },
  { key: "rm", label: "RoofMapper" },
  { key: "bh", label: "Building History" },
  { key: "send", label: "Sending Reports" },
  { key: "acct", label: "Account & Help" },
  { key: "admin", label: "Admin & Owner" }
];
function renderHelpArticleList() {
  var host = document.getElementById("help-article-list");
  if (!host) return;
  var q = helpState.query.trim().toLowerCase();
  var list = helpVisibleArticles().filter(function (a) {
    if (!q) return true;
    var hay = (a.title + " " + a.keywords + " " + a.body.join(" ")).toLowerCase();
    return hay.indexOf(q) !== -1;
  });
  if (!list.length) {
    host.innerHTML = '<p class="hint">No help articles match "' + helpEsc(helpState.query) + '". Try a different word, or tap 💬 Send Feedback to ask directly.</p>';
    return;
  }
  var html = "";
  HELP_SECTION_ORDER.forEach(function (section) {
    var items = list.filter(function (a) { return a.id.indexOf(section.key + "-") === 0; });
    if (!items.length) return;
    html += '<h3 class="help-section-title">' + helpEsc(section.label) + "</h3>";
    items.forEach(function (a) {
      html += '<button class="help-article-row" onclick="openHelpArticle(\'' + a.id + '\')">' + helpEsc(a.title) + " ›</button>";
    });
  });
  host.innerHTML = html;
}

function openHelpArticle(id) {
  var a = HELP_ARTICLES.filter(function (x) { return x.id === id; })[0];
  if (!a) return;
  document.getElementById("help-article-list").style.display = "none";
  document.getElementById("help-quicklinks").style.display = "none";
  var detail = document.getElementById("help-article-detail");
  detail.style.display = "";
  detail.innerHTML =
    '<button class="btn" onclick="helpBackToList()">‹ Back</button>' +
    "<h3 class=\"help-article-title\">" + helpEsc(a.title) + "</h3>" +
    a.body.map(function (p) { return "<p class=\"help-article-p\">" + helpEsc(p) + "</p>"; }).join("");
}
window.openHelpArticle = openHelpArticle;
function helpBackToList() {
  document.getElementById("help-article-detail").style.display = "none";
  document.getElementById("help-quicklinks").style.display = "";
  document.getElementById("help-article-list").style.display = "";
}
window.helpBackToList = helpBackToList;

/* ====================== Tap-to-reveal tooltips ======================
   Only on genuinely non-obvious controls, never hover-triggered (tap-to-
   reveal only -- half the crew is on phones). Two flavors here:
   (1) controls with a stable, static DOM id in index.html (Square Up, Edit
   Shape, the snapping toggle) get a badge injected once, directly; (2) the
   Building History roof selector and its Archive/Delete controls are built
   as HTML strings entirely inside js/history.js/js/workorders.js -- rather
   than editing those files, injectHistoryTooltips() below watches the two
   static containers they already render into with a MutationObserver and
   attaches the same badge once their content appears, so this stays
   isolated to help.js either way. "The change-order stages" tooltip wasn't
   built because the 5-stage change-order workflow (Draft/Requested/Pricing
   Approved/Report Approved/Sent) has no client UI at all yet -- only one
   server-side gate (approve_pricing) exists, with nothing on screen to
   attach a tooltip to; flagged back to Mark rather than tooltipping
   something invisible. */
var HELP_TOOLTIPS = [
  { id: "rm-edit-shape-btn", text: "Edit Shape — drag any corner to move it. Tap \"Done Editing\" when it looks right. Resets Square Up and calibration, since a hand edit can change what those relied on." },
  { id: "rm-square-up-btn", text: "Square Up — snaps near-90° corners and straight edges clean. Use it right after tracing, before you calibrate a measurement. A real diagonal or curve is left as traced." },
  { id: "rm-snap-toggle-wrap", text: "Snap to existing corners/edges — while tracing, taps near an already-mapped roof's edge lock onto it exactly, so adjoining roofs share the same boundary with no gaps. Turn off for a genuinely free point." },
  // Sweep of the remaining non-obvious RoofMapper action buttons (all have
  // stable ids in index.html). Same tap-to-reveal badge as above -- no
  // index.html edits, so this stays clear of the DPR markup other sessions
  // are actively rewriting tonight (PRs #136/#141).
  { id: "rm-ortho-upload-btn", text: "Trace on Your Own Drone Image — upload a GeoTIFF or KMZ (keeps real GPS, no calibrating) or a plain photo (a flat canvas: trace the shape, then calibrate one edge for real sizes). Any tech, no admin. This is for tracing an outline — the admin \"Roof Base Map\" card in Building History is what sets a building's permanent background." },
  { id: "rm-baselayer-btn", text: "Satellite View — flips the map between the street map and satellite imagery. Switch to satellite to see the actual roof when you're tracing corners by hand." },
  { id: "rm-trace-btn", text: "Trace Manually — draw the outline by tapping the roof's corners on the map yourself. Use it when no footprint auto-generates, or the one that does is the wrong shape." },
  { id: "rm-walk-btn", text: "Walk the Corners — walk the roof's edge and tap \"Record This Corner\" at each corner; your phone's GPS drops the point. Best where satellite imagery is too blurry to trace against." },
  { id: "rm-generate-btn", text: "Generate Roof Outline — draws the outline automatically from the building footprint you tapped. Wrong shape, or nothing appears? Use Trace Manually or Walk the Corners instead." },
  { id: "rm-align-btn", text: "Move/Rotate/Scale Outline — grab the whole outline and shift, turn, or resize it as one piece. The fast fix when an entire trace is off (a satellite trace vs. a sharper drone ortho). Fine-tune single corners afterward with Edit Shape." },
  { id: "rm-resnap-btn", text: "Re-Snap to Neighbors — snaps this roof's corners onto an adjoining roof already traced next door, closing sliver gaps or overlaps. For roofs traced before corner-snapping existed." },
  { id: "rm-split-btn", text: "Split Into Roof Sections — cut one traced shape into separate roofs (a warehouse plus its office annex, say). Tap two points on the edge to draw the cut, then save each piece as its own roof." }
];
function injectHelpTooltips() {
  HELP_TOOLTIPS.forEach(function (t) {
    var target = document.getElementById(t.id);
    if (!target || target.dataset.helpTipAdded) return;
    target.dataset.helpTipAdded = "1";
    var badge = document.createElement("button");
    badge.type = "button";
    badge.className = "help-tip-badge";
    badge.textContent = "ⓘ";
    badge.setAttribute("aria-label", "What does this do?");
    badge.onclick = function (e) {
      e.preventDefault(); e.stopPropagation();
      helpToggleTipBubble(badge, t.text);
    };
    target.parentNode.insertBefore(badge, target.nextSibling);
  });
  // Calibrate has no button at all (it's a tap on a map edge label drawn by
  // Leaflet, not a DOM element) -- a one-time contextual hint line does the
  // same "what does this do, tap-to-reveal" job without needing a live DOM
  // anchor inside roofmapper.js's canvas.
  var outlinePanel = document.getElementById("rm-outline-panel");
  if (outlinePanel && !outlinePanel.dataset.helpCalibrateHint) {
    outlinePanel.dataset.helpCalibrateHint = "1";
    var hint = document.createElement("p");
    hint.className = "hint help-calibrate-hint";
    hint.innerHTML = "ⓘ <b>Calibrate:</b> tap any edge's length label on the map (e.g. \"142 ft\") and enter the real measured length — the whole outline rescales off that one edge.";
    outlinePanel.insertBefore(hint, outlinePanel.firstChild.nextSibling);
  }
}
function helpToggleTipBubble(anchor, text) {
  var existing = document.getElementById("help-tip-bubble");
  if (existing) { existing.remove(); if (existing.dataset.for === anchor) return; }
  var bubble = document.createElement("div");
  bubble.id = "help-tip-bubble";
  bubble.className = "help-tip-bubble";
  bubble.textContent = text;
  document.body.appendChild(bubble);
  var r = anchor.getBoundingClientRect();
  var top = r.bottom + window.scrollY + 6;
  var left = Math.max(8, Math.min(r.left + window.scrollX, window.innerWidth - 260));
  bubble.style.top = top + "px";
  bubble.style.left = left + "px";
  setTimeout(function () {
    document.addEventListener("click", function dismiss(e) {
      if (e.target === anchor) return;
      var b = document.getElementById("help-tip-bubble");
      if (b) b.remove();
      document.removeEventListener("click", dismiss);
    });
  }, 0);
}

/* ========================= First-run walkthrough =========================
   Shown once, after the login gate (if any) has cleared and someone is
   actually signed in -- no point showing it behind #login-gate. Polls
   rather than hooking a specific auth callback, since onAuthStateChanged is
   wired inside core.js and this file deliberately never edits that. */
var HELP_WALKTHROUGH_STEPS = [
  { title: "Welcome to RoofOps", body: "A few quick things before your first job. Tap Next — this takes about 20 seconds, and you can skip it any time." },
  { title: "Start a work order", body: "From Home, tap the tile for the type of work you're doing (Leak Work Order, Change Order, Inspection, Work Order, Warranty). ➕ New in the header always brings you back here." },
  { title: "Reopen a saved job", body: "Tap 💾 Saved in the header any time to find and reopen a work order you already started — nothing is ever locked once saved." },
  { title: "Log your day", body: "📅 Daily Report is the daily progress report — one per job per day, shared by every crew on it. Job info fills itself from 🔍 Select Job; crew hours can pull from the time clock." },
  { title: "Map a roof", body: "The 🗺️ RoofMapper tab traces a roof outline and lets you drop pins, add features, and mark it up. To reopen a roof you already traced, go through 🏢 Building History instead." },
  { title: "Get help any time", body: "Tap the ❓ button (bottom-right, every screen) for searchable how-tos, or 💬 to send feedback straight to Mark. You won't see this walkthrough again — find it later from ❓ Help." }
];
var helpWalkthroughIdx = 0;
function helpMaybeShowWalkthrough() {
  if (localStorage.getItem(HELP_SEEN_KEY)) return false;
  var gate = document.getElementById("login-gate");
  var gateVisible = gate && gate.style.display !== "none" && window.getComputedStyle(gate).display !== "none";
  if (gateVisible) return false;
  if (window.fauth && !window.currentAuthClaims) return false; // auth exists but nobody's signed in yet
  showHelpWalkthrough();
  return true;
}
function showHelpWalkthrough() {
  localStorage.setItem(HELP_SEEN_KEY, "1");
  helpWalkthroughIdx = 0;
  var wrap = document.createElement("div");
  wrap.id = "help-walkthrough";
  wrap.className = "help-modal-overlay";
  document.body.appendChild(wrap);
  renderHelpWalkthroughStep();
}
function renderHelpWalkthroughStep() {
  var wrap = document.getElementById("help-walkthrough");
  if (!wrap) return;
  var step = HELP_WALKTHROUGH_STEPS[helpWalkthroughIdx];
  var last = helpWalkthroughIdx === HELP_WALKTHROUGH_STEPS.length - 1;
  wrap.innerHTML =
    '<div class="help-walkthrough-card">' +
      '<div class="help-walkthrough-dots">' +
        HELP_WALKTHROUGH_STEPS.map(function (s, i) { return '<span class="help-wt-dot' + (i === helpWalkthroughIdx ? " active" : "") + '"></span>'; }).join("") +
      "</div>" +
      "<h3>" + helpEsc(step.title) + "</h3>" +
      "<p>" + helpEsc(step.body) + "</p>" +
      '<div class="help-walkthrough-actions">' +
        '<button class="btn" onclick="helpSkipWalkthrough()">Skip</button>' +
        '<button class="btn primary" onclick="helpWalkthroughNext()">' + (last ? "Done" : "Next") + "</button>" +
      "</div>" +
    "</div>";
}
function helpWalkthroughNext() {
  if (helpWalkthroughIdx >= HELP_WALKTHROUGH_STEPS.length - 1) { helpSkipWalkthrough(); return; }
  helpWalkthroughIdx++;
  renderHelpWalkthroughStep();
}
function helpSkipWalkthrough() {
  var wrap = document.getElementById("help-walkthrough");
  if (wrap) wrap.remove();
}
window.helpWalkthroughNext = helpWalkthroughNext;
window.helpSkipWalkthrough = helpSkipWalkthrough;

/* ================= Tooltips on dynamically-rendered content =================
   The Building History roof selector and its Archive/Delete controls are
   built as HTML strings entirely inside js/history.js and js/workorders.js
   (not this session's files) -- rather than editing those, watch the two
   static containers those modules already render into (#history-list,
   #history-detail, both real elements in index.html) with a MutationObserver
   and inject the same tap-to-reveal badge style used above once their
   content appears. Debounced since a single render can touch the DOM many
   times in one pass (Firestore data arriving in several awaited steps). */
function injectHistoryTooltips() {
  var detail = document.getElementById("history-detail");
  if (detail && !detail.dataset.helpObserved) {
    detail.dataset.helpObserved = "1";
    var debounce1;
    new MutationObserver(function () {
      clearTimeout(debounce1);
      debounce1 = setTimeout(function () {
        var sel = detail.querySelector('select[onchange*="historySelectRoof"]');
        if (sel && !sel.dataset.helpTipAdded) {
          sel.dataset.helpTipAdded = "1";
          var badge = document.createElement("button");
          badge.type = "button"; badge.className = "help-tip-badge"; badge.textContent = "ⓘ";
          badge.setAttribute("aria-label", "What is this?");
          badge.onclick = function (e) { e.preventDefault(); e.stopPropagation();
            helpToggleTipBubble(badge, "Roof selector — switches which roof on this building the Timeline, Roof Map, and profile below are showing. Only appears once a building has more than one roof."); };
          sel.parentNode.appendChild(badge);
        }
      }, 150);
    }).observe(detail, { childList: true, subtree: true });
  }
  var list = document.getElementById("history-list");
  if (list && !list.dataset.helpObserved) {
    list.dataset.helpObserved = "1";
    var debounce2;
    new MutationObserver(function () {
      clearTimeout(debounce2);
      debounce2 = setTimeout(function () {
        var archiveBtn = list.querySelector('[onclick*="archiveBuildingAdmin"], [onclick*="unarchiveBuildingAdmin"]');
        if (archiveBtn && !archiveBtn.dataset.helpTipAdded) {
          archiveBtn.dataset.helpTipAdded = "1";
          var badge = document.createElement("button");
          badge.type = "button"; badge.className = "help-tip-badge"; badge.textContent = "ⓘ";
          badge.setAttribute("aria-label", "Archive vs. Delete");
          badge.onclick = function (e) { e.preventDefault(); e.stopPropagation();
            helpToggleTipBubble(badge, "Archive — hides a building from the normal list; reversible any time with Unarchive. Delete — removes the building and its report/history records for good (the underlying work orders themselves are left alone). Archive first if you're not sure."); };
          archiveBtn.parentNode.insertBefore(badge, archiveBtn);
        }
      }, 150);
    }).observe(list, { childList: true, subtree: true });
  }
}

/* ============================ Init ============================ */
function helpInit() {
  buildHelpFab();
  buildHelpModal();
  helpWrap("showView", function () { injectHelpTooltips(); injectHistoryTooltips(); renderHelpQuickLinks(); helpMaybeShowWalkthrough(); });
  injectHelpTooltips();
  injectHistoryTooltips();

  // Auto-open Help from the invite email's "Open the Help Center" link
  // (?openHelp=1), so a brand-new user lands straight in it after signing in.
  if (/[?&]openHelp=1/.test(window.location.search)) {
    setTimeout(function () { if (!document.getElementById("login-gate") || document.getElementById("login-gate").style.display === "none") openHelpCenter(); }, 800);
  }

  // Fallback poll for the walkthrough in case showView() never fires again
  // after sign-in (e.g. the app was already on "home" before login cleared).
  var tries = 0;
  var poll = setInterval(function () {
    tries++;
    if (helpMaybeShowWalkthrough() || tries > 40) clearInterval(poll); // ~40 * 1.5s = 60s ceiling
  }, 1500);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", helpInit);
else helpInit();
