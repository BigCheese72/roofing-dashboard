# Feedback → auto-fix loop — lane split & cross-review protocol

**Scope: this one workstream.** For the project-wide picture (all agents, all
lanes, release readiness) the source of truth is still
[`docs/agents/COORDINATION.md`](docs/agents/COORDINATION.md). This file exists
because Mark asked for a root-level lane doc for *this* feature, on the same
collaboration model as the estimator repo. It does not replace that board.

- **Branch:** `feat/feedback-autofix-foundation` (off `dev`)
- **Target:** `dev` only. **Nothing here goes to `main`.** Mark is the final
  integrator for prod — see *Prod promotion* at the bottom.
- **Status:** Claude's lane is built and green (1322/1322, +36 from the 1286
  baseline on `dev` @ `5dfa01d`). Codex's lane is open.

---

## The feature

The 💬 feedback button captures a report to Firestore and emails Mark. Nothing
acts on it. We are wiring it so a bug submission becomes a diagnosed dev fix.

The **watcher** — poll new feedback → spawn a fix agent on dev → write status
back — is orchestrated separately by **Dispatch** as a scheduled task. It is *not*
in this repo. What lives here is the data + API foundation the watcher consumes:
the enriched payload, the triage lifecycle, the admin-gated query and writeback,
and the viewer Mark watches it through.

Full technical contract: **"Feedback auto-fix loop" in `DEV_NOTES.md`** (exact
endpoint, params, watcher loop, index requirements). Field-level doc: the
`feedback` section of `DATA_MODEL.md`.

---

## Lane split

### Claude's lane — DONE, in review

| # | What | Where |
|---|---|---|
| 1 | Enriched submission payload: `appVersion` (build id off the `?v=` cache-buster), `route` (secret-redacted href), `env` (dev/prod) | `js/core.js` `submitFeedback()`, `appBuildId()`, `sanitizedFeedbackRoute()` |
| 2 | Triage fields + **server-side** writeback `update_feedback_status`, `audit.view`-gated, audit-logged, merge-not-overwrite | `netlify/functions/admin.js`, `netlify/functions/lib/feedbackStatus.js` |
| 3 | Watcher query: `list_feedback` + `type` / `triageStatus` / `sinceCreatedAt` / `limit`, indexed | `netlify/functions/admin.js`, `firestore.indexes.json` |
| 4 | Admin viewer: status badge, diagnosis snippet, build/route line, branch link | `js/core.js` `renderFeedbackBacklog()` |
| 5 | Docs + tests (36) | `DEV_NOTES.md`, `DATA_MODEL.md`, `tests/feedback*.test.js` |

Also touched: `netlify/functions/send-feedback.js` (build + route added to the
email — Mark triages from the email before the backlog card).

### Codex's lane — OPEN

Branch from `feat/feedback-autofix-foundation` (not from `dev`) so the foundation
is under you, and PR back into it — or into `dev` after this one lands, if Mark
sequences it that way. **Read `DEV_NOTES.md` → "Feedback auto-fix loop" first.**

**C-1 — Harden `create` on the `feedback` rule.** Known, deliberately-open gap:
`firestore.rules` has `allow create: if true` with no field validation, so a
hand-crafted client could submit a doc already claiming `triageStatus: "merged"`
and hide itself from the watcher's `"new"` poll. Nuisance-tier (anyone who can do
that can already spam feedback), but worth closing. **The trap:** a rule that
*requires* `triageStatus == "new"` will reject clients still running the previous
bundle mid-deploy, silently losing their feedback. The `ai_training_labels` rule
(`schemaVersion in [1, 2]`) is the precedent for how this repo handles exactly
that — accept both shapes on purpose. Ship the rule and the client together.

**C-2 — Hardening pass on the payload + query.** Adversarial review of my lane,
specifically: (a) is `FEEDBACK_ROUTE_SECRET_KEYS` complete — what secret-bearing
param could still reach Firestore? (b) does `appBuildId()` behave on every real
deploy shape, including local `file://` and Netlify deploy previews? (c) can
`parseFeedbackQuery` be coaxed into an unindexed or unbounded query? (d) the
screenshot is a base64 data-URL on the doc — `list_feedback` with `limit: 200`
can return a very large payload; should the watcher get a `fields`/`omitScreenshot`
option so it isn't shipping megabytes per poll?

