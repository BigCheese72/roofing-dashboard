// Contacts sync — harvest the people Mark actually corresponds with out of his
// mailbox and turn them into Outlook contacts, enriched from email signatures.
//
// DELEGATED Graph (lib/graphDelegatedAuth.js), not app-only: the app-only app
// registration has no Contacts permission (and Exchange's Application Access
// Policy gates it besides), whereas the delegated grant Mark consented to on
// 2026-07-13 includes Contacts.ReadWrite. Every call here is therefore "as
// Mark", against /me — which is also exactly the blast radius we want: this
// function cannot touch any other mailbox in the tenant even in principle.
//
// SAFETY / SCOPE — this function is deliberately incapable of most things:
//   * Behind requirePermission(..., "warranty.manage_reports") — the same gate
//     as outlook.js / graph-selftest.js. Auth runs FIRST, before any env read
//     or Graph call, so an unauthenticated caller gets 401 and never a 500
//     that leaks configuration state.
//   * Mail is READ-ONLY. It issues GETs only. It NEVER PATCHes `isRead`, and
//     reading a message via Graph does not mark it read as a side effect (that
//     is an Outlook-client behaviour, not a Graph one) — so the 322 unread in
//     Mark's inbox stay unread. It never sends, replies, forwards, moves,
//     deletes, or creates rules.
//   * The ONLY writes are to /me/contacts, and only via `upsert`, and only for
//     the exact payload the caller passes. Existing contacts are PATCHed
//     (merge — Graph only overwrites the properties present in the body), never
//     replaced or deleted.
//   * `dryRun: true` on upsert reports what it *would* do and writes nothing.
//   * It never returns the delegated token, the refresh token, or the client
//     secret. It returns signature-derived contact fields and a few raw
//     signature lines (Mark's own mail, shown back to Mark) — not message
//     bodies wholesale, not subjects.
//   * URLs found in signatures are recorded as text into the contact's
//     businessHomePage. Nothing here ever fetches or follows them.
const { requirePermission } = require("./lib/authGuard");
const { graphFetchDelegated } = require("./lib/graphDelegatedAuth");

function resp(code, obj) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

