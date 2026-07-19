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
//   * Mail is never SENT and never DELETED. Reading is GET-only; it NEVER
//     PATCHes `isRead`, and reading a message via Graph does not mark it read
//     as a side effect (that is an Outlook-client behaviour, not a Graph one)
//     — so the 322 unread in Mark's inbox stay unread. It never sends,
//     forwards, or marks mail read. Three additive mail writes exist, each
//     documented at its own handler and none of which can send or delete:
//     `move` (move-to-folder only), `rules_create` (additive move-to-folder
//     inbox rules), and `create_draft` (compose a Drafts-only reply or new
//     message for Mark to review and send HIMSELF — never auto-sent). The
//     delegated token holds Mail.ReadWrite and has NO Mail.Send, so a send is
//     impossible even in principle; this code adds no send path regardless.
//   * The ONLY writes are to /me/contacts, and only via `upsert`, and only for
//     the exact payload the caller passes. Existing contacts are PATCHed
//     (merge — Graph only overwrites the properties present in the body), never
//     replaced or deleted.
//   * `dryRun: true` on upsert reports what it *would* do and writes nothing.
//   * It never returns the delegated token, the refresh token, or the client
//     secret. It returns signature-derived contact fields and a few raw
//     signature lines (Mark's own mail, shown back to Mark). The `mail_read`
//     action DOES return full message bodies — but only Mark's own mail, back
//     to Mark, for his morning brief; it is READ-ONLY (GET, never marks read).
//   * URLs found in signatures are recorded as text into the contact's
//     businessHomePage. Nothing here ever fetches or follows them.
//
// MORNING-BRIEF ASSISTANT actions (added on this same delegated path — no new
// credential, no new consent):
//   * `mail_read` — READ-ONLY full message bodies (subject + from + date + body
//     text + preview) for the brief to quote. GET only; never marks read.
//   * `calendar_list` / `calendar_create` — read events / add an event to Mark's
//     OWN calendar (additive; no attendees ⇒ no invite ⇒ no outbound send; no
//     update/delete action exists). These require the delegated Calendars.ReadWrite
//     scope, which the RoofOps app registration does NOT hold yet. Until Steve
//     adds it + grants admin consent and Mark re-runs ms-auth-start, both
//     calendar actions NO-OP with a clear "calendar scope not granted yet"
//     message (gated via hasCalendarScope()) rather than failing with a raw 403.
const { requirePermission } = require("./lib/authGuard");
const { graphFetchDelegated, hasCalendarScope } = require("./lib/graphDelegatedAuth");

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
  // Shared/role mailboxes at suppliers and manufacturers. These reply, so they
  // look like people, but there is no person behind them to put on a card.
  /^warranty/i, /^repairforwarranty$/i, /^claims?$/i, /^orders?$/i, /^dispatch$/i,
  /^scheduling$/i, /^estimating$/i, /^bids?$/i, /^quotes?$/i, /^purchasing$/i,
  /^shipping$/i, /^returns?$/i, /^subscriptions?$/i, /^careers?$/i, /^jobs?$/i,
  /^(ap|ar|hr)$/i, /^payroll$/i, /^accounting$/i, /^customerservice$/i, /^service$/i,
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

// Find the SIGNATURE BLOCK, not merely "the last few lines".
//
// Naively taking the tail of the message drags prose in with it — a two-line
// reply has no signature at all, and "Yes, and the CO for wall panels..." will
// happily match a company regex on the word "CO". So anchor the block: find an
// explicit delimiter ("--"), or the last line that is just the sender's own
// name, or the first line carrying a phone/contact marker, and take from there
// down. If no anchor exists, there is NO signature — return nothing rather than
// inventing one out of the body text.
function sigLines(body, displayName) {
  const lines = ownText(body).split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!lines.length) return [];

  const name = String(displayName || "").trim().toLowerCase();
  const nameBits = name.replace(/,/g, " ").split(/\s+/).filter(w => w.length > 2);

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const low = l.toLowerCase();
    if (/^--+\s*$/.test(l) || /^(thanks|thank you|regards|best|sincerely|cheers)[,!.]?$/i.test(l)) {
      start = i + 1; // delimiter / sign-off: the block starts after it
      continue;
    }
    // A line that is JUST the person's name (not a sentence containing it).
    if (nameBits.length >= 2 && l.length <= 45 && nameBits.every(b => low.includes(b))) {
      start = i;
    }
  }
  // Fallback anchor: the first line that carries a phone or a contact label.
  if (start < 0) {
    for (let i = 0; i < lines.length; i++) {
      if (PHONE_RE.test(lines[i]) || /\b(office|mobile|cell|direct|fax|main)\b\s*[:.\-]/i.test(lines[i])) {
        start = Math.max(0, i - 2);
        break;
      }
    }
  }
  if (start < 0 || start >= lines.length) return [];   // no signature — say so
  return lines.slice(start, start + 12);
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

// SaaS/app/tracking hosts that turn up in message bodies and footers but are
// never the sender's own website. (Wade Sanderson is not employed by CompanyCam.)
const NOT_A_WEBSITE = /^(app\.|www\.)?(companycam|salesforce|force|my\.salesforce|docusign|calendly|dropbox|box|onedrive|sharepoint|google|goo\.gl|bit\.ly|linkedin|facebook|twitter|instagram|youtube|zoom|teams|outlook|office|microsoft|apple|amazonaws|mailchimp|constantcontact|sendgrid|hubspot|smartsheet|dotloop|adobe|acrobat|wetransfer|sharefile|egnyte|procore|buildertrend)\b/i;

