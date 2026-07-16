"use strict";
/* Login History & Online Now -- client half (js/activity.js), run in a vm
   with fdb/sessionStorage/document stubbed.

   What must stay true:
     1. presenceIsOnline: within the 3-minute threshold = online; stale,
        missing, or garbage lastActiveAt = offline. This is THE definition
        of the green dot.
     2. recordLoginEvent writes exactly uid/email/ts/userAgent (no token,
        no password, nothing else), and exactly ONCE per (uid, browser
        session) -- a page refresh must not fabricate a second "login".
     3. The presence heartbeat never writes from a hidden tab, and the
        min-write-gap keeps rapid visibility flapping from hammering
        Firestore. */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "activity.js"), "utf8");

function makeCtx(opts) {
  opts = opts || {};
  const writes = { loginEvents: [], presence: {} };
  const session = new Map();
  const ctx = {
    writes,
    setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, isFinite, String, Object,
    navigator: { userAgent: opts.userAgent !== undefined ? opts.userAgent : "TestUA/1.0 (Windows) Chrome/120" },
    document: {
      visibilityState: opts.visibilityState || "visible",
      addEventListener: () => {}
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, v)
    },
    currentAuthUser: null,
    isAdmin: false,
    esc: (s) => String(s == null ? "" : s),
    callAdminApi: async () => { throw new Error("no network in tests"); },
    fdb: {
      collection: (name) => ({
        add: async (data) => {
          if (name !== "login_events") throw new Error("unexpected add to " + name);
          writes.loginEvents.push(data);
          return { id: "evt_" + writes.loginEvents.length };
        },
        doc: (id) => ({
          set: async (data, o) => {
            if (name !== "presence") throw new Error("unexpected doc set on " + name);
            writes.presence[id] = Object.assign({}, (o && o.merge && writes.presence[id]) || {}, data);
          }
        })
      })
    }
  };
  vm.runInNewContext(src, ctx);
  return ctx;
}

// ---- 1. the online threshold ----
test("presenceIsOnline: 3-minute staleness threshold, garbage-proof", () => {
  const ctx = makeCtx();
  const now = 10_000_000;
  const MIN = 60 * 1000;
  assert.strictEqual(ctx.presenceIsOnline(now - 1 * MIN, now), true, "1 min ago = online");
  assert.strictEqual(ctx.presenceIsOnline(now - 3 * MIN, now), true, "exactly 3 min = still online (<=)");
  assert.strictEqual(ctx.presenceIsOnline(now - 3 * MIN - 1, now), false, "3 min + 1ms = offline");
  assert.strictEqual(ctx.presenceIsOnline(now - 4 * MIN, now), false, "4 min ago = offline");
  for (const bad of [null, undefined, NaN, "yesterday", Infinity]) {
    assert.strictEqual(ctx.presenceIsOnline(bad, now), false, "garbage lastActiveAt must be offline: " + bad);
  }
});

test("activityAgo renders compact last-seen text", () => {
  const ctx = makeCtx();
  const now = Date.now();
  assert.strictEqual(ctx.activityAgo(now - 10 * 1000, now), "just now");
  assert.strictEqual(ctx.activityAgo(now - 5 * 60 * 1000, now), "5 min ago");
  assert.strictEqual(ctx.activityAgo(now - 3 * 3600 * 1000, now), "3 hr ago");
  assert.strictEqual(ctx.activityAgo(now - 2 * 86400 * 1000, now), "2 days ago");
  assert.strictEqual(ctx.activityAgo(null, now), "never");
});

