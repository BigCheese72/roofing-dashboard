/* ================= Roles & Permissions editor (Admin page) =================
   Owner-only matrix editor for the LIVE roles/{roleId} permission grids --
   PERMISSION_KEYS down the rows (grouped, human labels), roles across the
   columns, a checkbox per cell (or a scope dropdown for keys that accept
   "proj"/"own"/"billing" values -- see PERMISSION_SCOPES in
   netlify/functions/lib/permissions.js).

   Client-side visibility (the card shows only for claims.owner) is
   convenience only, same rule as everywhere else in this app -- the real
   gate is server-side: list_roles/set_role_permissions in
   netlify/functions/admin.js both requirePermission("settings.security"),
   which the seed grid grants to the owner ONLY.

   The row list and the scope options are rendered from what the SERVER
   returns (permissionKeys/permissionScopes off the same
   lib/permissions.js the validator enforces) -- the label table below is a
   DISPLAY mirror only, never authoritative. A key the server knows but this
   mirror doesn't yet gets rendered with its raw key name under "Other"
   instead of being hidden, so a new permission can never silently vanish
   from the editor. (tests/rolesAdminClientMirror.test.js keeps the mirror
   complete anyway.)

   First real section of the consolidated Admin page (see "Admin page" in
   DEV_NOTES.md) -- deliberately self-contained in this file so later admin
   sections can follow the same pattern. Creating/deleting roles and
   assigning users to roles stay in User Management (Account modal); this
   page edits what each existing role CAN DO, v1 scope per Mark. */

/* Display labels + grouping for every permission key. Groups render in
   this order; keys render in registry (PERMISSION_KEYS) order within
   their group. */
var ROLES_ADMIN_GROUPS = [
  "Buildings", "Work Orders", "Capture & Attachments", "Change Orders",
  "Docs & Reports", "Billing", "Integrations", "Audit & Settings", "Users", "Other"
];
var ROLES_ADMIN_PERM_LABELS = {
  "buildings.view.full":        { group: "Buildings", label: "View buildings (full detail)" },
  "buildings.view.billing":     { group: "Buildings", label: "View buildings (billing info only)" },
  "buildings.archive":          { group: "Buildings", label: "Archive buildings" },
  "buildings.void":             { group: "Buildings", label: "Void buildings" },
  "buildings.restore":          { group: "Buildings", label: "Restore archived/voided buildings" },
  "buildings.purge":            { group: "Buildings", label: "Permanently delete buildings (purge)" },
  "workorder.view.own":         { group: "Work Orders", label: "View own work orders" },
  "workorder.view.all":         { group: "Work Orders", label: "View all work orders" },
  "workorder.create":           { group: "Work Orders", label: "Create work orders" },
  "workorder.edit":             { group: "Work Orders", label: "Edit work orders" },
  "internal.notes.view":        { group: "Work Orders", label: "View internal notes" },
  "internal.notes.edit":        { group: "Work Orders", label: "Edit internal notes" },
  "capture.photos":             { group: "Capture & Attachments", label: "Capture photos" },
  "capture.roofmap":            { group: "Capture & Attachments", label: "Capture roof maps (RoofMapper)" },
  "capture.dimensions":         { group: "Capture & Attachments", label: "Capture dimensions" },
  "capture.signature":          { group: "Capture & Attachments", label: "Capture signatures" },
  "attachments.archive":        { group: "Capture & Attachments", label: "Archive attachments" },
  "attachments.supersede":      { group: "Capture & Attachments", label: "Supersede attachments" },
  "attachments.purge":          { group: "Capture & Attachments", label: "Permanently delete attachments (purge)" },
  "changeorder.draft":          { group: "Change Orders", label: "Draft change orders" },
  "changeorder.approve_pricing":{ group: "Change Orders", label: "Approve change-order pricing" },
  "changeorder.approve_report": { group: "Change Orders", label: "Approve change-order report stage" },
  "doc.generate":               { group: "Docs & Reports", label: "Generate documents/reports" },
  "doc.email_customer":         { group: "Docs & Reports", label: "Email documents to customer" },
  "dpr.create":                 { group: "Docs & Reports", label: "Create daily progress reports" },
  "dpr.view":                   { group: "Docs & Reports", label: "View daily progress reports" },
  "warranty.manage_reports":    { group: "Docs & Reports", label: "Manage warranty/inspection reports" },
  "billing.view":               { group: "Billing", label: "View billing" },
  "billing.edit":               { group: "Billing", label: "Edit billing" },
  "companycam.link":            { group: "Integrations", label: "Link CompanyCam projects" },
  "foundation.read":            { group: "Integrations", label: "Read Foundation accounting data" },
  "audit.view":                 { group: "Audit & Settings", label: "View audit log" },
  "settings.company":           { group: "Audit & Settings", label: "Manage company settings" },
  "settings.security":          { group: "Audit & Settings", label: "Manage security settings (incl. this page)" },
  "users.manage_nonadmin":      { group: "Users", label: "Manage non-admin users" },
  "users.manage_admin":         { group: "Users", label: "Manage admin users" },
  "users.transfer_owner":       { group: "Users", label: "Transfer ownership" },
  "feedback.submit":            { group: "Other", label: "Submit in-app feedback" }
};
var ROLES_ADMIN_SCOPE_LABELS = { "proj": "Project", "own": "Own records", "billing": "Billing" };