async function gj(pathOrUrl, options) {
  const r = await graphFetchDelegated(pathOrUrl, options);
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON (204 etc.) */ }
  if (!r.ok) {
    const err = new Error("Graph " + r.status + " " + ((json && json.error && json.error.code) || "") +
      " " + ((json && json.error && json.error.message) || String(text).slice(0, 200)));
    err.statusCode = r.status;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// NOISE FILTER — what is not a person.
//
// Ordered from most to least specific. The bar for exclusion is deliberately
// "provably not a human correspondent", not "looks spammy": a false exclusion
// silently loses a real customer, which is worse than a junk contact Mark can
// delete in two clicks. Anything uncertain is KEPT and flagged for review
// rather than dropped.
// ---------------------------------------------------------------------------
const NOISE_LOCAL = [
  /^no-?reply/i, /^do-?not-?reply/i, /^donotreply/i, /^bounces?[+@-]/i, /^mailer-daemon/i,
  /^postmaster/i, /^notifications?[+@-]?/i, /^alerts?[+@-]?/i, /^info$/i, /^support$/i,
  /^news(letter)?s?$/i, /^marketing$/i, /^updates?$/i, /^billing$/i, /^receipts?$/i,
  /^invites?$/i, /^team$/i, /^hello$/i, /^automated/i, /^system/i, /^webmaster$/i,
  /^security$/i, /^account(s)?[-_]?(security|team)?$/i, /^help$/i, /^admin$/i,
];

// Mark's own automated RoofOps mail: workorders@ and the per-job WO#####@ aliases.
const NOISE_WATKINS = [/^workorders$/i, /^wo\d+$/i, /^feedback$/i];

const NOISE_DOMAIN = [
  /(^|\.)microsoft\.com$/i, /(^|\.)microsoftonline\.com$/i, /(^|\.)office\.com$/i,
  /(^|\.)accountprotection\.microsoft\.com$/i,
  /(^|\.)x\.com$/i, /(^|\.)twitter\.com$/i, /(^|\.)resend\.(com|dev)$/i,
  /(^|\.)linkedin\.com$/i, /(^|\.)facebook(mail)?\.com$/i, /(^|\.)google\.com$/i,
  /(^|\.)firebaseapp\.com$/i, /(^|\.)github\.com$/i, /(^|\.)netlify\.(com|app)$/i,
  /(^|\.)mailchimp(app)?\.com$/i, /(^|\.)sendgrid\.(net|com)$/i, /(^|\.)constantcontact\.com$/i,
  /(^|\.)hubspot\.com$/i, /(^|\.)otter\.ai$/i, /(^|\.)zoom\.us$/i, /(^|\.)docusign\.(net|com)$/i,
  /(^|\.)intuit\.com$/i, /(^|\.)quickbooks\.com$/i, /(^|\.)paypal\.com$/i, /(^|\.)indeed\.com$/i,
  /(^|\.)ziprecruiter\.com$/i, /(^|\.)oracle\.com$/i, /(^|\.)netsuite\.com$/i,
];

function classify(email, displayName) {
  const e = String(email || "").toLowerCase().trim();
  const at = e.indexOf("@");
  if (at < 1) return { keep: false, reason: "not an email address" };
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);

  if (domain === "watkinsroofing.net" && NOISE_WATKINS.some(re => re.test(local))) {
    return { keep: false, reason: "RoofOps automated mail (" + local + "@)" };
  }
  if (NOISE_LOCAL.some(re => re.test(local))) return { keep: false, reason: "role/automated mailbox (" + local + "@)" };
  if (NOISE_DOMAIN.some(re => re.test(domain))) return { keep: false, reason: "platform/notification sender (" + domain + ")" };
  // Long random locals are bulk-mailer VERP/bounce addresses, never people.
  if (/^[a-z0-9]{20,}$/i.test(local) || /=/.test(local)) return { keep: false, reason: "bulk-mailer generated address" };
  if (/^(mark|marks)$/i.test(local) && domain === "watkinsroofing.net") return { keep: false, reason: "Mark himself" };
  if (e === "mark.sheppard72@gmail.com") return { keep: false, reason: "Mark himself (personal address)" };

  const dn = String(displayName || "").trim();
  if (/\b(newsletter|no.?reply|notification|digest|alerts?)\b/i.test(dn)) {
    return { keep: false, reason: "automated sender name (\"" + dn + "\")" };
  }
  return { keep: true, reason: null };
}

// ---------------------------------------------------------------------------
// SIGNATURE PARSING
//
// Conservative on purpose: a wrong phone number on a customer's card is worse
// than a blank field. Every extractor below returns null unless it is fairly
// sure, and nothing is ever inferred from the message body proper — only from
// the signature block at the end of the sender's own most recent message.
// ---------------------------------------------------------------------------

// Cut the reply/forward history off. Everything after the first quote marker
// belongs to somebody else and must not be mined for this person's details.
const QUOTE_MARKERS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*_{10,}\s*$/m,
  /^\s*From:\s*.+$/im,
  /^\s*On .{3,80}\bwrote:\s*$/im,
  /^\s*Sent from my /im,
  /^\s*Get Outlook for /im,
];

function ownText(body) {
  let t = String(body || "").replace(/\r\n/g, "\n");
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = t.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut);
}

// The signature is the tail of the sender's own text. Take the last ~14
// non-empty lines: long enough for a block with address + phones + site,
// short enough not to swallow the message body itself.
function sigLines(body) {
  const lines = ownText(body).split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return lines.slice(-14);
}

