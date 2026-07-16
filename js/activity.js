/* ================= Login history & who's-online (Admin page) =================
   Two halves in one module:

   1. EVERY signed-in user (not just admins) quietly feeds the data:
      - recordLoginEvent(): one login_events doc per sign-in per browser
        session (sessionStorage-deduped, so a mid-shift page refresh doesn't
        spam a new "login") -- uid/email/ts/userAgent, nothing sensitive,
        never a password or token. firestore.rules pins the uid to the
        writer's own verified token, so nobody can forge someone else's.
      - a presence heartbeat: presence/{uid}.lastActiveAt updated every
        ~60s while the tab is VISIBLE (hidden tabs don't write -- both to
        keep Firestore writes cheap and because a backgrounded tab isn't
        "online" in any sense Mark cares about). Firestore has no
        onDisconnect, so "online now" is a staleness threshold over
        lastActiveAt, not a live socket -- see presenceIsOnline().

   2. The admin-only "Login History & Online Now" card on the Admin page
      (#activity-admin-card, after Roles & Permissions), fed by admin.js's
      list_user_activity / list_login_events -- both audit.view-gated
      server-side, same tier as the Audit Log itself. Client-side hiding
      (isAdmin in updateAdminUI()) is convenience only, as everywhere.

   Wiring (all typeof-guarded in js/core.js so load order can't break):
   activityOnAuthChange(user) on every auth-state change;
   activityAdminOnShow() when the Admin view opens. */

var ACTIVITY_ONLINE_THRESHOLD_MS = 3 * 60 * 1000; /* lastActiveAt within 3 min = online */
var ACTIVITY_HEARTBEAT_MS = 60 * 1000;            /* one presence write per minute, max */
/* Guards the "became visible again" immediate beat: switching tabs back and
   forth must not produce writes faster than the normal heartbeat cadence. */
var ACTIVITY_MIN_WRITE_GAP_MS = 45 * 1000;

/* Pure -- the one place "online" is defined. lastActiveAt is a plain
   Date.now() number (like every timestamp in this app); anything missing,
   non-numeric, or stale is offline. */
function presenceIsOnline(lastActiveAt, now){
  return typeof lastActiveAt === "number" && isFinite(lastActiveAt) &&
    (now - lastActiveAt) <= ACTIVITY_ONLINE_THRESHOLD_MS;
}

/* Pure -- compact "how long ago" for last-seen lines. */
function activityAgo(ts, now){
  if (typeof ts !== "number" || !isFinite(ts)) return "never";
  var s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  var m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  var h = Math.floor(m / 60);
  if (h < 24) return h + " hr ago";
  var d = Math.floor(h / 24);
  return d + " day" + (d > 1 ? "s" : "") + " ago";
}

/* Pure -- short human device label from a userAgent string. Deliberately
   coarse (platform + browser family), not a parser: enough for "Mark's
   iPhone vs the office PC", nothing more. */
function activityDeviceLabel(ua){
  ua = String(ua || "");
  if (!ua) return "unknown device";
  var os = /iPhone|iPad/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "Mac" :
    /Linux/.test(ua) ? "Linux" : "other";
  /* Order matters: Edge and many Android browsers also say "Chrome", and
     Chrome/Android say "Safari" -- most-specific first. */
  var browser = /Edg\//.test(ua) ? "Edge" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "browser";
  return os + " · " + browser;
}

/* ---- half 1: feeding the data (every signed-in user) ---- */

function activitySessionKey(uid){ return "login_event_recorded_" + uid; }

async function recordLoginEvent(user){
  if (!fdb || !user || !user.uid) return false;
  /* One event per (uid, browser session): sessionStorage survives refresh
     but not a new tab/window -- a refresh isn't a new login, a fresh tab
     arguably is. Guarded: sessionStorage can throw (private mode); if it
     does, err on the side of recording. */
  var flagged = false;
  try{ flagged = !!sessionStorage.getItem(activitySessionKey(user.uid)); }catch(e){}
  if (flagged) return false;
  try{
    await fdb.collection("login_events").add({
      uid: user.uid,
      email: user.email || null,
      ts: Date.now(),
      userAgent: String((typeof navigator !== "undefined" && navigator.userAgent) || "").slice(0, 300)
    });
    try{ sessionStorage.setItem(activitySessionKey(user.uid), "1"); }catch(e){}
    return true;
  }catch(e){
    /* A failed login-history write must never affect the user's session --
       it's telemetry, not the sign-in itself. */
    return false;
  }
}