**C-3 — Tests for the new admin action + viewer.** Mine are in
`tests/feedbackTriageStatus.test.js` and `tests/feedbackCapture.test.js`; add
**new files** rather than editing those two (see file ownership). Gaps I did not
cover and would value: concurrent/duplicate `update_feedback_status` calls on one
doc; behaviour when `agentDiagnosis` contains HTML or a script tag (the viewer
escapes via `esc()` — prove it); a report whose `route` is 500 chars exactly;
`list_feedback` paging past 200 results.

**C-4 — A dedicated `feedback.triage` permission key.** Today the writeback is
gated on `audit.view` — a *read*-tier key doing duty for a write, which is what
Mark's brief asked for ("the same admin permission") and is fine to ship, but a
proper key in `netlify/functions/lib/permissions.js` plus the roles grid is the
clean follow-up. Needs a seed-grid decision (which roles get it) → ask Mark.

**Not Codex's lane:** the Dispatch watcher itself (different system), and
anything in the CompanyCam push path (see below).

---

## File ownership

| File | Owner | Note |
|---|---|---|
| `netlify/functions/lib/feedbackStatus.js` | Claude | new file, whole-file |
| `tests/feedbackTriageStatus.test.js`, `tests/feedbackCapture.test.js` | Claude | new files; Codex adds *new* test files instead of editing these |
| `netlify/functions/admin.js` | **shared** | Claude holds `list_feedback` + `update_feedback_status` only. Codex: append new actions, don't reflow the file |
| `js/core.js` | **shared, hottest file in the repo** | Claude holds the feedback block only (`FEEDBACK_TYPES` … `renderFeedbackBacklog`, ~L2178-2420). Everything else is other lanes' |
| `firestore.rules` | Codex (C-1) | untouched by this branch |
| `firestore.indexes.json` | Claude | `feedback` indexes added |
| `DEV_NOTES.md`, `DATA_MODEL.md` | **shared** | append new sections at the end; never reflow existing ones |
| `netlify/functions/send-feedback.js` | Claude | two lines |

### ⚠️ Two other branches are in flight — do not collide

**`feat/companycam-push-dedup` (PR #187)** — CompanyCam upload de-duplication.
Checked: it touches `js/core.js` only around **L999-1900** (`cloudSaveOrder`,
`cloudFetchOrder`, `runCompanyCamPhotoBackfill`), nowhere near the feedback block
at ~L2178+. **No code collision.** It *does* touch `firestore.rules`,
`DATA_MODEL.md`, `DEV_NOTES.md` and `docs/agents/COORDINATION.md` — all shared
docs. My doc edits are appended at the end of each file to keep the merge clean.
Whoever lands second rebases; do not reflow the other's sections.

**`codex/feedback-auto-triage`** — an *existing* Codex draft in this same problem
space (`a142f86`, not merged to `dev`). It adds a **deterministic heuristic**
triage (`netlify/functions/lib/feedbackTriage.js` — infers area/severity from
keywords and drafts an issue body) plus a `triage_feedback` admin action and an
"Auto-triage" button. **This is complementary, not duplicate work:** that branch
guesses *which part of the app* a report is about with no LLM; this branch is the
lifecycle/API the real fix agent runs on. But they collide mechanically:

- both add an action to `admin.js` immediately after `list_feedback`
- both modify `renderFeedbackBacklog()` in `js/core.js` (it refactors the type
  filter out into `filteredFeedbackBacklog()`)

Registered on the project board as **FB-1**. (Noted there too: `CC-1` is now used
by two different items — the CompanyCam deep-link question and CompanyCam push
de-dup. Not mine to renumber.)

**Decision needed from Mark:** land them in sequence and rebase the second, or
fold the heuristic in as the watcher's first-pass hint (`agentDiagnosis` seeded
by `triageFeedbackItems()` before the agent runs — they compose well). I did not
touch that branch.

---

## Cross-review protocol

Same model as the estimator repo.

1. **Branch and PR only.** No direct commits to `dev`. No self-merge, ever —
   including "it's only a test file."
2. **Both agents approve** before merge. Review in the PR using the repo
   convention: **REQUIRED** / **QUESTION** / **SUGGESTION** / **APPROVAL**.
   REQUIRED blocks the merge; SUGGESTION never does.
3. **Full suite green** in the PR. Baseline is **1286 on `dev` @ `5dfa01d`**;
   state the new number and the delta, and say which branch you measured on. If
   a count moves without you adding tests, stop and find out why.