/* Losing any of these from your OWN role locks you out of managing users
   or this very page -- saveRolesAdmin() warns before letting that happen.
   (Owner-claims users are immune: the owner role is server-locked to all
   permissions and caller.owner bypasses the grid entirely.) */
var ROLES_ADMIN_LOCKOUT_KEYS = ["settings.security", "users.manage_admin", "users.manage_nonadmin"];

var rolesAdminState = null; /* { roles, permissionKeys, permissionScopes, working: {roleId: grid} } */

function rolesAdminIsOwner(){
  return !!(typeof currentAuthClaims !== "undefined" && currentAuthClaims && currentAuthClaims.owner === true);
}

/* Called from showView("admin") (typeof-guarded there, like dprOnShow). */
function rolesAdminOnShow(){
  if (!rolesAdminIsOwner()) return;
  loadRolesAdmin();
}

async function loadRolesAdmin(){
  var host = document.getElementById("roles-admin-body");
  if (!host) return;
  host.innerHTML = '<p class="hint">Loading roles…</p>';
  try{
    var out = await callAdminApi({ action: "list_roles" });
    var working = {};
    (out.roles || []).forEach(function(r){
      var grid = {};
      (out.permissionKeys || []).forEach(function(k){
        var v = r.permissions ? r.permissions[k] : undefined;
        grid[k] = v === undefined ? false : v;
      });
      working[r.id] = grid;
    });
    rolesAdminState = {
      roles: out.roles || [],
      permissionKeys: out.permissionKeys || [],
      permissionScopes: out.permissionScopes || {},
      /* working = the edited copy; original stays on roles[].permissions
         so dirty detection is a straight compare. */
      working: working
    };
    renderRolesAdmin();
  }catch(e){
    host.innerHTML = '<p class="hint">Couldn\'t load roles: ' + esc(e.message) + '</p>';
  }
}

function rolesAdminDirtyRoleIds(){
  if (!rolesAdminState) return [];
  return rolesAdminState.roles.filter(function(r){
    if (r.id === "owner") return false;
    var orig = r.permissions || {};
    return rolesAdminState.permissionKeys.some(function(k){
      var before = orig[k] === undefined ? false : orig[k];
      return before !== rolesAdminState.working[r.id][k];
    });
  }).map(function(r){ return r.id; });
}