var activityHeartbeatTimer = null;
var activityLastBeatAt = 0;

async function activityBeat(user){
  if (!fdb || !user || !user.uid) return false;
  /* Hidden tab = not online; also the write-cheapness rule. */
  if (typeof document !== "undefined" && document.visibilityState &&
      document.visibilityState !== "visible") return false;
  var now = Date.now();
  if (now - activityLastBeatAt < ACTIVITY_MIN_WRITE_GAP_MS) return false;
  try{
    await fdb.collection("presence").doc(user.uid).set({
      uid: user.uid,
      email: user.email || null,
      lastActiveAt: now,
      userAgent: String((typeof navigator !== "undefined" && navigator.userAgent) || "").slice(0, 300)
    }, { merge: true });
    activityLastBeatAt = now;
    return true;
  }catch(e){ return false; }
}

function activityStartHeartbeat(user){
  activityStopHeartbeat();
  activityBeat(user); /* immediate first beat -- online right away, not in 60s */
  activityHeartbeatTimer = setInterval(function(){ activityBeat(user); }, ACTIVITY_HEARTBEAT_MS);
  /* Coming back to the tab beats immediately (gap-guarded above) so an
     admin checking "who's online" sees a just-returned tech promptly. */
  if (typeof document !== "undefined" && document.addEventListener && !activityStartHeartbeat._visHooked){
    activityStartHeartbeat._visHooked = true;
    document.addEventListener("visibilitychange", function(){
      if (document.visibilityState === "visible" && currentAuthUser) activityBeat(currentAuthUser);
    });
  }
}
function activityStopHeartbeat(){
  if (activityHeartbeatTimer){ clearInterval(activityHeartbeatTimer); activityHeartbeatTimer = null; }
}

/* Called from core.js's onAuthStateChanged (typeof-guarded there). */
function activityOnAuthChange(user){
  if (user){
    recordLoginEvent(user);
    activityStartHeartbeat(user);
  } else {
    activityStopHeartbeat();
  }
}

/* Load-order safety net: core.js's onAuthStateChanged calls
   activityOnAuthChange typeof-guarded -- if auth resolved BEFORE this file
   parsed (core.js loads first), that call was a no-op, so catch up off the
   already-populated currentAuthUser now. recordLoginEvent's sessionStorage
   dedupe makes running both paths harmless. */
if (typeof currentAuthUser !== "undefined" && currentAuthUser){
  activityOnAuthChange(currentAuthUser);
}

/* ---- half 2: the admin card ---- */

var activityAdminData = null; /* { users: [...], events: [...] } */

function activityAdminOnShow(){
  if (typeof isAdmin === "undefined" || !isAdmin) return;
  loadActivityAdmin();
}

async function loadActivityAdmin(){
  var host = document.getElementById("activity-admin-body");
  if (!host) return;
  host.innerHTML = '<p class="hint">Loading…</p>';
  try{
    var results = await Promise.all([
      callAdminApi({ action: "list_user_activity" }),
      callAdminApi({ action: "list_login_events" })
    ]);
    activityAdminData = { users: results[0].items || [], events: results[1].items || [] };
    renderActivityAdmin();
  }catch(e){
    host.innerHTML = '<p class="hint">Couldn\'t load activity: ' + esc(e.message) + '</p>';
  }
}

