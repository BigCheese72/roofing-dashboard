// TEMPORARY verification endpoint. To be deleted immediately after use.
//
// Answers, with observed results rather than labels on a console screen:
//   1. Do the two Firestore composite indexes actually exist and serve the
//      EXACT queries production runs? (Not "does the console say Enabled".)
//   2. Does Graph authenticate, and which capabilities really work?
//   3. Is the AppOnly AccessPolicy 403 genuinely gone?
//   4. What would the poller do with the REAL CCM Inspect emails sitting in
//      Mark's mailbox right now -- file them, and where? Or queue them?
//
// SAFETY:
//   * Behind requirePermission(..., "warranty.manage_reports"). Auth runs FIRST,
//     before any env check, before any Graph or Firestore call.
//   * The CCM section is a DRY RUN. It calls the real matcher on the real
//     emails and reports what WOULD happen. It writes NOTHING: no Firestore,
//     no Storage, and above all NO CompanyCam upload.
//   * Graph write probes are reversible and self-cleaning (create, then delete).
//   * Never returns the access token, the client secret, or mail bodies.
const { getDb, requirePermission, hostnameFromEvent } = require("./lib/authGuard");
const { getAppOnlyToken, graphFetch, requireEnv } = require("./lib/graphAuth");
const { matchBuilding } = require("./lib/buildingMatch");

const CCM_SENDER = "rogelio.ruiz@ccminspect.com";
const STAMP = "RoofOps-Verify-" + Date.now();

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj, null, 1) };
}

async function probe(label, path, options) {
  try {
    const r = await graphFetch(path, options);
    const text = await r.text();
    let code = null, msg = null, id = null, count = null;
    if (!r.ok) {
      try { const j = JSON.parse(text); code = j.error && j.error.code; msg = j.error && j.error.message; }
      catch (e) { msg = text.slice(0, 160); }
    } else if (text) {
      try { const j = JSON.parse(text); if (j.id) id = j.id; if (Array.isArray(j.value)) count = j.value.length; }
      catch (e) { /* 204 */ }
    }
    return { label, status: r.status, ok: r.ok, err: code, msg: msg ? String(msg).slice(0, 180) : null, id, count };
  } catch (e) {
    return { label, status: -1, ok: false, err: "REQUEST_FAILED", msg: String(e && e.message).slice(0, 180) };
  }
}