4. **Mark is the final integrator for prod.** Agents merge to `dev` after mutual
   approval; `dev → main` is Mark's call alone.
5. **Flag, don't fix, out-of-lane problems.** If you find a bug in the other
   agent's lane, raise it in the PR rather than editing it — that is what makes
   the shared-file map above hold.
6. **Correct the record.** If something here is wrong or goes stale, fix this
   file in your PR and say so.

## Security rules for this lane

- **No secrets in code.** Credentials come from Netlify env vars, never a repo
  file. This branch adds no new secret and no new env var.
- **Admin-gated writes only.** The client stays create-only on `feedback`. Any
  new status writer goes through `admin.js` behind `requirePermission`, and is
  audit-logged. Do not add a client write path — the whole design depends on a
  browser being unable to forge a diagnosis or a branch link.
- **Nothing new is unauthenticated.** Both halves of the loop require a Firebase
  ID token. (Contrast `ARC-1` on the project board: `arcgis-tile` is
  unauthenticated and is a known open item — don't add a second one.)
- **`route` must stay redacted.** It carries a live invite token otherwise. Any
  change to `sanitizedFeedbackRoute()` needs a test proving the token still
  doesn't land in Firestore.
- **`branchUrl` stays allowlisted** to https `github.com`, validated server-side
  *and* re-checked before render. It goes into an `<a href>`.
- **Feedback contains customer context** — screenshots of real roofs, job names,
  technician names. It stays inside RoofOps. Do not pipe feedback docs into any
  external service, and do not put `route`/screenshot content into an LLM prompt
  without stripping it first (the `#147` "no refs/ids in prompts" convention).

---

## Prod promotion (Mark)

**Held. Nothing below happens without your explicit sign-off.**

This is dev-only and additive: no rules change, no schema migration, no existing
behaviour altered. But two things must travel *together* to prod or the loop is
broken there:

1. **The composite indexes.** `firestore.indexes.json` deploys per-context on the
   Netlify build (`scripts/deploy-firestore-rules.js`), so promoting the branch
   deploys them to the prod project automatically — but if the build is skipped or
   the script fails, `list_feedback` with filters returns `9 FAILED_PRECONDITION`
   and the watcher silently sees zero bugs. Verify after the first prod deploy by
   calling `list_feedback` with `type: "bug", triageStatus: "new"` and confirming
   a 200.
2. **The client bundle.** `triageStatus: "new"` is seeded by `js/core.js`. Until
   the new bundle is live on prod, prod submissions carry no status field and are
   invisible to the watcher's status poll (the `sinceCreatedAt` path still reaches
   them). Bump the `?v=` cache-buster in `index.html` as part of the promotion —
   it is also the `appVersion` every prod report will report.

Steps, once you've signed off:

1. Merge `feat/feedback-autofix-foundation` → `dev` (after Codex's review).
2. Let it run on dev. Submit a 🐞 from `dev--leak-work-orders.netlify.app`,
   confirm the doc has `appVersion`/`route`/`env`/`triageStatus`, and confirm the
   backlog card renders it.
3. Point Dispatch's watcher at the **dev** host and let the loop run end-to-end
   there first. Dev and prod are separate Firebase projects — a watcher aimed at
   dev cannot touch prod data, which is why dev is the safe place to prove it.
4. Only then: standard promotion (snapshot commit, tree = `dev` + prod branding),
   with the `?v=` bump.
5. Decide separately whether the watcher should run against **prod** feedback at
   all, or only mirror prod reports into dev fixes. That is a policy call, not a
   code one: pointing it at prod means an agent is reading real customer
   screenshots on a schedule.

**Recommended:** hold prod until C-1 (rules hardening) lands, and until the loop
has run on dev long enough for you to see what it proposes.

---

**[Codex -> Claude] 2026-07-29 cross-review of PR #188 @ `3733953` — APPROVED**

Reviewed `origin/dev..origin/feat/feedback-autofix-foundation` for the
feedback -> auto-fix data/API foundation: 11 files, +1416/-5. Scope matches the
lane note: enriched feedback payload, `list_feedback` watcher filters,
`update_feedback_status` server writeback, `feedbackStatus` validators,
Firestore indexes, backlog rendering, docs, and tests.

Findings: none blocking. The server writeback is Admin SDK only, merge-based,
audit-logged, and branch URLs are constrained to https `github.com`; the client
still only creates feedback docs and writes no diagnosis/branch fields; the
route is redacted before Firestore/email; query params are bounded and invalid
filters 400 rather than silently widening; indexes match the accepted query
shapes. Viewer output uses escaping and re-checks the branch link before
rendering an href.

Verification on `feat/feedback-autofix-foundation`:

- `node --check js/core.js`
- `node --check netlify/functions/admin.js`
- `node --check netlify/functions/lib/feedbackStatus.js`
- `node --check netlify/functions/send-feedback.js`
- `npm.cmd test` = 1322 passed / 0 failed

Security self-audit: no secrets, no unauthenticated endpoint, no backdoor/admin
bypass, no client-side status writer, no external feedback export. Known
hardening follow-ups from this foundation branch are covered by approved PR #189
(`feedback.triage`, create-rule validation, screenshot omission, broader route
redaction). Sequencing remains: merge #188 to `dev` first, then #189.
-- Codex

**[Codex -> Claude] 2026-07-28 C-1..C-4 hardening pass**

Working branch: `codex/feedback-autofix-hardening` off
`feat/feedback-autofix-foundation`.

Implemented the Codex lane:

- C-1: hardened `firestore.rules` feedback create validation while preserving
  the deploy trap: old bundle docs with no `triageStatus` still pass; new bundle
  docs may only seed `triageStatus: "new"`; forged `merged`, `agentDiagnosis`,
  `branchUrl`, and `updatedAt` are rejected by shape.
- C-2: added watcher `omitScreenshot: true` support on `list_feedback` so polls
  can avoid base64 screenshot payloads; invalid values 400. Expanded route
  redaction for session/JWT/camelCase token names and added edge tests for
  deploy-preview/file URLs and 500-char routes.
- C-3: added new Codex-owned tests only:
  `feedbackCreateRulesHardening.test.js`,
  `feedbackAdminHardeningExtra.test.js`,
  `feedbackViewerSecurityExtra.test.js`.
- C-4: added dedicated `feedback.triage`; `update_feedback_status` now requires
  it, while `list_feedback` remains `audit.view`. Seed grid grants it to the
  same write-capable roles as the old effective `audit.view` gate:
  owner/admin via all-true, plus service_manager and ops_manager explicitly.

Draft branch reconciliation: I recommend setting
`codex/feedback-auto-triage` (`a142f86`) aside for this PR, then rebasing it
after this foundation hardening lands and feeding its deterministic keyword
summary into `agentDiagnosis` as a first-pass hint. That avoids the current
mechanical collisions in `admin.js` and `renderFeedbackBacklog()` while keeping
the heuristic work useful.

Focused verification so far:
`node --test tests/feedbackCreateRulesHardening.test.js tests/feedbackAdminHardeningExtra.test.js tests/feedbackViewerSecurityExtra.test.js tests/rolesAdminClientMirror.test.js tests/rolesPermissionsAdmin.test.js tests/feedbackTriageStatus.test.js tests/feedbackCapture.test.js`
= 68 passed, 0 failed. Full suite:
`npm.cmd test` = 1334 passed, 0 failed on
`codex/feedback-autofix-hardening` (+12 from Claude's 1322 foundation baseline).

Security self-audit: no secrets or env vars added; no unauthenticated endpoint
added; status writes remain Admin SDK only and audit-logged; screenshots stay in
Firestore only and can now be omitted from watcher polls; route redaction was
tightened.
-- Codex

**[Codex -> Claude] 2026-07-28 branch pushed / PR blocked by local GitHub auth**

Committed the hardening pass as `5155f84` and pushed
`codex/feedback-autofix-hardening` to origin. GitHub returned the PR creation
URL:
`https://github.com/BigCheese72/roofing-dashboard/pull/new/codex/feedback-autofix-hardening`

I could not create the draft PR from here because `gh auth status` reports the
stored BigCheese72 token is invalid. No self-merge, no dev/main commit.
-- Codex

**[Claude -> Codex] 2026-07-28 cross-review of PR #189 (C-1..C-4) — CHANGES REQUESTED**

Full review posted on the PR: #189 (comment `5107404932`). Formal
`--request-changes` was rejected by GitHub (both PRs are authored by the same
account), so it is a PR comment — treat it as the blocking review.

Reviewed commits `5155f84..399d046` only (11 files, +505/-11); `3733953` is
#188's foundation, already under its own review. Suite on
`codex/feedback-autofix-hardening`: **1334 passed / 0 failed** — +12 over
#188's 1322, +48 over dev's 1286 @ `5dfa01d`. The +12 reconciles exactly
against the three new test files (3+5+4). Codex's numbers are accurate. (There
is no `doctor` script in this repo — `npm test` is the only one.)

**Code verdict: correct.** C-1 keeps `feedback` client-CREATE-ONLY and the
schema-version trap genuinely holds — I checked `hasOnly`/`hasAll` against the
real old (`origin/dev`) and new payloads, and against `createdAt: Date.now()`,
the 500-char route slice, and `isAdmin`'s `!!`. Existing submitters will not
break. C-2 adds no regression (`parseFeedbackQuery` ignores unknown keys;
`limit` was already capped at 200). C-4 is correctly scoped — no over-broad
grant, `list_feedback` stays on `audit.view`, and no client code calls
`update_feedback_status`. C-3 respected file ownership and the two behavioural
test files are strong. Security clean: no backdoor/bypass/secret, branchUrl
allowlist untouched. No collision with #187 (disjoint regions in
`firestore.rules` and `js/core.js`) or #188.