function renderRolesAdmin(){
  var host = document.getElementById("roles-admin-body");
  if (!host || !rolesAdminState) return;
  var st = rolesAdminState;

  /* Group the registry keys for display. A key the label mirror doesn't
     know yet still renders (raw key, "Other" group) -- never hidden. */
  var byGroup = {};
  st.permissionKeys.forEach(function(k){
    var meta = ROLES_ADMIN_PERM_LABELS[k] || { group: "Other", label: k };
    (byGroup[meta.group] = byGroup[meta.group] || []).push({ key: k, label: meta.label });
  });

  var roleCols = st.roles; /* already rank-sorted by the server */
  var head = '<tr><th style="text-align:left;padding:6px 8px;position:sticky;left:0;background:#fff;z-index:1">Permission</th>' +
    roleCols.map(function(r){
      var locked = r.id === "owner" ? ' 🔒' : '';
      return '<th style="padding:6px 6px;text-align:center;white-space:nowrap" title="' + esc(r.description || "") + '">' +
        esc(r.label || r.id) + locked + '</th>';
    }).join("") + '</tr>';

  var rows = "";
  ROLES_ADMIN_GROUPS.forEach(function(g){
    var keys = byGroup[g];
    if (!keys || !keys.length) return;
    rows += '<tr><td colspan="' + (roleCols.length + 1) +
      '" style="padding:10px 8px 4px;font-weight:bold;background:#F4F6F8;position:sticky;left:0">' + esc(g) + '</td></tr>';
    keys.forEach(function(kk){
      rows += '<tr>' +
        '<td style="padding:4px 8px;white-space:nowrap;position:sticky;left:0;background:#fff" title="' + esc(kk.key) + '">' +
          esc(kk.label) + '</td>' +
        roleCols.map(function(r){ return rolesAdminCellHtml(r, kk.key); }).join("") +
      '</tr>';
    });
  });

  var dirty = rolesAdminDirtyRoleIds();
  host.innerHTML =
    '<div style="overflow-x:auto;max-height:70vh;overflow-y:auto;border:1px solid #ddd;border-radius:4px">' +
      '<table style="border-collapse:collapse;font-size:12px;min-width:100%">' +
        '<thead style="position:sticky;top:0;background:#fff;z-index:2">' + head + '</thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>' +
    '<p class="hint" style="margin:8px 0 4px">🔒 Owner always has every permission — locked, so you can never lock ' +
      'yourself out. Scoped values: <b>Project</b> = only the user\'s assigned projects, <b>Own records</b> = only ' +
      'records they created, <b>Billing</b> = billing-relevant records/fields only.</p>' +
    '<div class="btnrow" style="margin:8px 0 0">' +
      '<button class="btn primary" id="roles-admin-save-btn" onclick="saveRolesAdmin()"' + (dirty.length ? '' : ' disabled') + '>' +
        (dirty.length ? 'Save Changes (' + dirty.length + ' role' + (dirty.length > 1 ? 's' : '') + ')' : 'Save Changes') +
      '</button>' +
      '<button class="btn" onclick="loadRolesAdmin()">Discard &amp; Reload</button>' +
    '</div>';
}