exports.handler = async function (event) {
  try { await requirePermission(event, "warranty.manage_reports"); }
  catch (e) { return resp(e.statusCode || 401, { error: "Unauthorized" }); }

  const hostname = hostnameFromEvent(event);
  const db = getDb(hostname);
  const out = { indexes: {}, graph: {}, capabilities: {}, cleanup: [], ccmDryRun: {} };

  // ================= 1. FIRESTORE INDEXES =================
  // The EXACT queries production runs -- not approximations.

  // (a) warranty_review_queue -- list_review_queue()
  try {
    await db.collection("warranty_review_queue")
      .where("status", "==", "pending").orderBy("createdAt", "desc").limit(1).get();
    out.indexes.warranty_review_queue = { ok: true, note: "status + createdAt DESC -- query served" };
  } catch (e) {
    out.indexes.warranty_review_queue = {
      ok: false,
      failedPrecondition: /FAILED_PRECONDITION|requires an index/i.test(String(e.message)),
      error: String(e.message).slice(0, 200)
    };
  }

  // (b) buildings/{id}/warranty_reports -- resolveSupersedes(), run on EVERY
  // filing. This is a SUBCOLLECTION (COLLECTION-scoped) index, which is a
  // different thing from a collection-group index -- a collection-group index
  // will NOT satisfy it. So run it against a real building.
  try {
    const b = await db.collection("buildings").limit(1).get();
    if (b.empty) {
      out.indexes.warranty_reports = { ok: false, error: "no buildings exist to test against" };
    } else {
      const bid = b.docs[0].id;
      await db.collection("buildings").doc(bid).collection("warranty_reports")
        .where("status", "==", "active").orderBy("uploadedAt", "desc").limit(1).get();
      out.indexes.warranty_reports = { ok: true, testedAgainstBuilding: bid, note: "status + uploadedAt DESC -- query served" };
    }
  } catch (e) {
    out.indexes.warranty_reports = {
      ok: false,
      failedPrecondition: /FAILED_PRECONDITION|requires an index/i.test(String(e.message)),
      error: String(e.message).slice(0, 200)
    };
  }

  // ================= 2. GRAPH AUTH =================
  let mailbox = null;
  try { ({ mailbox } = requireEnv()); }
  catch (e) { out.graph = { ok: false, error: e.message }; return resp(200, out); }

  try {
    const token = await getAppOnlyToken();
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64").toString("utf8"));
    out.graph = {
      ok: true,
      appId: payload.appid || null,
      grantedApplicationPermissions: (payload.roles || []).sort()
    };
  } catch (e) {
    out.graph = { ok: false, error: String(e.message).slice(0, 240) };
    return resp(200, out);
  }

  // ================= 3. CAPABILITIES =================
  const U = "/users/" + encodeURIComponent(mailbox);

  out.capabilities.mail_read = await probe("GET mailFolders", U + "/mailFolders?$top=1");

  const mk = await probe("POST mailFolders (create)", U + "/mailFolders", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: STAMP })
  });
  out.capabilities.mail_write = mk;
  if (mk.ok && mk.id) {
    const d = await probe("DELETE mailFolder", U + "/mailFolders/" + encodeURIComponent(mk.id), { method: "DELETE" });
    out.cleanup.push({ what: "mail folder " + STAMP, deleted: d.ok });
  }

  out.capabilities.contacts_read = await probe("GET contacts", U + "/contacts?$top=1");
  const ct = await probe("POST contacts (create)", U + "/contacts", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ givenName: "RoofOps", surname: "Verify", fileAs: STAMP })
  });
  out.capabilities.contacts_write = ct;
  if (ct.ok && ct.id) {
    const d = await probe("DELETE contact", U + "/contacts/" + encodeURIComponent(ct.id), { method: "DELETE" });
    out.cleanup.push({ what: "contact " + STAMP, deleted: d.ok });
  }

  out.capabilities.files_read = await probe("GET drive root", U + "/drive/root/children?$top=1");
  const pf = await probe("PUT drive file", U + "/drive/root:/" + STAMP + ".txt:/content", {
    method: "PUT", headers: { "Content-Type": "text/plain" }, body: "RoofOps verification. Safe to delete."
  });
  out.capabilities.files_write = pf;
  if (pf.ok && pf.id) {
    const d = await probe("DELETE drive file", U + "/drive/items/" + encodeURIComponent(pf.id), { method: "DELETE" });
    out.cleanup.push({ what: "OneDrive " + STAMP + ".txt", deleted: d.ok });
  }

  const all = Object.keys(out.capabilities).map(k => out.capabilities[k]);
  out.appOnlyAccessPolicyStillBlocking = all.some(r =>
    r.status === 403 && /AppOnly|AccessPolicy|Blocked by tenant/i.test((r.msg || "") + (r.err || "")));

  // ================= 4. CCM DRY RUN -- WRITES NOTHING =================
  // Uses the SAME query shape the fixed poller uses (no $orderby -- Graph
  // rejects $filter-on-sender + $orderby with 400 InefficientFilter).
  try {
    const filter = "from/emailAddress/address eq '" + CCM_SENDER.replace(/'/g, "''") + "'";
    const r = await graphFetch(U + "/messages?$filter=" + encodeURIComponent(filter) +
      "&$top=50&$select=id,subject,receivedDateTime,hasAttachments");
    const t = await r.text();
    if (!r.ok) {
      out.ccmDryRun = { ok: false, error: "Graph said " + r.status + " " + t.slice(0, 200) };
    } else {
      const msgs = (JSON.parse(t).value || []);
      const withAtt = msgs.filter(m => m.hasAttachments);

      const bsnap = await db.collection("buildings").get();
      const buildings = [];
      bsnap.forEach(d => {
        const v = d.data();
        if (v.archived) return;
        buildings.push({ id: d.id, name: v.name || "", location: v.location || "", companyCamProjectId: v.companyCamProjectId || null });
      });

      const plan = [];
      for (const m of withAtt) {
        const ar = await graphFetch(U + "/messages/" + encodeURIComponent(m.id) + "/attachments?$select=id,name,contentType,size");
        const at = await ar.text();
        const atts = ar.ok ? (JSON.parse(at).value || []) : [];
        const pdfs = atts.filter(a => (a.contentType || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(a.name || ""));
        for (const a of pdfs) {
          const candidateText = (m.subject || "") + " " + (a.name || "");
          const match = matchBuilding(buildings, candidateText);
          plan.push({
            subject: m.subject,
            attachment: a.name,
            received: m.receivedDateTime,
            WOULD: match.building ? "FILE onto " + match.building.id : "QUEUE for review",
            buildingName: match.building ? match.building.name : null,
            buildingLocation: match.building ? match.building.location : null,
            method: match.method,
            nearMisses: (match.decision && match.decision.nearMisses || []).map(n => n.buildingName + " (" + n.reason + ")")
          });
        }
      }
      out.ccmDryRun = {
        ok: true,
        note: "DRY RUN -- nothing written. No Firestore, no Storage, no CompanyCam.",
        totalMessagesFromCcm: msgs.length,
        messagesWithAttachments: withAtt.length,
        buildingsConsidered: buildings.length,
        plan
      };
    }
  } catch (e) {
    out.ccmDryRun = { ok: false, error: String(e.message).slice(0, 240) };
  }

  return resp(200, out);
};
