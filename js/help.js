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
  { id: "gs-existing-building", title: "How do I fill in a job faster for a building I've already worked on?", screens: ["home", "edit"], roles: "all",
    keywords: "existing building customer duplicate autofill select",
    body: [
      "At the top of Job Information, tap \"🔍 Select Existing Building.\"",
      "Search for the building -- its Job Name, Bill To, Location, and Roof System fill in automatically.",
      "A \"☁️ From CompanyCam\" section in the same picker also shows CompanyCam projects that aren't a RoofOps building yet -- picking one creates the building and links CompanyCam for you in one step.",
      "This also helps avoid accidentally creating a duplicate building from a slightly different spelling of the same job name."
    ] },
  { id: "gs-reopen-wo", title: "How do I reopen a work order I already saved?", screens: ["home", "saved"], roles: "all",
    keywords: "reopen open saved work order find",
    body: [
      "Tap 💾 Saved in the header.",
      "Find it in the list and tap Open -- it's fully editable, same as when you first filled it out.",
      "Everyone can open and edit any saved work order. Only an admin can delete one."
    ] },

  // ---- Work order types ----
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
      "Rate each Good / Fair / Poor / Critical / N/A. A photo on any item is camera-only (no library/CompanyCam import) since it's documenting the exact condition you're rating.",
      "Taking that photo automatically drops a pin on the roof map. Rating something Fair, Poor, or Critical automatically adds it to Findings too -- you never write it twice.",
      "If the building has more than one roof, a checklist appears near the top asking which roof(s) this inspection covers."
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
      "That's currently the only path back into a saved roof to keep editing it. If a building has just one roof, there's no dropdown to pick from -- the \"🗺️ Open in RoofMapper\" button sits right next to the roof's name."
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

  // ---- Sending reports ----
  { id: "send-report", title: "How do I send or share a report?", screens: ["preview"], roles: "all",
    keywords: "send email share download pdf report",
    body: [
      "From Preview, use Send Email Now, Share / Email PDF, or Download PDF. All three save the work order and generate the PDF automatically first -- you don't need to save separately.",
      "If the work order is linked to a CompanyCam project, the PDF is also uploaded there automatically."
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
    keywords: "invite user add account create",
    body: [
      "Tap 🔐 Account in the header, then \"Manage Users.\"",
      "Enter their email, an optional display name, and pick a role, then tap \"Invite User.\"",
      "They get an email with a link to set their own password -- nobody, including you, ever sees or types their password."
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
    keywords: "base map drone orthomosaic sketch roof plan custom",
    body: [
      "Open the building in Building History -- the \"Roof Base Map (admin)\" card lets you upload a roof plan, sketch, or drone orthomosaic instead of the default satellite view for pin placement.",
      "A drone orthomosaic needs the companion script (tools/geotiff_to_webmap.py) run first to get exact corner coordinates.",
      "This is separate from RoofMapper's own drone-image tracing (📷 Trace on My Own Drone Image) -- that's for tracing an outline, any tech can do it, and RoofMapper's live map always shows satellite/street imagery regardless of what base map is set here."
    ] },
  { id: "admin-logs", title: "How do I check the audit log or feedback backlog?", screens: ["reports"], roles: "admin",
    keywords: "audit log feedback backlog admin review",
    body: [
      "Open 📋 Reports -- two admin-only cards sit at the top: Feedback Backlog (every 💬 submission, filterable by type) and Audit Log (every privileged/destructive action, who did it, and when)."
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
  field_tech: ["gs-new-wo", "ph-add-finding", "rm-reopen-roof", "bh-near-me"],
  superintendent: ["rm-reopen-roof", "rm-multi-roof", "bh-log-activity", "wo-inspection"],
  ops_manager: ["bh-recover-unlogged", "admin-delete-archive", "send-verify"],
  project_manager: ["wo-co", "wo-co-signature", "admin-basemap"],
  estimator: ["wo-co", "wo-inspection", "rm-export"],
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
  { id: "rm-snap-toggle-wrap", text: "Snap to existing corners/edges — while tracing, taps near an already-mapped roof's edge lock onto it exactly, so adjoining roofs share the same boundary with no gaps. Turn off for a genuinely free point." }
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