function extractWebsite(lines, senderDomain) {
  let fallback = null;
  for (const line of lines) {
    const m = line.match(/\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(\/[^\s|]*)?/i);
    if (!m) continue;
    let host = m[1].replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase();
    if (/@/.test(line) && line.indexOf(host) > line.indexOf("@")) continue; // part of an email address
    if (/\.(png|jpg|jpeg|gif|svg)$/i.test(host)) continue;
    if (NOT_A_WEBSITE.test(host)) continue;
    if (!/\.(com|net|org|co|us|biz|info|io)$/i.test(host)) continue;
    // A site on the sender's own mail domain is almost certainly their company
    // site — take it outright. Anything else is only a fallback.
    if (host === senderDomain || host.endsWith("." + senderDomain) || senderDomain.endsWith("." + host)) {
      return host;
    }
    if (!fallback) fallback = host;
  }
  return fallback;
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

// Prose, not a label. A signature line is a fragment ("General Superintendent",
// "Watkins Roofing Inc."); a body line is a sentence ("Yes, and the CO for wall
// panels is approved"). Reject anything that reads like a sentence — that one
// check is what stops COMPANY_WORDS matching the "CO" in "the CO for wall".
function looksLikeProse(line) {
  if (/[.?!]\s+\S/.test(line)) return true;                 // mid-line sentence break
  if (/\b(i|we|you|they|it|he|she)\b\s+\b(will|can|have|has|am|are|is|was|were|think|need|want|would|should|could)\b/i.test(line)) return true;
  if (/^(yes|no|ok|okay|sure|thanks|thank|please|sorry|hi|hello|hey|got|per|attached|see|let|here|that|this|there|and|but|so|if|when)\b/i.test(line)) return true;
  if (/\?$/.test(line)) return true;
  if (line.split(/\s+/).length > 9) return true;            // too long to be a label
  if (/^[a-z]/.test(line)) return true;                     // labels are capitalised
  return false;
}

function extractCompanyAndTitle(lines, displayName, senderDomain) {
  let company = null, title = null;
  const nameParts = String(displayName || "").toLowerCase().replace(/,/g, " ").split(/\s+/).filter(w => w.length > 2);
  for (const line of lines) {
    if (line.length > 70) continue;
    if (/@/.test(line)) continue;                   // email line
    if (PHONE_RE.test(line)) continue;              // phone line
    if (looksLikeProse(line)) continue;             // body text, not a sig label
    const low = line.toLowerCase();
    if (nameParts.length && nameParts.every(p => low.includes(p))) continue; // the name itself

    // Title wins over company on an ambiguous line. "Roof Management
    // Coordinator" is a job, not an employer — but it trips COMPANY_WORDS on
    // "Management". Only a STRONG company marker (a legal suffix like Inc/LLC)
    // outranks a title match.
    const strongCompany = /\b(inc\.?|llc|l\.l\.c\.|ltd\.?|corp\.?|corporation|company|& sons|group|holdings)\b/i.test(line);
    if (!title && TITLE_WORDS.test(line) && !strongCompany) { title = line.replace(/^[-|\s]+/, "").trim(); continue; }
    if (!company && COMPANY_WORDS.test(line)) { company = line.replace(/^[-|\s]+/, "").trim(); continue; }
  }
  // Deliberately NOT guessing the company from the mail domain: "cletusbagby@
  // yahoo.com" does not work at Yahoo, and a plausible-looking wrong employer
  // on a customer's card is worse than a blank field.
  return { company, title };
}

function parseSignature(body, displayName, email) {
  const senderDomain = String(email || "").split("@")[1] || "";
  const lines = sigLines(body, displayName);
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
// INBOX RULE BUILDER — the safe, additive, move-only rule spec used by the
// rules_create action. Kept as a pure function so the guardrails can be unit
// tested without a mailbox.
//
// A caller rule may carry any of three condition arrays, matching the Graph
// messageRule predicate properties of the same name:
//   * senderContains  — substrings matched against the sender address/name
//   * subjectContains — substrings matched against the subject line
//   * bodyContains     — substrings matched against the body text
// Type-based auto-filing (Leaks / Invoices / Warranties …) lives on subject/
// body; sender-based filing is the original behaviour. All three are OR-combined
// by Graph, so any one hit files the mail — which is exactly why every keyword
// must be high-confidence (see the guardrail below).
//
// The action a built rule carries is ALWAYS move-only: moveToFolder +
// stopProcessingRules, both hard-coded here. There is no path that emits
// forward, redirect, delete, or markAsRead — regardless of what the caller
// sends. This preserves the file-wide never-send / never-delete guarantee.
const RULE_CONDITION_FIELDS = ["senderContains", "subjectContains", "bodyContains"];
const RULE_MIN_KEYWORD_LEN = 3;
// Tokens too broad to anchor a high-confidence auto-file rule. A subject/body
// rule keyed on any of these would sweep up unrelated mail, so we reject the
// whole rule rather than file mail wrongly.
const RULE_BROAD_TOKENS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "is", "it",
  "for", "re", "fw", "fwd", "hi", "hey", "fyi", "all", "you", "your", "www",
]);
// A bare mail domain (gmail.com, yahoo.com, acme.com, "@acme.com") is a fine
// SENDER anchor — that is the whole point of senderContains — but inside a
// subject/body match it is over-broad (it would hit every quoted address), so
// it is rejected there only.
const RULE_BARE_DOMAIN_RE = /^@?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