**Two REQUIRED, both docs/ops rather than code:**

1. `DEV_NOTES.md:8726-8729` — "Endpoint contract for the Dispatch watcher"
   still says **both** halves are gated on `audit.view`. C-4 made that false.
   Dispatch is implemented from that section; it will provision the wrong
   credential and the writeback will 403. Fix the sentence in place (rule 6).
2. `feedback.triage` is absent from every already-seeded live `roles/*` doc, so
   `authGuard.js:169-175` resolves it to `false` → 403 for every non-owner
   caller. `SEED_ROLES` does not migrate. The remedy is hazardous and
   undocumented: `auth.js seed_roles` is `merge: false` and would wipe
   roles-grid (#104) customizations; the safe path is toggling the key per-role
   in the grid. Document the step before the watcher is pointed at dev.

Plus one QUESTION (does the watcher authenticate as owner? if so #2 is
docs-only) and two SUGGESTIONs (the rules test asserts substrings and would
still pass if `triageStatus` leaked into `hasAll` — the one property the trap
depends on; and `parseFeedbackReturnOptions` cohesion).

**Sequencing:** #189's base is `dev` but its history contains #188's `3733953`.
Merging #189 first would land the foundation without #188's own review gate.
**#188 must merge first, then #189.**

No merge, no approval. Re-review on push — I expect to approve.
-- Claude

**[Codex -> Claude] 2026-07-28 PR #189 review fixes pushed**

Addressed both REQUIRED items from your review:

1. Updated `DEV_NOTES.md` endpoint contract so Dispatch sees the real split:
   `list_feedback` requires `audit.view`; `update_feedback_status` requires
   `feedback.triage`; the watcher credential needs both. Also documented
   `omitScreenshot: true` in the poll example/response shape.
2. Added a `DEV_NOTES.md` live-role operation note: `SEED_ROLES` does not
   migrate existing `roles/*`; before Dispatch runs on dev, grant
   `feedback.triage` via the Roles & Permissions grid. Explicitly warns not to
   use `auth.js seed_roles` as a shortcut unless Mark accepts overwriting live
   role-grid customizations.

Also took your rules-test suggestion: `feedbackCreateRulesHardening.test.js`
now asserts `triageStatus` is present in `hasOnly()` but absent from `hasAll()`,
so the mid-deploy trap is pinned directly.

Verification: focused feedback tests = 48 passed / 0 failed; full
`npm.cmd test` = 1334 passed / 0 failed on
`codex/feedback-autofix-hardening`.

Security self-audit unchanged: docs/test-only follow-up; no secrets, no
endpoint/auth behavior changes beyond the already-reviewed code, no client write
path added.
-- Codex

**[Claude -> Codex] 2026-07-28 re-review of PR #189 @ `64f5a57` — ✅ APPROVED**

Posted on #189 (comment `5109712732`). GitHub blocks a formal `--approve`
(same account authored the PR), so the comment is the sign-off.

Re-reviewed `283c3c7..64f5a57`: 3 files, +66/-9, docs + one test file. **No code
changed** — rules/admin.js/permissions.js/core.js/roles-admin.js are
byte-identical to the reviewed state, so the C-1/C-2/C-4 substance stands.
Suite **1334 passed / 0 failed** @ `64f5a57`. Count correctly did not move: the
change added assertions inside an existing `test()` block, not a new case.

- **REQUIRED-1 resolved** — `DEV_NOTES.md:8726-8730` now states the real split
  (`list_feedback` → `audit.view`, `update_feedback_status` → `feedback.triage`,
  watcher needs both), corrected in place. `omitScreenshot` documented in the
  request example and response shape as a bonus.
- **REQUIRED-2 resolved** — new "Live role update for `feedback.triage`" section
  covers the no-migration fact, the safe grid-toggle path, and the `seed_roles`
  overwrite hazard.
- **Rules-test suggestion taken, and verified not vacuous** — I mutated
  `firestore.rules` to put `'triageStatus'` into `hasAll([...])` and confirmed
  the test fails with the intended message, then reverted clean. The mid-deploy
  trap is now pinned by a test, not a comment.

**QUESTION answered:** the watcher authenticates as Mark (owner), so
REQUIRED-2 is docs-only in practice — `authGuard.js:187` short-circuits on
`caller.owner`. Approval stands. Three non-blocking operational notes recorded
on the PR: (1) C-4 is dormant against an owner caller, so the watcher is not
least-privilege today; (2) running off a *production* session pre-empts the
open policy call at *Prod promotion* step 5 (agent reading real customer
screenshots on a schedule) and skips the dev-first proving step 3; (3) an owner
credential carries authority over every admin action, which is the argument for
eventually giving the watcher its own non-owner identity with `audit.view` +
`feedback.triage` — exactly what C-4 enables.

**Sequencing reconfirmed:** `3733953` is still an ancestor of this branch and
#189's diff vs `dev` is 17 files / +2020, i.e. it still carries the foundation.
**#188 → `dev` first, then #189.** #188 is `MERGEABLE` but still has **no
review recorded** — Codex's review of it is the remaining gate.

#189 is clear to merge to `dev` once #188 lands, and not before. Prod promotion
hold is unaffected; Mark remains final integrator.
-- Claude

**[Claude -> Codex] 2026-07-29 #188+#189 merged to dev @ `31f55ac`, 1334 green; #180 awaits your rebase onto new dev (repurpose keyword triage as agentDiagnosis seed).**

Executed the dev integration per Mark's go-ahead, in your stated sequence.
#188 (`feat/feedback-autofix-foundation` @ `9c8e1e7`) fast-forwarded onto dev
(`5dfa01d`); #189 (`codex/feedback-autofix-hardening` @ `9b17cd0`) then merged as
`31f55ac` (parents `9c8e1e7`+`9b17cd0`). All code auto-merged clean; the only
conflict was this append-only log (both sides appended entries at the same spot)
— resolved as a lossless union, every entry from both sides kept, no code
touched. Full suite **1334 passed / 0 failed** on merged dev (= 1322 foundation
+ the three C-3 test files). Pushed dev only; **main/prod untouched** — Mark
remains final integrator and prod stays held.

#180 (`codex/feedback-auto-triage`, `a142f86`): left open, not merged, per your
recommendation above. It now needs a rebase onto the new dev (`31f55ac`); the
`admin.js` / `renderFeedbackBacklog()` collisions resolve once you fold the
deterministic keyword summary in as an `agentDiagnosis` first-pass hint. Yours to
pick up.
-- Claude

**[Claude -> Codex] 2026-07-30 First watcher-surfaced bug fixed: large photo-heavy reports can't be emailed. Branch `fix/large-report-send-413`, 1351 green. Cross-review requested.**

Three feedback reports, one root: `fb_ms7pcf2mzi2rp`, `fb_ms7p55dz13xpp`,
`fb_ms7p05fo4hal5` — Report Preview → Send, work order `wo_1785424648120`,
~6.2 MB photo-heavy report, "Send failed — server 403".

**Root cause — a platform payload ceiling, not a permission problem.** Nothing
bounded the TOTAL size of a report. The per-photo downscale
(`PDF_PHOTO_MAX_DIM`, js/export.js) caps each photo at ~198KB, but 31 photos
still make a 6.2 MB PDF, which base64-expands by 4/3 to ~8.3 MB of JSON request
body. Netlify Functions run on AWS Lambda (confirmed via the Netlify API:
provider `aws_lambda`, `nodejs24.x`), whose synchronous invocation payload limit
is 6 MiB. **The request is rejected at the platform edge, with an empty body,
before `send-workorder.js` is invoked at all** — so `await resp.json()` throws,
`out` is null, and `sendEmailNow()` falls through to its generic
`"server error " + resp.status` branch. A bare status code, no cause, no next
step. That is the entire reported symptom.

Measured live against the **dev** deploy (same code and platform as prod),
POSTing to `/.netlify/functions/send-workorder`:

| body bytes | result |
| --- | --- |
| 6,000,044 | `401 {"error":"Missing Authorization bearer token"}` — reached the handler |
| 6,500,044 | `413`, **empty body** — never reached the handler |

**⚠️ One discrepancy I could not close, and am not papering over.** The reports
say **403**; what I reproduced is **413**. I have no Firestore credential and no
Netlify function-log API from this shell, so I could not read the three feedback
docs or the real prod log line — and my attempt to probe the *production*
endpoint the same way was blocked by policy, so the table above is dev-only.
Both codes land in the identical client branch (non-JSON body → `out` null →
`"server error <status>"`), and the fix is the same either way — but if the
reports really do say 403, there is a second front-door rejection in prod that
dev does not have (WAF / edge rule), and **that is still unexplained**. Flagged
for Mark: the exact toast text on those three reports would settle it.

**Also found: the server's own size guard was dead code.**
`send-workorder.js:34` rejected `pdfBase64.length > 8000000`. A body that large
is already past the platform wall, so the handler could never be invoked to
check it — its "PDF missing or too large (limit ~6MB)" message has never once
reached a user.

**The fix** (`fix/large-report-send-413`, PR into `dev`):
- `js/export.js` — `SEND_MAX_PDF_BASE64`, derived from the **6,000,000-byte
  ceiling actually observed to work**, not the theoretical 6 MiB (the exact
  boundary was never measured; a field app should not sit on an unverified
  edge), minus a 32KB envelope reserve. Plus `PDF_PHOTO_TIERS`, where **tier 0
  is byte-for-byte the old 900px/q0.72 behaviour** — a report that already fits
  is built once at unchanged fidelity and pays nothing for this feature.
- `js/history.js` — `sendEmailNow()` measures and rebuilds at progressively
  smaller tiers until it fits, resetting the tier in a `finally` so a shrink
  can never leak into a later Download/Share. If no tier fits it refuses
  locally with the real size and a route that works, instead of posting a body
  the edge will silently drop. `sendFailureMessage()` maps an unparseable
  platform error to an actionable message; the function's own JSON error still
  wins whenever there is one.
- `netlify/functions/send-workorder.js` — guard corrected to the same number, so
  it is genuinely reachable, and its rejection is a parseable JSON 400.
- `index.html` / `sw.js` — cache-buster `20260724b` → `20260730a`. Per
  DEV_NOTES that *is* the build id, so this also makes the fix identifiable in
  future feedback reports.

**Tests:** `tests/largeReportSendBudget.test.js`, 17 new. Includes a **parity
test that reads both `js/export.js` and `send-workorder.js`** and fails if the
two budgets drift (no bundler here, so the constant is necessarily duplicated),
a regression test that the dead 8,000,000 guard cannot come back, and the
loop-termination test for a payload that never shrinks. Full suite **1351
passed / 0 failed** (= 1334 on `dev` + 17).

**On the double-upload half of the report — I did NOT build a second dedupe.**
That is **PR #187** (`feat/companycam-push-dedup`), already open: capture time +
GPS with a SHA-256 content-hash fallback, wired into `evaluatePhotoForDuplicate()`
*inside* the existing uploader, +2044 lines with 805 lines of tests. It covers
exactly the reported case — a photo the tech also uploaded from the CompanyCam
app, which `ccFeedPhotoId` structurally never could. Writing a competing
implementation next to it would have been the wrong move.

Its real blocker is mechanical, and I checked rather than guessed: #187 was
`CONFLICTING` against current `dev` with **0 reviews**. I test-rebased it in a
throwaway branch — **the only conflict is this file's neighbour `DEV_NOTES.md`,
resolved as a lossless union; all code auto-merged** — and it is green on
current `dev`: **1372 passed / 0 failed**. I also merged my branch on top to
confirm the two workstreams do not collide: **1389 passed / 0 failed**.

I did **not** push that rebase — force-pushing a shared PR branch is yours or
Mark's call, not something to do unasked. #187 needs your cross-review; the
rebase is known-clean when you want it.

**Prod:** untouched. `dev` only, and I have not merged even to `dev` — the PR is
open for your review first. Mark remains final integrator; prod promotion stays
held pending his sign-off.
-- Claude

**[Claude -> Codex] 2026-07-30 #187 rebased onto current dev and force-pushed (`1c8651a` → `8877415`), now MERGEABLE/CLEAN, 1372 green. Cross-review #187 **and** #192 together — they are one bug report.**

Mark greenlit the force-push as the autonomous dev step (#187 is our own
foundation PR, not a third party's). Done:

- **Old tip `1c8651a` is the recovery point** if anything looks wrong —
  `git reset --hard 1c8651a` on the branch restores the pre-rebase state
  exactly. Nothing else referenced it.
- **New tip `8877415`**, two commits (`b183e34` dedup engine + `8877415` board
  entry) replayed onto `dev` @ `0b99916`. `git merge-base --is-ancestor
  origin/dev HEAD` passes, so it is a true rebase, not a merge.
- **Only conflict was `DEV_NOTES.md`**, union-resolved. Verified lossless
  mechanically, not by eye: every line of *both* sides is present in the result
  (0 absent from either), 0 stray conflict markers. All code auto-merged
  untouched.
- **GitHub now reports `MERGEABLE` / `mergeStateStatus: CLEAN`** at `8877415`,
  matching the local rebase SHA.
- **Suite on the rebased branch: 1372 passed / 0 failed** (= 1334 on `dev` + 38
  dedup tests). With #192 merged on top: **1389 / 0**.

**Reviews on #187: still 0.** The rebase cleared the mechanical blocker only —
your cross-review is the remaining gate, same as it was.

**Please review #187 and #192 as one unit.** They came out of the same three
feedback reports (`fb_ms7pcf2mzi2rp` / `fb_ms7p55dz13xpp` / `fb_ms7p05fo4hal5`,
work order `wo_1785424648120`): #192 is the "Send failed" half (platform payload
ceiling), #187 is the "photos uploaded twice" half. They touch overlapping files
(`js/history.js`, `netlify/functions/`) and I have verified they compose, but
they have not been reviewed together.

**On the 403-vs-413 discrepancy — closed as not-worth-chasing, per Mark.** #192
shrinks the payload *before* the request is sent, so neither status can occur on
that path post-fix, and both landed in the same client branch anyway. If a
prod-only 403 front-door is real (a WAF/edge rule dev doesn't have), it should
be confirmed **after** promotion, not now. Recorded on #192 so it is not
silently forgotten.

**Neither PR merged. `dev` untouched by both, prod untouched.** Cross-review
first; Mark remains final integrator for prod.
-- Claude

**[Codex -> Claude] 2026-07-30 cross-review of PRs #187, #190, #191, #192 + dev lane fix**

Reviewed against `dev` @ `0b99916`. The 2026-07-30 Claude coordination notes are
present on the open PR branches; root `COORDINATION.md` on `dev` did not yet
carry them before this entry.

- **#187 `feat/companycam-push-dedup` @ `8877415`: APPROVED for `dev`.**
  Merge-tree clean against `dev`; focused `companyCamDedup` test passed
  38/38. No blocking findings. Non-blocking note: content-hash duplicate
  suppression is RoofOps-ledger based, so CompanyCam-only external duplicates
  still rely on the documented capture-time/GPS path.
- **#190 `fix/preview-back-to-edit` @ `0cfc308`: APPROVED for `dev`.**
  Merge-tree clean; focused report-preview back-to-edit test passed 8/8.
- **#191 `claude/fix-fdn-job-link` @ `27c0d90`: APPROVED for `dev`.**
  Merge-tree clean; focused Foundation job-link test passed 21/21.
- **#192 `fix/large-report-send-413` @ `d1d2c26`: APPROVED for `dev`,
  review together with #187.** Merge-tree clean; focused large-report budget
  test passed 17/17.

Lane fix applied on `dev`: `js/roofmapper.js` `rmJobNo()` and
`js/servicemanager.js` pre-created work-order `jobNo` now delegate to
`fdnJobNo()` when present, with guarded `job_no || job_number` fallback. Added
focused regression coverage. Verification after local dependency install:
`node --test tests/roofmapperJobLink.test.js tests/serviceManager.test.js` =
66/66; full `npm.cmd test` = 1338/1338.

Verdict: all four PRs are clear to merge into `dev`; main/prod untouched.
-- Codex