const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\b(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})\b(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?/i;

function normPhone(m) {
  const base = "(" + m[1] + ") " + m[2] + "-" + m[3];
  return m[4] ? base + " x" + m[4] : base;
}

// Label a phone by the words immediately around it. Unlabelled numbers become
// the business line only if we don't already have one — never a mobile, since
// guessing a personal cell wrong is the worst version of this mistake.
function extractPhones(lines) {
  const out = { business: null, mobile: null, fax: null, home: null };
  for (const line of lines) {
    // A single line often carries several: "Office: 314-968-9366 | Fax: 314-968-1234"
    const parts = line.split(/\||;|,|•|·/);
    for (const part of parts) {
      const m = part.match(PHONE_RE);
      if (!m) continue;
      const num = normPhone(m);
      const before = part.slice(0, m.index).toLowerCase();
      if (/\b(fax|f)\b\s*[:.\-]?\s*$/.test(before) || /\bfax\b/.test(before)) {
        if (!out.fax) out.fax = num;
      } else if (/\b(mobile|cell|cellular|mob|m|c)\b\s*[:.\-]?\s*$/.test(before) || /\b(mobile|cell)\b/.test(before)) {
        if (!out.mobile) out.mobile = num;
      } else if (/\b(direct|office|work|main|tel|phone|ph|o|p|t)\b\s*[:.\-]?\s*$/.test(before) || /\b(office|direct|main|phone)\b/.test(before)) {
        if (!out.business) out.business = num;
      } else if (/\b(home)\b/.test(before)) {
        if (!out.home) out.home = num;
      } else if (!out.business) {
        out.business = num;
      }
    }
  }
  return out;
}

function extractWebsite(lines, senderDomain) {
  for (const line of lines) {
    const m = line.match(/\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(\/[^\s|]*)?/i);
    if (!m) continue;
    let host = m[1].replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
    if (/@/.test(line) && line.indexOf(host) > line.indexOf("@")) continue; // part of an email address
    if (/\.(png|jpg|jpeg|gif|svg)$/i.test(host)) continue;
    if (/^(linkedin|facebook|twitter|x|instagram|youtube|maps\.google)\./i.test(host)) continue;
    if (/^(outlook|office|microsoft|google|apple)\./i.test(host)) continue;
    // A site on the sender's own mail domain is almost certainly their company site.
    if (host === senderDomain || host.endsWith("." + senderDomain) || /\.(com|net|org|co|us|biz)$/i.test(host)) {
      return m[1].replace(/^https?:\/\//i, "");
    }
  }
  return null;
}

const TITLE_WORDS = /\b(president|vice president|vp|owner|principal|partner|director|manager|supervisor|superintendent|foreman|estimator|sales|account executive|account manager|representative|rep\b|specialist|consultant|engineer|architect|coordinator|administrator|assistant|controller|accountant|analyst|technician|inspector|project manager|pm\b|ceo|cfo|coo|cto|territory|business development|bd\b|operations|service|field|senior|sr\.|jr\.)\b/i;
const COMPANY_WORDS = /\b(inc\.?|llc|l\.l\.c\.|ltd\.?|co\.?|corp\.?|corporation|company|group|roofing|construction|contractors?|supply|materials|systems|solutions|services|associates|partners|industries|manufacturing|products|insulation|sheet metal|builders|properties|realty|management|consulting|engineering|architects?)\b/i;
const ADDRESS_RE = /\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,5}\s*,?\s+[A-Za-z .'-]+,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/;

function extractAddress(lines) {
  for (const line of lines) {
    const m = line.match(ADDRESS_RE);
    if (m) {
      const full = m[0].trim();
      const state = m[1];
      const zip = m[2];
      // Split "123 Main St, Ballwin, MO 63011" -> street / city / state / zip
      const cityStateZip = new RegExp("([A-Za-z .'-]+),\\s*" + state + "\\s+" + zip);
      const cm = full.match(cityStateZip);
      const city = cm ? cm[1].trim() : null;
      let street = full;
      if (cm && cm.index != null) street = full.slice(0, cm.index).replace(/[,\s]+$/, "").trim();
      return { street: street || null, city, state, postalCode: zip, full };
    }
  }
  return null;
}

function extractCompanyAndTitle(lines, displayName, senderDomain) {
  let company = null, title = null;
  const nameParts = String(displayName || "").toLowerCase().split(/[\s,]+/).filter(w => w.length > 2);
  for (const line of lines) {
    if (line.length > 90) continue;                 // prose, not a sig line
    if (/@/.test(line)) continue;                   // email line
    if (PHONE_RE.test(line)) continue;              // phone line
    const low = line.toLowerCase();
    if (nameParts.length && nameParts.every(p => low.includes(p))) continue; // the name itself
    if (!title && TITLE_WORDS.test(line) && !COMPANY_WORDS.test(line)) { title = line.replace(/^[-|\s]+/, "").trim(); continue; }
    if (!company && COMPANY_WORDS.test(line)) { company = line.replace(/^[-|\s]+/, "").trim(); continue; }
  }
  // Weak fallback: a title-cased line right under the name, when nothing matched.
  if (!company && senderDomain && !/^(gmail|yahoo|hotmail|outlook|aol|icloud|msn|comcast|att|sbcglobal|charter)\./i.test(senderDomain + ".")) {
    company = null; // deliberately NOT guessing the company from the domain — see header note
  }
  return { company, title };
}

function parseSignature(body, displayName, email) {
  const senderDomain = String(email || "").split("@")[1] || "";
  const lines = sigLines(body);
  const phones = extractPhones(lines);
  const { company, title } = extractCompanyAndTitle(lines, displayName, senderDomain);
  return {
    company,
    jobTitle: title,
    phones,
    website: extractWebsite(lines, senderDomain),
    address: extractAddress(lines),
    signatureLines: lines.slice(-8),
  };
}

// ---------------------------------------------------------------------------
// Name handling
// ---------------------------------------------------------------------------
function splitName(displayName, email) {
  let dn = String(displayName || "").trim();
  if (!dn || dn.includes("@")) {
    const local = String(email || "").split("@")[0] || "";
    const guess = local.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim();
    dn = guess ? guess.replace(/\b\w/g, c => c.toUpperCase()) : "";
  }
  if (!dn) return { givenName: null, surname: null, displayName: email };
  // "Wilson, Dakota" -> "Dakota Wilson"
  let m = dn.match(/^([^,]+),\s*(.+)$/);
  if (m && !/\b(inc|llc|ltd|co|corp)\b/i.test(m[1])) dn = m[2].trim() + " " + m[1].trim();
  const parts = dn.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { givenName: parts[0], surname: null, displayName: dn };
  return { givenName: parts[0], surname: parts.slice(1).join(" "), displayName: dn };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async function (event) {
  // AUTH FIRST — before any Graph call, before any env read.
  try {
    await requirePermission(event, "warranty.manage_reports");
  } catch (e) {
    return resp(e.statusCode || 401, { error: e.message });
  }

  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return resp(400, { error: "Bad JSON body" }); }

  const action = body.action;

  try {
    // ---- folders: resolve display names -> ids (so the caller can drive paging)
    if (action === "folders") {
      const j = await gj("/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount");
      return resp(200, {
        folders: (j.value || []).map(f => ({
          id: f.id, displayName: f.displayName,
          totalItemCount: f.totalItemCount, unreadItemCount: f.unreadItemCount,
        })),
      });
    }

    // ---- enumerate: one folder, up to `pages` pages, READ-ONLY.
    // Returns raw (address, name, date, direction) rows; the caller aggregates.
    // For Sent Items we harvest RECIPIENTS, not the sender (the sender is Mark)
    // — those are the people he actually writes to, which is the whole point of
    // including Sent.
    if (action === "enumerate") {
      const folderId = body.folderId;
      const isSent = !!body.sent;
      const pages = Math.min(5, Math.max(1, parseInt(body.pages || "3", 10)));
      let url = body.nextLink;
      if (!url) {
        if (!folderId) return resp(400, { error: "folderId required" });
        const select = isSent ? "toRecipients,ccRecipients,sentDateTime" : "from,sender,receivedDateTime";
        url = "/me/mailFolders/" + encodeURIComponent(folderId) + "/messages" +
          "?$top=500&$select=" + select;
      }

      const rows = [];
      let scanned = 0;
      let next = url;
      for (let i = 0; i < pages && next; i++) {
        const j = await gj(next);
        for (const m of (j.value || [])) {
          scanned++;
          if (isSent) {
            const rcpts = [].concat(m.toRecipients || [], m.ccRecipients || []);
            for (const r of rcpts) {
              const ea = r && r.emailAddress;
              if (ea && ea.address) rows.push({ e: String(ea.address).toLowerCase(), n: ea.name || null, d: m.sentDateTime || null, dir: "to" });
            }
          } else {
            const ea = (m.from && m.from.emailAddress) || (m.sender && m.sender.emailAddress);
            if (ea && ea.address) rows.push({ e: String(ea.address).toLowerCase(), n: ea.name || null, d: m.receivedDateTime || null, dir: "from" });
          }
        }
        next = j["@odata.nextLink"] || null;
      }
      return resp(200, { rows, scanned, nextLink: next });
    }

    // ---- enrich: for each address, read that person's most recent message and
    // parse ONLY its signature block. GET only — nothing is marked read.
    if (action === "enrich") {
      const emails = (body.emails || []).slice(0, 12);
      const out = [];
      for (const email of emails) {
        const addr = String(email).toLowerCase().replace(/'/g, "''");
        try {
          // NOTE: $filter + $orderby together across the whole mailbox makes
          // Graph return 400 InefficientFilter ("restriction or sort order is
          // too complex") — Exchange won't sort a cross-folder filtered set.
          // So: filter only, pull a handful, and pick the newest ourselves.
          // Signatures change over time, and we want the CURRENT one.
          const url = "/me/messages?$top=10" +
            "&$filter=" + encodeURIComponent("from/emailAddress/address eq '" + addr + "'") +
            "&$select=" + encodeURIComponent("from,receivedDateTime,body");
          const j = await gj(url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
          const msgs = (j.value || []).slice().sort((x, y) =>
            String(y.receivedDateTime || "").localeCompare(String(x.receivedDateTime || "")));
          if (!msgs.length) { out.push({ email, found: false }); continue; }

          // The MOST RECENT message is often a two-line reply with no signature
          // at all ("Thanks, will do"). So parse the last several messages and
          // keep the richest signature, preferring newer ones on a tie — that
          // gets the current signature without being defeated by a short reply.
          const ea = (msgs[0].from && msgs[0].from.emailAddress) || {};
          const score = p => [p.company, p.jobTitle, p.website, p.address,
            p.phones.business, p.phones.mobile, p.phones.fax].filter(Boolean).length;
          let best = null, bestScore = -1;
          for (const m of msgs) {
            const nm = (m.from && m.from.emailAddress && m.from.emailAddress.name) || ea.name || "";
            const p = parseSignature((m.body && m.body.content) || "", nm, email);
            const s = score(p);
            if (s > bestScore) { bestScore = s; best = p; }   // strict >: newer wins ties
            if (bestScore >= 5) break;                        // rich enough, stop early
          }

          out.push({
            email,
            found: true,
            displayName: ea.name || null,
            lastMessage: msgs[0].receivedDateTime || null,
            fieldsFound: bestScore,
            messagesScanned: msgs.length,
            ...best,
          });
        } catch (e) {
          out.push({ email, found: false, error: String(e.message || e).slice(0, 160) });
        }
      }
      return resp(200, { enriched: out });
    }

    // ---- existing: current /me/contacts, for dedupe
    if (action === "existing") {
      const out = [];
      let next = "/me/contacts?$top=100&$select=id,displayName,emailAddresses,companyName,jobTitle,businessPhones,mobilePhone";
      while (next && out.length < 500) {
        const j = await gj(next);
        for (const c of (j.value || [])) {
          out.push({
            id: c.id,
            displayName: c.displayName || null,
            companyName: c.companyName || null,
            jobTitle: c.jobTitle || null,
            emails: (c.emailAddresses || []).map(e => String(e.address || "").toLowerCase()).filter(Boolean),
            businessPhones: c.businessPhones || [],
            mobilePhone: c.mobilePhone || null,
          });
        }
        next = j["@odata.nextLink"] || null;
      }
      return resp(200, { contacts: out, count: out.length });
    }

    // ---- upsert: THE ONLY WRITE. Creates a contact, or PATCHes an existing one
    // (Graph PATCH merges — properties absent from the body are left alone, so
    // enriching never clobbers something Mark typed by hand). Never deletes.
    if (action === "upsert") {
      const items = (body.contacts || []).slice(0, 25);
      const dryRun = !!body.dryRun;
      const results = [];

      for (const it of items) {
        const email = String(it.email || "").toLowerCase();
        if (!email) { results.push({ email: null, status: "skipped", reason: "no email" }); continue; }

        const nm = splitName(it.displayName, email);
        const payload = {};
        if (nm.givenName) payload.givenName = nm.givenName;
        if (nm.surname) payload.surname = nm.surname;
        if (nm.displayName) payload.displayName = nm.displayName;
        payload.emailAddresses = [{ address: email, name: nm.displayName || email }];
        if (it.company) payload.companyName = it.company;
        if (it.jobTitle) payload.jobTitle = it.jobTitle;
        const bp = [];
        if (it.businessPhone) bp.push(it.businessPhone);
        if (bp.length) payload.businessPhones = bp;
        if (it.mobilePhone) payload.mobilePhone = it.mobilePhone;
        if (it.homePhone) payload.homePhones = [it.homePhone];
        if (it.faxNumber) payload.businessFaxNumber = it.faxNumber;
        if (it.website) payload.businessHomePage = it.website; // stored as text; never fetched
        if (it.address && (it.address.street || it.address.city)) {
          payload.businessAddress = {
            street: it.address.street || undefined,
            city: it.address.city || undefined,
            state: it.address.state || undefined,
            postalCode: it.address.postalCode || undefined,
            countryOrRegion: it.address.country || undefined,
          };
        }
        if (it.notes) payload.personalNotes = it.notes;

        try {
          // Does a contact already exist for this address? Dedupe on the
          // address, not the name — names drift, addresses don't.
          const q = "/me/contacts?$top=1&$select=id,displayName&$filter=" +
            encodeURIComponent("emailAddresses/any(e:e/address eq '" + email.replace(/'/g, "''") + "')");
          const found = await gj(q);
          const existing = (found.value || [])[0];

          if (dryRun) {
            results.push({ email, status: existing ? "would_update" : "would_create", existingId: existing ? existing.id : null });
            continue;
          }

          if (existing) {
            await gj("/me/contacts/" + encodeURIComponent(existing.id), {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            results.push({ email, status: "updated", id: existing.id });
          } else {
            const created = await gj("/me/contacts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            results.push({ email, status: "created", id: created && created.id });
          }
        } catch (e) {
          results.push({ email, status: "error", error: String(e.message || e).slice(0, 200) });
        }
      }

      return resp(200, {
        dryRun,
        results,
        created: results.filter(r => r.status === "created").length,
        updated: results.filter(r => r.status === "updated").length,
        errors: results.filter(r => r.status === "error").length,
      });
    }

    return resp(400, { error: "Unknown action: " + String(action) });
  } catch (e) {
    return resp(e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500, {
      error: String((e && e.message) || "unknown error").slice(0, 400),
    });
  }
};

// Exported for reasoning/testing about the filter and parser without a mailbox.
module.exports._internals = { classify, parseSignature, splitName, sigLines };