// Returns a human-readable reason string if a keyword is unsafe for `field`,
// or null if it passes. field is one of RULE_CONDITION_FIELDS.
function ruleKeywordProblem(kw, field) {
  if (typeof kw !== "string") return "non-string keyword in " + field;
  const t = kw.trim();
  if (!t) return "empty keyword in " + field;
  if (t.length < RULE_MIN_KEYWORD_LEN) {
    return "keyword '" + t + "' in " + field + " is shorter than " + RULE_MIN_KEYWORD_LEN + " chars";
  }
  if (RULE_BROAD_TOKENS.has(t.toLowerCase())) return "over-broad token '" + t + "' in " + field;
  if ((field === "subjectContains" || field === "bodyContains") && RULE_BARE_DOMAIN_RE.test(t)) {
    return "bare domain '" + t + "' in " + field + " is over-broad";
  }
  return null;
}

// Build the Graph messageRule payload for one caller rule, or return a skip
// reason. A rule is VALID only if it has a destinationId AND at least one
// non-empty, all-keywords-safe condition array among sender/subject/body.
// If ANY keyword fails a guardrail the whole rule is skipped — we never
// silently drop the bad keyword and file on the rest.
function buildInboxRule(r) {
  if (!r || !r.destinationId) return { skip: "needs destinationId" };
  const conditions = {};
  let total = 0;
  for (const field of RULE_CONDITION_FIELDS) {
    const raw = r[field];
    if (raw == null) continue;
    if (!Array.isArray(raw)) return { skip: field + " must be an array" };
    const cleaned = [];
    for (const kw of raw) {
      const problem = ruleKeywordProblem(kw, field);
      if (problem) return { skip: problem };
      cleaned.push(kw.trim());
    }
    if (cleaned.length) { conditions[field] = cleaned; total += cleaned.length; }
  }
  if (!total) {
    return { skip: "needs destinationId + at least one non-empty condition (senderContains/subjectContains/bodyContains)" };
  }
  return {
    matchCount: total,
    payload: {
      displayName: r.displayName,
      sequence: r.sequence,
      isEnabled: true,
      conditions,
      // HARD-CODED move-only action. Never forward/redirect/delete/markRead.
      actions: { moveToFolder: r.destinationId, stopProcessingRules: true },
    },
  };
}

// ---------------------------------------------------------------------------
// DRAFT COMPOSITION — helpers for the `create_draft` action.
//
// create_draft only ever CREATES a draft (a reply draft via Graph's
// createReply, or a fresh message via POST /me/messages — Graph files both in
// Drafts). It never sends. Mark reviews every draft and sends it himself.
// These helpers are pure (no Graph, no I/O) so they can be unit-tested without
// a mailbox; they are exported on _internals below.
// ---------------------------------------------------------------------------

// Mark's house sign-off. Appended to a draft body unless the caller supplied a
// full formatted body (bodyHtml) or the text already signs off — so a morning
// routine that only writes the substance still produces a draft in his voice.
const SIGNOFF_TEXT = "Respectfully,\nMark";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Append the sign-off to plain-text body content, unless the text already ends
// with a "Respectfully" sign-off (idempotent — never doubles it).
function textWithSignoff(text) {
  const t = String(text == null ? "" : text).replace(/\s+$/, "");
  if (/(^|\n)\s*respectfully\b/i.test(t)) return t;   // already signed off
  return (t ? t + "\n\n" : "") + SIGNOFF_TEXT;
}