test("activityDeviceLabel: coarse platform + browser, most-specific first", () => {
  const ctx = makeCtx();
  assert.strictEqual(ctx.activityDeviceLabel(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1"),
    "iOS · Safari");
  assert.strictEqual(ctx.activityDeviceLabel(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"),
    "Windows · Chrome", "Chrome says Safari too -- Chrome must win");
  assert.strictEqual(ctx.activityDeviceLabel(
    "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0"),
    "Windows · Edge", "Edge says Chrome too -- Edge must win");
  assert.strictEqual(ctx.activityDeviceLabel(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36"),
    "Android · Chrome");
  assert.strictEqual(ctx.activityDeviceLabel(""), "unknown device");
});

// ---- 2. the login event ----
test("recordLoginEvent: exactly uid/email/ts/userAgent, once per session", async () => {
  const ctx = makeCtx();
  const user = { uid: "u1", email: "tech@watkins.com" };

  const first = await ctx.recordLoginEvent(user);
  assert.strictEqual(first, true);
  assert.strictEqual(ctx.writes.loginEvents.length, 1);
  const evt = ctx.writes.loginEvents[0];
  assert.deepStrictEqual(Object.keys(evt).sort(), ["email", "ts", "uid", "userAgent"],
    "no extra fields -- and certainly no token/password");
  assert.strictEqual(evt.uid, "u1");
  assert.strictEqual(evt.email, "tech@watkins.com");
  assert.ok(typeof evt.ts === "number" && evt.ts > 0);
  assert.strictEqual(evt.userAgent, "TestUA/1.0 (Windows) Chrome/120");

  // Refresh in the same browser session: no second event.
  const second = await ctx.recordLoginEvent(user);
  assert.strictEqual(second, false);
  assert.strictEqual(ctx.writes.loginEvents.length, 1, "one login event per session, ever");

  // A DIFFERENT user in the same session (shared field tablet) still records.
  await ctx.recordLoginEvent({ uid: "u2", email: "other@watkins.com" });
  assert.strictEqual(ctx.writes.loginEvents.length, 2);
});

test("recordLoginEvent: no fdb / no user = silent no-op", async () => {
  const ctx = makeCtx();
  assert.strictEqual(await ctx.recordLoginEvent(null), false);
  const noDb = makeCtx();
  noDb.fdb = null;
  assert.strictEqual(await noDb.recordLoginEvent({ uid: "u1" }), false);
  assert.strictEqual(noDb.writes.loginEvents.length, 0);
});

// ---- 3. the heartbeat ----
test("activityBeat writes presence for a visible tab, with uid pinned", async () => {
  const ctx = makeCtx();
  const ok = await ctx.activityBeat({ uid: "u1", email: "tech@watkins.com" });
  assert.strictEqual(ok, true);
  const p = ctx.writes.presence.u1;
  assert.strictEqual(p.uid, "u1");
  assert.strictEqual(p.email, "tech@watkins.com");
  assert.ok(typeof p.lastActiveAt === "number");
});

test("activityBeat never writes from a hidden tab", async () => {
  const ctx = makeCtx({ visibilityState: "hidden" });
  const ok = await ctx.activityBeat({ uid: "u1", email: "tech@watkins.com" });
  assert.strictEqual(ok, false);
  assert.deepStrictEqual(ctx.writes.presence, {}, "hidden tab must not write presence");
});

test("activityBeat gap-guard: an immediate second beat is skipped (cheap writes)", async () => {
  const ctx = makeCtx();
  const user = { uid: "u1", email: "tech@watkins.com" };
  assert.strictEqual(await ctx.activityBeat(user), true);
  const firstStamp = ctx.writes.presence.u1.lastActiveAt;
  assert.strictEqual(await ctx.activityBeat(user), false, "second beat inside the 45s gap must skip");
  assert.strictEqual(ctx.writes.presence.u1.lastActiveAt, firstStamp, "no second write happened");
});

test("sign-out stops the heartbeat; sign-in starts it and beats immediately", async () => {
  let intervalCleared = false, intervalSet = 0;
  const ctx = makeCtx();
  ctx.setInterval = () => { intervalSet++; return 42; };
  ctx.clearInterval = (id) => { if (id === 42) intervalCleared = true; };
  // re-evaluate with the counting timer stubs
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "js", "activity.js"), "utf8"), ctx);

  ctx.activityOnAuthChange({ uid: "u1", email: "tech@watkins.com" });
  await new Promise(r => setImmediate(r)); // let the fire-and-forget beat land
  assert.strictEqual(intervalSet >= 1, true, "heartbeat interval must start on sign-in");
  assert.ok(ctx.writes.presence.u1, "first beat fires immediately, not in 60s");

  ctx.activityOnAuthChange(null);
  assert.strictEqual(intervalCleared, true, "sign-out must stop the heartbeat");
});