function renderActivityAdmin(){
  var host = document.getElementById("activity-admin-body");
  if (!host || !activityAdminData) return;
  var now = Date.now();
  var users = activityAdminData.users.slice();

  var online = users.filter(function(u){ return presenceIsOnline(u.lastActiveAt, now); });
  var offline = users.filter(function(u){ return !presenceIsOnline(u.lastActiveAt, now); });
  /* Most recently seen first; never-seen (no presence yet) sink to the
     bottom, ordered by Firebase Auth's own lastSignInTime when we have it. */
  offline.sort(function(a, b){
    var la = a.lastActiveAt || (a.lastSignInTime ? Date.parse(a.lastSignInTime) : 0) || 0;
    var lb = b.lastActiveAt || (b.lastSignInTime ? Date.parse(b.lastSignInTime) : 0) || 0;
    return lb - la;
  });

  function userLine(u, isOnline){
    var dot = isOnline ?
      '<span style="color:#2E7D32;font-size:15px" title="Online now">●</span>' :
      '<span style="color:#B0B7BD;font-size:15px" title="Offline">●</span>';
    var seen = isOnline ? "online now" :
      (u.lastActiveAt ? "last seen " + activityAgo(u.lastActiveAt, now) :
        (u.lastSignInTime ? "last sign-in " + activityAgo(Date.parse(u.lastSignInTime), now) : "never signed in"));
    var device = u.userAgent ? ' <span class="hint" style="margin:0">· ' + esc(activityDeviceLabel(u.userAgent)) + '</span>' : '';
    return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0">' + dot +
      '<span><b>' + esc(u.email || u.displayName || u.uid) + '</b>' +
      (u.role ? ' <span class="hint" style="margin:0">(' + esc(u.role) + ')</span>' : '') +
      ' — ' + esc(seen) + device + '</span></div>';
  }

  var onlineHtml = online.length ?
    online.map(function(u){ return userLine(u, true); }).join("") :
    '<p class="hint" style="margin:4px 0">Nobody online right now.</p>';
  var offlineHtml = offline.map(function(u){ return userLine(u, false); }).join("");

  /* Login history, filterable by user. Events arrive newest-first from the
     server; the filter is client-side over what's loaded (last 200). */
  var events = activityAdminData.events;
  var filterSel = document.getElementById("activity-login-filter");
  var filterVal = filterSel ? filterSel.value : "";
  var emails = {};
  events.forEach(function(ev){ if (ev.email) emails[ev.email] = true; });
  var filterOptions = '<option value="">All users</option>' + Object.keys(emails).sort().map(function(em){
    return '<option value="' + esc(em) + '"' + (em === filterVal ? ' selected' : '') + '>' + esc(em) + '</option>';
  }).join("");
  var shown = filterVal ? events.filter(function(ev){ return ev.email === filterVal; }) : events;
  var eventsHtml = shown.length ? shown.map(function(ev){
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid #f0f0f0;font-size:12px">' +
      '<span><b>' + esc(ev.email || ev.uid || "") + '</b>' +
      ' <span class="hint" style="margin:0">· ' + esc(activityDeviceLabel(ev.userAgent)) + '</span></span>' +
      '<span class="hint" style="margin:0;white-space:nowrap">' + esc(ev.ts ? new Date(ev.ts).toLocaleString() : "") + '</span>' +
    '</div>';
  }).join("") : '<p class="hint" style="margin:4px 0">No logins recorded' + (filterVal ? " for this user" : "") + ' yet.</p>';

  host.innerHTML =
    '<h3 style="margin:0 0 4px">🟢 Online now (' + online.length + ')</h3>' + onlineHtml +
    '<h3 style="margin:14px 0 4px">Last seen</h3>' + (offlineHtml || '<p class="hint" style="margin:4px 0">No other users.</p>') +
    '<h3 style="margin:14px 0 6px">Login history <span class="hint" style="font-size:12px">(latest ' + events.length + ')</span></h3>' +
    '<div class="btnrow" style="margin:0 0 8px;align-items:center">' +
      '<select id="activity-login-filter" onchange="renderActivityAdmin()">' + filterOptions + '</select>' +
      '<button class="btn" onclick="loadActivityAdmin()">Refresh</button>' +
    '</div>' +
    '<div style="max-height:40vh;overflow-y:auto">' + eventsHtml + '</div>';
}