function rolesAdminCellHtml(role, key){
  var td = '<td style="padding:2px 6px;text-align:center">';
  if (role.id === "owner"){
    /* Guardrail: owner is locked to all-true -- rendered read-only here
       AND rejected server-side (set_role_permissions refuses roleId
       "owner"), so this isn't just cosmetic. */
    return td + '<span title="Owner is locked to all permissions" style="opacity:.55">✓</span></td>';
  }
  var v = rolesAdminState.working[role.id][key];
  var scopes = rolesAdminState.permissionScopes[key];
  if (Array.isArray(scopes) && scopes.length){
    /* Scoped key: dropdown (Off / On / only the scopes valid for THIS key)
       so a scoped grant isn't flattened to a plain boolean by the editor. */
    var opts = [
      { val: "false", label: "Off", sel: v === false },
      { val: "true", label: "On", sel: v === true }
    ];
    scopes.forEach(function(s){
      opts.push({ val: s, label: ROLES_ADMIN_SCOPE_LABELS[s] || s, sel: v === s });
    });
    return td + '<select onchange="rolesAdminOnCellChange(\'' + esc(role.id) + '\',\'' + esc(key) + '\', this.value)"' +
      ' style="font-size:11px;max-width:92px' + (v !== false ? ';background:#EAF6EA' : '') + '">' +
      opts.map(function(o){
        return '<option value="' + esc(o.val) + '"' + (o.sel ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join("") + '</select></td>';
  }
  return td + '<input type="checkbox"' + (v === true ? ' checked' : '') +
    ' onchange="rolesAdminOnCellChange(\'' + esc(role.id) + '\',\'' + esc(key) + '\', this.checked ? \'true\' : \'false\')"></td>';
}

function rolesAdminOnCellChange(roleId, key, rawValue){
  if (!rolesAdminState || !rolesAdminState.working[roleId]) return;
  var v = rawValue === "true" ? true : (rawValue === "false" ? false : rawValue);
  rolesAdminState.working[roleId][key] = v;
  /* Re-render only the footer state (Save button label/enabled), not the
     whole table -- a full re-render mid-edit would drop scroll position. */
  var btn = document.getElementById("roles-admin-save-btn");
  if (btn){
    var dirty = rolesAdminDirtyRoleIds();
    btn.disabled = !dirty.length;
    btn.textContent = dirty.length ?
      "Save Changes (" + dirty.length + " role" + (dirty.length > 1 ? "s" : "") + ")" : "Save Changes";
  }
}

async function saveRolesAdmin(){
  if (!rolesAdminState) return;
  var dirty = rolesAdminDirtyRoleIds();
  if (!dirty.length){ toast("No changes to save."); return; }

  /* Guardrail: warn before an edit that would strip user-management /
     security permissions from the CURRENT user's own role. Owner-claims
     users never hit this (owner bypasses the grid server-side and the
     owner role isn't editable at all) -- this protects a future non-owner
     who's been granted settings.security from locking themself out. */
  var myRole = (typeof currentAuthClaims !== "undefined" && currentAuthClaims) ? currentAuthClaims.role : null;
  var ownerClaims = rolesAdminIsOwner();
  if (!ownerClaims && myRole && dirty.indexOf(myRole) !== -1){
    var losing = ROLES_ADMIN_LOCKOUT_KEYS.filter(function(k){
      var roleDoc = rolesAdminState.roles.filter(function(r){ return r.id === myRole; })[0];
      var before = roleDoc && roleDoc.permissions ? roleDoc.permissions[k] : false;
      return before === true && rolesAdminState.working[myRole][k] !== true;
    });
    if (losing.length &&
        !confirm("You're removing " + losing.join(", ") + " from YOUR OWN role (" + myRole + "). " +
          "You could lose access to user management or this page. Save anyway?")) return;
  }
  /* System role, editable-with-care: changing what every admin can do
     deserves one explicit confirm, not a silent save. */
  if (dirty.indexOf("admin") !== -1 &&
      !confirm("You're changing the ADMIN role's permissions — this affects every admin user immediately. Save?")) return;

  var btn = document.getElementById("roles-admin-save-btn");
  if (btn) btn.disabled = true;
  toast("Saving role permissions…");
  var saved = 0, failed = [];
  for (var i = 0; i < dirty.length; i++){
    var roleId = dirty[i];
    try{
      await callAdminApi({ action: "set_role_permissions", roleId: roleId, permissions: rolesAdminState.working[roleId] });
      saved++;
    }catch(e){
      failed.push(roleId + " (" + e.message + ")");
    }
  }
  if (failed.length){
    toast("Saved " + saved + " role(s); FAILED: " + failed.join("; "));
  } else {
    toast("Saved " + saved + " role(s) ✓ — changes are live on the next permission check.");
  }
  /* Reload from the server either way -- shows exactly what's live now,
     including any role a failed save left untouched. */
  await loadRolesAdmin();
}
