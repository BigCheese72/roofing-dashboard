"use strict";
/* Drift guard for the Roles & Permissions editor's DISPLAY mirror
   (js/roles-admin.js) against the authoritative registry
   (netlify/functions/lib/permissions.js), plus the cell-rendering
   guardrails the grid itself must keep:

     1. Every registry key has a human label in a known group (a new
        permission key added server-side without a label here fails THIS
        test instead of silently rendering as a raw key at runtime).
     2. No stale mirror entries for keys the registry no longer has.
     3. Every scope any key accepts has a display label.
     4. The owner column renders LOCKED (no editable control), scoped keys
        render a dropdown with exactly Off/On + that key's allowed scopes,
        and boolean-only keys render a plain checkbox. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { PERMISSION_KEYS, PERMISSION_SCOPES } = require("../netlify/functions/lib/permissions.js");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "roles-admin.js"), "utf8");
function makeCtx() {
  const ctx = {
    esc: (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    currentAuthClaims: { owner: true, role: "owner" },
    document: { getElementById: () => null },
    toast: () => {},
    callAdminApi: async () => { throw new Error("no network in tests"); },
    confirm: () => true
  };
  vm.runInNewContext(src, ctx);
  return ctx;
}

test("every PERMISSION_KEYS entry has a label in a declared group", () => {
  const ctx = makeCtx();
  for (const k of PERMISSION_KEYS) {
    const meta = ctx.ROLES_ADMIN_PERM_LABELS[k];
    assert.ok(meta, "missing display label for permission key: " + k);
    assert.ok(meta.label && meta.label !== k, "label for " + k + " must be human-readable");
    assert.ok(ctx.ROLES_ADMIN_GROUPS.includes(meta.group),
      k + " is in undeclared group " + meta.group);
  }
});

test("no stale mirror entries for keys the registry no longer has", () => {
  const ctx = makeCtx();
  for (const k of Object.keys(ctx.ROLES_ADMIN_PERM_LABELS)) {
    assert.ok(PERMISSION_KEYS.includes(k), "stale mirror entry: " + k);
  }
});

test("every scope value used anywhere has a display label", () => {
  const ctx = makeCtx();
  for (const key of Object.keys(PERMISSION_SCOPES)) {
    for (const s of PERMISSION_SCOPES[key]) {
      assert.ok(ctx.ROLES_ADMIN_SCOPE_LABELS[s], "missing display label for scope: " + s);
    }
  }
});

function withState(ctx) {
  ctx.rolesAdminState = {
    roles: [
      { id: "owner", label: "Owner", permissions: {} },
      { id: "field_tech", label: "Field Tech", permissions: { "workorder.view.all": false } }
    ],
    permissionKeys: PERMISSION_KEYS.slice(),
    permissionScopes: JSON.parse(JSON.stringify(PERMISSION_SCOPES)),
    working: {
      owner: {},
      field_tech: { "workorder.view.all": "billing", "changeorder.draft": true }
    }
  };
  return ctx;
}

test("owner cell renders locked -- no checkbox, no select, ever", () => {
  const ctx = withState(makeCtx());
  for (const key of ["workorder.view.all", "changeorder.draft", "settings.security"]) {
    const html = ctx.rolesAdminCellHtml({ id: "owner", label: "Owner" }, key);
    assert.ok(!/<input|<select/.test(html), "owner cell for " + key + " must not be editable: " + html);
    assert.ok(html.includes("✓"), "owner cell shows a locked grant");
  }
});

test("scoped key renders a dropdown with exactly Off/On + that key's scopes, current value selected", () => {
  const ctx = withState(makeCtx());
  const html = ctx.rolesAdminCellHtml({ id: "field_tech" }, "workorder.view.all");
  assert.ok(html.includes("<select"), "scoped key must render a select");
  const values = [...html.matchAll(/option value="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(values, ["false", "true", "proj", "billing"],
    "options must be Off/On + exactly the key's allowed scopes, in order");
  assert.match(html, /value="billing" selected/, "current scoped value must be pre-selected");
});

test("boolean-only key renders a plain checkbox", () => {
  const ctx = withState(makeCtx());
  const html = ctx.rolesAdminCellHtml({ id: "field_tech" }, "changeorder.draft");
  assert.ok(html.includes('type="checkbox"'), "boolean key must render a checkbox");
  assert.ok(html.includes(" checked"), "true value must render checked");
  assert.ok(!html.includes("<select"), "boolean key must not render a scope dropdown");
});

test("dirty tracking: owner is never dirty; a changed role is", () => {
  const ctx = withState(makeCtx());
  // owner working copy differs from permissions {} -- but owner must be excluded
  ctx.rolesAdminState.working.owner = { "billing.view": true };
  assert.deepStrictEqual(ctx.rolesAdminDirtyRoleIds(), ["field_tech"]);
});