// Normalize a caller's recipient list into Graph's shape. Accepts bare address
// strings ("a@b.com") or objects ({address|email, name}); silently drops
// anything without a plausible "@" local so a typo can't become a bad send —
// and this is a DRAFT anyway, so Mark sees the recipients before anything goes.
function normalizeRecipients(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    let address = null, name = null;
    if (typeof r === "string") address = r;
    else if (r && typeof r === "object") { address = r.address || r.email || null; name = r.name || null; }
    address = String(address == null ? "" : address).trim();
    if (address.indexOf("@") < 1) continue;
    out.push({ emailAddress: name ? { address, name: String(name) } : { address } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MORNING-BRIEF helpers — pure (no Graph, no I/O), exported on _internals for
// unit testing without a mailbox.
// ---------------------------------------------------------------------------

// Map a Graph message resource to the compact row the brief consumes. `withBody`
// adds the full plain-text body (mail_read); otherwise only the short preview is
// returned. Nothing here can mark a message read — it only reshapes a GET result.
function mapMailMessage(m, opts) {
  opts = opts || {};
  const from = (m.from && m.from.emailAddress) || (m.sender && m.sender.emailAddress) || {};
  const row = {
    id: m.id,
    subject: (m.subject || "(no subject)"),
    from: { name: from.name || null, address: String(from.address || "").toLowerCase() || null },
    date: m.receivedDateTime || m.sentDateTime || null,
    // Output key is `read` (a plain boolean the brief can show), NOT an `isRead:`
    // key — an `isRead:` object key reads as a mark-as-read mutation and is
    // forbidden by the source-scan guardrail in contactsSyncCreateDraft.test.js.
    // This only READS the Graph field; nothing here ever writes it.
    read: !!m.isRead,
    preview: (m.bodyPreview || "").trim() || null,
    webLink: m.webLink || null,
  };
  if (opts.withBody) {
    row.body = ((m.body && m.body.content) || "").trim() || null;
    row.to = (m.toRecipients || []).map(r => (r.emailAddress && r.emailAddress.address) || null).filter(Boolean);
    row.cc = (m.ccRecipients || []).map(r => (r.emailAddress && r.emailAddress.address) || null).filter(Boolean);
  }
  return row;
}

// Graph resolves these well-known names in the folder path directly, so we hand
// them straight back rather than looking them up (e.g. Sent Items = "sentitems").
const WELL_KNOWN_FOLDERS = { inbox: 1, sentitems: 1, drafts: 1, deleteditems: 1, archive: 1, junkemail: 1, outbox: 1 };
// Resolve a mail folder by DISPLAY NAME (or a well-known name) to its id so a
// caller can list e.g. "Proposals" without first fetching the folder table.
// Checks well-known names, then top-level folders, then ONE level of child
// folders (via $expand). Returns null when nothing matches — the caller
// surfaces "folder not found" rather than guessing a wrong folder. READ-ONLY.
async function resolveFolderIdByName(name) {
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  const wk = wanted.toLowerCase().replace(/\s+/g, "");
  if (WELL_KNOWN_FOLDERS[wk]) return wk;
  const j = await gj("/me/mailFolders?$top=100&$select=id,displayName&$expand=childFolders($select=id,displayName)");
  const want = wanted.toLowerCase();
  for (const f of (j.value || [])) {
    if (String(f.displayName || "").toLowerCase() === want) return f.id;
    for (const c of (f.childFolders || [])) {
      if (String(c.displayName || "").toLowerCase() === want) return c.id;
    }
  }
  return null;
}

// Resolve a named window ("today" | "week") or an explicit {start,end} into the
// ISO boundaries /me/calendarView needs. `now` is injectable for deterministic
// tests. "today" = local midnight → next local midnight; "week" = now → +7 days.
// Explicit start/end (ISO strings) win over the named range.
function resolveCalendarRange(input, now) {
  input = input || {};
  now = now instanceof Date ? now : new Date();
  if (input.start && input.end) {
    const s = new Date(input.start), e = new Date(input.end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      const err = new Error("calendar_list: invalid start/end date"); err.statusCode = 400; throw err;
    }
    return { startDateTime: s.toISOString(), endDateTime: e.toISOString() };
  }
  const range = String(input.range || "today").toLowerCase();
  if (range === "week") {
    return { startDateTime: now.toISOString(), endDateTime: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString() };
  }
  const startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startDateTime: startLocal.toISOString(), endDateTime: endLocal.toISOString() };
}

// Flatten a Graph event into the brief's row shape.
function mapEvent(e) {
  const org = (e.organizer && e.organizer.emailAddress) || {};
  return {
    id: e.id,
    subject: e.subject || "(no title)",
    start: (e.start && e.start.dateTime) || null,
    end: (e.end && e.end.dateTime) || null,
    timeZone: (e.start && e.start.timeZone) || null,
    isAllDay: !!e.isAllDay,
    location: (e.location && e.location.displayName) || null,
    organizer: { name: org.name || null, address: String(org.address || "").toLowerCase() || null },
    attendees: (e.attendees || []).map(a => ({
      name: (a.emailAddress && a.emailAddress.name) || null,
      address: (a.emailAddress && String(a.emailAddress.address || "").toLowerCase()) || null,
      response: (a.status && a.status.response) || null,
    })),
    preview: (e.bodyPreview || "").trim() || null,
    webLink: e.webLink || null,
  };
}

// A YYYY-MM-DD date, taken from the leading 10 chars of a date/ISO string when
// present (so "2026-07-20" and "2026-07-20T00:00:00Z" both stay the 20th — no
// timezone shift), else from a Date's LOCAL components. Never toISOString (that
// would convert to UTC and can roll an all-day date back a day).
function dateOnly(v) {
  const s = String(v == null ? "" : v);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Build the POST /me/events payload for calendar_create. Pure + validating:
// throws a 400-tagged error when subject or a start/end pair is missing/invalid.
//
// ADDITIVE + NON-SENDING by construction: this shape can only CREATE an event on
// Mark's OWN calendar. It carries no id (cannot target/modify/delete an existing
// event) and DELIBERATELY has no `attendees` field — an event with attendees
// makes Graph email invitations immediately, which would be an outbound "send"
// this integration must never do. If Mark wants to invite people he adds them in
// Outlook after reviewing the event.
function buildEventPayload(input) {
  input = input || {};
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) { const e = new Error("calendar_create needs a subject"); e.statusCode = 400; throw e; }

  const isAllDay = !!input.isAllDay;
  const tz = input.timeZone || "America/Chicago"; // Watkins is in the Central zone
  const ev = { subject };

  if (isAllDay) {
    if (!input.start || !input.end) { const e = new Error("all-day calendar_create needs start and end dates"); e.statusCode = 400; throw e; }
    const sd = dateOnly(input.start), ed = dateOnly(input.end);
    if (!sd || !ed) { const e = new Error("all-day calendar_create needs valid start/end dates"); e.statusCode = 400; throw e; }
    // Graph uses an EXCLUSIVE end for all-day events, so end must be a later day
    // than start (a single all-day event on the 20th is start=20, end=21).
    if (ed <= sd) { const e = new Error("all-day calendar_create end date must be after start date"); e.statusCode = 400; throw e; }
    ev.isAllDay = true;
    ev.start = { dateTime: sd + "T00:00:00", timeZone: tz };
    ev.end = { dateTime: ed + "T00:00:00", timeZone: tz };
  } else {
    if (!input.start || !input.end) { const e = new Error("calendar_create needs start and end date-times"); e.statusCode = 400; throw e; }
    const s = new Date(input.start), en = new Date(input.end);
    if (isNaN(s.getTime()) || isNaN(en.getTime())) { const e = new Error("calendar_create needs valid start/end date-times"); e.statusCode = 400; throw e; }
    if (en.getTime() <= s.getTime()) { const e = new Error("calendar_create end must be after start"); e.statusCode = 400; throw e; }
    ev.start = { dateTime: s.toISOString(), timeZone: tz };
    ev.end = { dateTime: en.toISOString(), timeZone: tz };
  }

  if (typeof input.location === "string" && input.location.trim()) ev.location = { displayName: input.location.trim() };
  if (typeof input.body === "string" && input.body.trim()) ev.body = { contentType: "Text", content: input.body.trim() };
  return ev;
}

// The no-op response returned by calendar actions until the delegated grant
// actually carries Calendars.ReadWrite. Kept as one place so both actions speak
// with one voice, and so a test can assert the exact shape.
const CALENDAR_NOT_GRANTED = {
  calendarScopeGranted: false,
  error: "calendar scope not granted yet — the RoofOps M365 app does not have " +
    "delegated Calendars.ReadWrite. Steve must add it to the app registration and " +
    "grant admin consent, then Mark re-runs ms-auth-start to refresh the token. " +
    "Until then, calendar read/create is unavailable (mail actions are unaffected).",
};

// ---------------------------------------------------------------------------
// CONTACT PAGING LIMIT — for the `existing` action.
//
// This used to be a bare `out.length < 500` in the paging loop, and the reply
// reported `count: out.length` with no indication that the walk had stopped
// early. That is a cap that LIES: once the address book passed 500, a caller
// diffing "who do I already have?" got a truthful-looking answer that was
// silently incomplete.
//
// It bit for real on 2026-07-19. Backfilling contact cards for the field crew
// pushed the book from 444 past 500; the very next diff reported people as
// missing who demonstrably had cards (upsert found and PATCHed them), because
// they sorted beyond the 500th row and were never fetched.
//
// A cap still has to exist — walking an arbitrarily large address book inside
// a Lambda is its own failure mode — so the fix is three parts, and the third
// matters most:
//   1. Raise the default far above any plausible Watkins address book.
//   2. Let the caller ask for a different one, hard-ceilinged.
//   3. REPORT truncation (`truncated` + `hasMore`), so a partial result can
//      never again be mistaken for a complete one.
const DEFAULT_CONTACTS_LIMIT = 5000;
const MAX_CONTACTS_LIMIT = 25000;
// Pages are 100 contacts each; this is a belt-and-braces stop so a pathological
// nextLink chain can't spin forever even if the row count never advances.
const MAX_CONTACT_PAGES = 400;

// Clamp a caller-supplied limit. Anything unparseable falls back to the
// default rather than becoming NaN (which would make every `<` comparison
// false and silently return zero contacts). Pure — exported for tests.
function contactsLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CONTACTS_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONTACTS_LIMIT;
  return Math.min(n, MAX_CONTACTS_LIMIT);
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

    // ---- existing: current /me/contacts, for dedupe.
    // Pages until the address book is exhausted or `limit` is reached (see
    // contactsLimit above for why the old silent 500 cap was a bug). ALWAYS
    // reports whether it stopped early: `truncated` is the flag a caller must
    // check before treating this as the complete set.
    if (action === "existing") {
      const limit = contactsLimit(body.limit);
      const out = [];
      let pages = 0;
      let next = "/me/contacts?$top=100&$select=id,displayName,emailAddresses,companyName,jobTitle,businessPhones,mobilePhone";
      while (next && out.length < limit && pages < MAX_CONTACT_PAGES) {
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
        pages++;
      }
      // truncated === "there are more contacts we did not fetch". A caller
      // diffing against this set MUST NOT conclude "missing" when truncated.
      const truncated = !!next;
      return resp(200, {
        contacts: out,
        count: out.length,
        limit,
        pagesWalked: pages,
        truncated,
        hasMore: truncated,
        ...(truncated ? {
          warning: "Result is INCOMPLETE — stopped at limit " + limit + ". Do not treat a " +
            "contact absent from this list as missing; raise `limit` or verify individually " +
            "(upsert with dryRun:true reports would_create vs would_update per address).",
        } : {}),
      });
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
        // Microsoft Graph's `contact` resource has NO fax property — fax is an
        // Outlook/MAPI-only field, and sending `businessFaxNumber` makes Graph
        // reject the whole payload with 400 UnableToDeserializePostBody. So a
        // fax found in a signature is preserved as a note rather than dropped
        // on the floor (or silently mislabelled as another phone type).
        const notes = [];
        if (it.faxNumber) notes.push("Fax: " + it.faxNumber);
        if (it.notes) notes.push(it.notes);
        if (notes.length) payload.personalNotes = notes.join("\n");

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

    // ---- diag: WHERE do the contacts actually live? /me/contacts only ever
    // reads the DEFAULT contacts folder, so "443 in /me/contacts" and "Mark
    // sees 155 in Outlook" can both be true if something is paging, filtering,
    // or if there are extra contact folders. Count everything, everywhere.
    if (action === "diag") {
      const out = { defaultFolder: {}, contactFolders: [] };

      // Authoritative server-side count of the default folder.
      try {
        const c = await gj("/me/contacts/$count", { headers: { ConsistencyLevel: "eventual" } });
        out.defaultFolder.odataCount = c;
      } catch (e) { out.defaultFolder.odataCountError = String(e.message || e).slice(0, 120); }

      // Independently: actually page through and count, so we don't trust one number.
      let n = 0, pages = 0;
      let next = "/me/contacts?$top=100&$select=id";
      while (next && pages < 40) {
        const j = await gj(next);
        n += (j.value || []).length;
        next = j["@odata.nextLink"] || null;
        pages++;
      }
      out.defaultFolder.pagedCount = n;
      out.defaultFolder.pagesWalked = pages;

      // Any non-default contact folders? (A contact in one of these is invisible
      // in the default "Your contacts" view.)
      const f = await gj("/me/contactFolders?$top=50&$select=id,displayName,parentFolderId");
      for (const folder of (f.value || [])) {
        let cnt = null;
        try {
          const jj = await gj("/me/contactFolders/" + encodeURIComponent(folder.id) + "/contacts?$top=1&$count=true",
            { headers: { ConsistencyLevel: "eventual" } });
          cnt = jj["@odata.count"] != null ? jj["@odata.count"] : null;
        } catch (e) { /* count unsupported here; leave null */ }
        out.contactFolders.push({ id: folder.id, displayName: folder.displayName, count: cnt });
      }
      return resp(200, out);
    }

    // ---- masterCategories: read (and optionally create) Outlook colour
    // categories so `categories` on a contact renders natively with a colour
    // instead of appearing as an unknown string.
    if (action === "categories_setup") {
      const want = body.categories || [];   // [{name, color}]
      const cur = await gj("/me/outlook/masterCategories?$top=100");
      const have = new Set((cur.value || []).map(c => String(c.displayName)));
      const created = [];
      for (const w of want) {
        if (have.has(w.name)) continue;
        try {
          await gj("/me/outlook/masterCategories", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: w.name, color: w.color }),
          });
          created.push(w.name);
        } catch (e) { /* already exists / race — harmless */ }
      }
      const after = await gj("/me/outlook/masterCategories?$top=100");
      return resp(200, { created, all: (after.value || []).map(c => ({ name: c.displayName, color: c.color })) });
    }

    // ---- categorize: PATCH `categories` onto existing contacts. Touches ONLY
    // the categories property — never the name, phones, or anything Mark typed.
    if (action === "categorize") {
      const items = (body.items || []).slice(0, 40);
      const results = [];
      for (const it of items) {
        try {
          await gj("/me/contacts/" + encodeURIComponent(it.id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ categories: [it.category] }),
          });
          results.push({ id: it.id, category: it.category, status: "ok" });
        } catch (e) {
          results.push({ id: it.id, status: "error", error: String(e.message || e).slice(0, 140) });
        }
      }
      return resp(200, { ok: results.filter(r => r.status === "ok").length, errors: results.filter(r => r.status === "error") });
    }

    // ---- rules_list: READ-ONLY. Reports the inbox rules that already exist.
    // This function has NO action that creates, edits, enables or deletes a
    // rule — the rule plan is produced for a human to approve, and activating
    // it is deliberately not something this code can do.
    if (action === "rules_list") {
      const j = await gj("/me/mailFolders/inbox/messageRules");
      return resp(200, {
        rules: (j.value || []).map(r => ({
          id: r.id, displayName: r.displayName, sequence: r.sequence,
          isEnabled: r.isEnabled, hasError: r.hasError,
          conditions: r.conditions || null, actions: r.actions || null,
        })),
      });
    }

    // ---- folder_create: create a top-level mail folder if it doesn't already
    // exist. Idempotent — an existing folder of the same name is returned as-is
    // rather than duplicated. Creating a folder moves no mail by itself.
    if (action === "folder_create") {
      const name = String(body.displayName || "").trim();
      if (!name) return resp(400, { error: "displayName required" });
      const cur = await gj("/me/mailFolders?$top=100&$select=id,displayName");
      const hit = (cur.value || []).find(f => String(f.displayName).toLowerCase() === name.toLowerCase());
      if (hit) return resp(200, { id: hit.id, displayName: hit.displayName, created: false });
      const made = await gj("/me/mailFolders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
      return resp(200, { id: made.id, displayName: made.displayName, created: true });
    }

    // ---- list_messages: READ-ONLY listing with the fields needed both to build
    // a routing table (who lives in which folder already) and to write an audit
    // log (id + subject + sender + read state) before anything is moved.
    // Selecting isRead does NOT change it. Nothing here writes.
    if (action === "list_messages") {
      const pages = Math.min(5, Math.max(1, parseInt(body.pages || "3", 10)));
      let url = body.nextLink;
      if (!url) {
        // folderId wins; otherwise resolve folderName ("Proposals", "sentitems",
        // …) to an id server-side so the Service Manager proposals view can
        // point at a folder by name without a separate folders round-trip.
        let folderId = body.folderId;
        if (!folderId && body.folderName) {
          folderId = await resolveFolderIdByName(body.folderName);
          if (!folderId) return resp(404, { error: "Folder not found: " + body.folderName });
        }
        if (!folderId) return resp(400, { error: "folderId or folderName required" });
        // hasAttachments added so a proposals UI can flag which mails carry a PDF
        // (still READ-ONLY — selecting a field never mutates it).
        url = "/me/mailFolders/" + encodeURIComponent(folderId) + "/messages" +
          "?$top=200&$select=id,subject,from,receivedDateTime,isRead,hasAttachments";
      }
      const rows = [];
      let next = url;
      for (let i = 0; i < pages && next; i++) {
        const j = await gj(next);
        for (const m of (j.value || [])) {
          const ea = (m.from && m.from.emailAddress) || {};
          rows.push({
            id: m.id,
            s: (m.subject || "(no subject)").slice(0, 120),
            e: String(ea.address || "").toLowerCase(),
            n: ea.name || null,
            d: m.receivedDateTime || null,
            r: !!m.isRead,
            a: !!m.hasAttachments,
          });
        }
        next = j["@odata.nextLink"] || null;
      }
      return resp(200, { rows, nextLink: next });
    }

    // ---- attachments_list: READ-ONLY list of a message's attachments (id, name,
    // type, size). Used by the Service Manager proposals view to find the PDF on
    // an emailed proposal. GET only; nothing here sends, moves, or deletes.
    if (action === "attachments_list") {
      if (!body.messageId) return resp(400, { error: "messageId required" });
      const j = await gj("/me/messages/" + encodeURIComponent(body.messageId) +
        "/attachments?$select=id,name,contentType,size,isInline");
      const attachments = (j.value || []).map(a => ({
        id: a.id, name: a.name || null, contentType: a.contentType || null,
        size: a.size || 0, isInline: !!a.isInline,
      }));
      return resp(200, { attachments });
    }

    // ---- attachment_get: READ-ONLY fetch of ONE file attachment's bytes
    // (base64 contentBytes), so a proposal PDF can be viewed / handed to the AI
    // scope-prefill. Capped so a runaway attachment can't balloon the response.
    // GET only — no mutation of any kind.
    if (action === "attachment_get") {
      if (!body.messageId || !body.attachmentId) return resp(400, { error: "messageId and attachmentId required" });
      const a = await gj("/me/messages/" + encodeURIComponent(body.messageId) +
        "/attachments/" + encodeURIComponent(body.attachmentId));
      if ((a.size || 0) > 12 * 1024 * 1024) return resp(413, { error: "Attachment too large" });
      return resp(200, {
        id: a.id, name: a.name || null, contentType: a.contentType || null,
        size: a.size || 0,
        // Present on fileAttachment; null for item/reference attachments.
        contentBytes: a.contentBytes || null,
      });
    }

    // ---- move: THE ONLY MAIL MUTATION IN THIS FILE. POST /messages/{id}/move.
    // Move does not alter isRead, does not delete, does not notify anyone, and
    // is fully reversible (the message keeps its id's identity in the new
    // folder and can be moved straight back). There is deliberately NO delete,
    // NO forward, NO send, and NO isRead action anywhere in this function.
    if (action === "move") {
      const moves = (body.moves || []).slice(0, 20);
      const results = [];
      for (const mv of moves) {
        try {
          const r = await graphFetchDelegated("/me/messages/" + encodeURIComponent(mv.id) + "/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ destinationId: mv.destinationId }),
          });
          if (r.status === 429) {
            const ra = r.headers.get("Retry-After");
            results.push({ id: mv.id, status: "throttled", retryAfter: ra ? Number(ra) : 10 });
            continue;
          }
          const t = await r.text();
          if (!r.ok) {
            let code = "";
            try { code = (JSON.parse(t).error || {}).code || ""; } catch (e) { /* noop */ }
            results.push({ id: mv.id, status: "error", error: (r.status + " " + code).slice(0, 100) });
          } else {
            results.push({ id: mv.id, status: "moved" });
          }
        } catch (e) {
          results.push({ id: mv.id, status: "error", error: String(e.message || e).slice(0, 100) });
        }
      }
      return resp(200, {
        moved: results.filter(r => r.status === "moved").length,
        throttled: results.filter(r => r.status === "throttled"),
        errors: results.filter(r => r.status === "error"),
        results,
      });
    }

    // ---- create_draft: THE ONLY MAIL-COMPOSE ACTION. Creates a DRAFT and
    // nothing more. It NEVER sends — Mark reviews the draft in Outlook and
    // sends it himself. There is deliberately no /send, no /sendMail, no
    // send-and-reply, no delete, and no isRead here. Two forms:
    //   reply:  { replyToMessageId, bodyText | bodyHtml }
    //           -> POST /me/messages/{id}/createReply (Graph files the reply
    //              draft in Drafts, quoting the original), then PATCH the BODY
    //              of that one newly-created draft to insert Mark's message
    //              above the quoted history.
    //   fresh:  { toRecipients:[...], subject, bodyText | bodyHtml, ccRecipients? }
    //           -> POST /me/messages (Graph files a plain new message in
    //              Drafts; a message is not sent until an explicit /send this
    //              function never issues).
    // Every write here targets ONLY a draft this call just created. The
    // delegated token has Mail.ReadWrite and NO Mail.Send, so a send is
    // impossible in principle; this code adds no send path regardless.
    if (action === "create_draft") {
      // A caller who hands us a full formatted body (bodyHtml) has written the
      // whole message; we use it verbatim and do NOT auto-append the sign-off.
      // Otherwise we compose from bodyText and sign it off in Mark's voice.
      const hasHtml = typeof body.bodyHtml === "string" && body.bodyHtml.trim() !== "";
      const replyToMessageId = body.replyToMessageId ? String(body.replyToMessageId) : null;

      if (replyToMessageId) {
        // 1. Ask Graph to build the reply draft. This is a CREATE — it files a
        //    draft in Drafts and sends nothing. It quotes the original thread.
        const draft = await gj("/me/messages/" + encodeURIComponent(replyToMessageId) + "/createReply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const draftId = draft && draft.id;
        if (!draftId) return resp(502, { error: "createReply did not return a draft id" });

        // 2. Insert Mark's message ABOVE the quoted history, preserving the
        //    thread, then PATCH — targeting ONLY this just-created draft's body.
        const orig = (draft.body && draft.body.content) || "";
        const isText = String((draft.body && draft.body.contentType) || "html").toLowerCase() === "text";
        let contentType, content;
        if (isText) {
          const mine = hasHtml ? String(body.bodyHtml) : textWithSignoff(body.bodyText);
          contentType = "Text";
          content = orig ? mine + "\n\n" + orig : mine;
        } else {
          const mine = hasHtml
            ? String(body.bodyHtml)
            : escapeHtml(textWithSignoff(body.bodyText)).replace(/\n/g, "<br>");
          contentType = "HTML";
          content = orig ? mine + "<br><br>" + orig : mine;
        }
        await gj("/me/messages/" + encodeURIComponent(draftId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: { contentType, content } }),
        });

        return resp(200, {
          created: true,
          kind: "reply",
          id: draftId,
          webLink: draft.webLink || null,
          replyToMessageId,
        });
      }

      // Fresh draft. Needs at least one recipient and gets a signed-off body.
      const toRecipients = normalizeRecipients(body.toRecipients);
      if (!toRecipients.length) {
        return resp(400, {
          error: "create_draft needs either replyToMessageId (to draft a reply) " +
            "or toRecipients (a non-empty array of email addresses, for a fresh draft)",
        });
      }
      const message = {
        subject: typeof body.subject === "string" ? body.subject : "",
        toRecipients,
        body: hasHtml
          ? { contentType: "HTML", content: String(body.bodyHtml) }
          : { contentType: "Text", content: textWithSignoff(body.bodyText) },
      };
      const cc = normalizeRecipients(body.ccRecipients);
      if (cc.length) message.ccRecipients = cc;

      // POST /me/messages creates a DRAFT in Drafts (Graph's default for a
      // plain message create) — not sent, no notification, fully reversible
      // (Mark can delete or edit it in Outlook).
      const created = await gj("/me/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      return resp(200, {
        created: true,
        kind: "fresh",
        id: created && created.id,
        webLink: (created && created.webLink) || null,
      });
    }

    // ---- rules_create: adds inbox rules. ADDITIVE ONLY — it never edits,
    // disables or deletes an existing rule. The only action a created rule may
    // carry is moveToFolder: this code refuses to build a rule that deletes,
    // forwards, or marks mail read, regardless of what the caller asks for.
    if (action === "rules_create") {
      const wanted = (body.rules || []).slice(0, 12);
      const results = [];
      for (const r of wanted) {
        const built = buildInboxRule(r);
        if (built.skip) {
          results.push({ name: r.displayName, status: "skipped", reason: built.skip });
          continue;
        }
        try {
          const created = await gj("/me/mailFolders/inbox/messageRules", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(built.payload),
          });
          results.push({ name: r.displayName, status: "created", id: created && created.id, matchCount: built.matchCount });
        } catch (e) {
          results.push({ name: r.displayName, status: "error", error: String(e.message || e).slice(0, 180) });
        }
      }
      return resp(200, { results });
    }

    // ---- mail_read: READ-ONLY full bodies (as plain text) for the messages the
    // morning brief wants to quote. Accepts a single messageId or an array
    // (capped). Prefer text so the brief gets clean quotable content, not HTML.
    // GET only — selecting body/isRead does NOT mark the message read.
    if (action === "mail_read") {
      const ids = []
        .concat(body.messageId ? [body.messageId] : [])
        .concat(Array.isArray(body.messageIds) ? body.messageIds : [])
        .map(String).filter(Boolean).slice(0, 15);
      if (!ids.length) return resp(400, { error: "mail_read needs messageId or messageIds[]" });
      const out = [];
      for (const id of ids) {
        try {
          const m = await gj("/me/messages/" + encodeURIComponent(id) +
            "?$select=id,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,body,webLink",
            { headers: { Prefer: 'outlook.body-content-type="text"' } });
          out.push(mapMailMessage(m, { withBody: true }));
        } catch (e) {
          out.push({ id, error: String(e.message || e).slice(0, 160) });
        }
      }
      return resp(200, { messages: out });
    }

    // ---- calendar_list: READ-ONLY events in a window (today | week | explicit
    // start/end). GATED: no-op with a clear message until the delegated grant
    // carries Calendars.ReadWrite (Steve consents + Mark re-signs-in). Uses
    // /me/calendarView so recurring instances are expanded.
    if (action === "calendar_list") {
      if (!(await hasCalendarScope())) return resp(200, CALENDAR_NOT_GRANTED);
      let range;
      try { range = resolveCalendarRange(body, new Date()); }
      catch (e) { return resp(e.statusCode || 400, { error: e.message }); }
      const { startDateTime, endDateTime } = range;
      const n = parseInt(body.top, 10);
      const top = Math.min(100, Math.max(1, Number.isFinite(n) ? n : 50));
      const url = "/me/calendarView?startDateTime=" + encodeURIComponent(startDateTime) +
        "&endDateTime=" + encodeURIComponent(endDateTime) +
        "&$select=id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,webLink" +
        "&$orderby=start/dateTime&$top=" + top;
      const j = await gj(url, { headers: { Prefer: 'outlook.timezone="America/Chicago"' } });
      const events = (j.value || []).map(mapEvent);
      return resp(200, { calendarScopeGranted: true, events, count: events.length, window: { startDateTime, endDateTime } });
    }

    // ---- calendar_create: additive event on Mark's OWN calendar. GATED the same
    // way as calendar_list. POST /me/events cannot modify or delete any existing
    // event (no id, no such action), and the payload carries no attendees, so it
    // never emails an invitation — creating an event sends no mail and notifies
    // no one.
    if (action === "calendar_create") {
      if (!(await hasCalendarScope())) return resp(200, CALENDAR_NOT_GRANTED);
      let payload;
      try { payload = buildEventPayload(body); }
      catch (e) { return resp(e.statusCode || 400, { error: e.message }); }
      const created = await gj("/me/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return resp(200, {
        calendarScopeGranted: true,
        created: true,
        id: created && created.id,
        subject: created && created.subject,
        start: created && created.start,
        end: created && created.end,
        webLink: (created && created.webLink) || null,
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
module.exports._internals = { classify, parseSignature, splitName, sigLines, buildInboxRule, ruleKeywordProblem, textWithSignoff, normalizeRecipients, escapeHtml,
  mapMailMessage, resolveCalendarRange, mapEvent, dateOnly, buildEventPayload, CALENDAR_NOT_GRANTED,
  resolveFolderIdByName, WELL_KNOWN_FOLDERS,
  contactsLimit, DEFAULT_CONTACTS_LIMIT, MAX_CONTACTS_LIMIT, MAX_CONTACT_PAGES };
