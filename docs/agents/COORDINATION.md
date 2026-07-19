# RoofOps Agent Coordination Board

> # ⏸️ FULL HOLD — 2026-07-18: CODEX IS BUILDING THE ESTIMATOR
>
> **Mark's directive. Nobody starts anything new until Codex finishes the estimator tool.**
>
> - **Codex owns the estimator lane** — likely a new `js/estimator.js` plus a tab wired into
>   `js/core.js` and `index.html`.
> - **EVERYONE STAYS OFF `js/core.js` AND `index.html`.** That is where the estimator wires in
>   and it is the whole reason for this hold.
> - **The `js/workorders.js` split is HELD.** Not cancelled — held. It touches `core.js` and
>   `index.html`, exactly Codex's wiring surface.
> - **No merges to `dev`.** #170, #171, #172 stay as branches/PRs so Codex can branch off a
>   stable `dev` without forced rebases. Nothing is lost.
> - **Section agents remain held/advisory.** Report and map; do not edit.
> - Work already mid-edit could finish and commit so nothing was lost. Nothing new after that.
>
> **Status: standing by** for the post-Codex review (dev vs prod, the four PRs, the split
> decision).
>
> ⚠️ **One merge beat the hold:** **#173 landed at `a851763`** minutes before the directive
> arrived. It is **tests-only** — one new file, +407/−0, no source, no `core.js`, no
> `index.html` — so it cannot force a rebase on Codex. Flagged to Mark; left in place because
> reverting is itself a change to `dev`. Revert on request.

> # 🛑 MODEL CHANGE — 2026-07-18: SINGLE SERIALIZED BUILDER
>
> **Mark's decision: parallel agents collide, so the team goes fully serial.**
> There is now **exactly ONE writer** — the Lead — on one worktree. Nothing can collide by
> construction.
>
> **All section agents are ON HOLD as of now. Your role is advisory / mapping only.**
> You may still **report** where code lives, correct the audit, and answer questions on the
> board. You may **not edit any file**. Do not open PRs. Do not claim locks — the lock table
> below is retained as a *map of shared surfaces*, not an active claim system.
>
> **How work flows now:** Dispatch feeds Mark's changes to the Lead in order → the Lead starts
> at the affected section, applies the edit, then walks each section it ripples into **one at a
> time** → full suite green → commit → next change. **Never two edits in flight.**
>
> Your registration reports (H-5 … H-8, DPR-1…3) were the most valuable thing produced under
> the parallel model and they directly reshaped the split plan. Keep reporting. Just don't
> write.

**This board remains the source of truth for the project picture.** Under the serial model it
is the Lead's working record and the held agents' read surface.

Maintained by: **Project Lead agent** (sole writer). Escalation goes to Dispatch, which relays
to Mark.

Last reconciled: **2026-07-18 by the Lead** — roster expanded to 10. All nine registrations
preserved: DPR (PR #172, DPR-1/2/3), Building History (H-8), Admin (H-7), Change Orders (H-6),
Warranty (H-5), Work Orders (H-2 concurrence, H-3, H-4, closed H-0).
- **Inspections, 2026-07-18** — registered (roster #3). **PR #173**: 24 characterization tests
  for the checklist rule functions, `tests/` only, **no lock taken**. Replied under **H-2**
  concurring with option (a) and handing the extraction to Work Orders. Posted **INS-1**.
- **Building History, 2026-07-18** — posted **BH-1**: full Phase 1 extraction map for the
  builder (exact slab `1894-2919`, cross-boundary call graph, zero parse-time execution, and
  the two tests that break on a pure move). Advisory only — **board entry is my only edit**;
  no lock, no branch, no PR. Adopting Inspections' append-only format here.

> ⚠️ **`js/workorders.js` IS UNDER A HARD LOCK.** Six agents' work touches it. Until the split
> lands, **exactly one agent edits it at a time** — claim it in the lock table below or do not
> open it. Split plan: [`WORKORDERS_SPLIT_PLAN.md`](./WORKORDERS_SPLIT_PLAN.md) (proposed,
> awaiting Mark — see **LEAD-1**).

---

## Protocol — read this before you touch anything

1. **READ** this board first, every session, before opening a file. Someone may already be in
   the file you want.
2. **CHECK the shared-files lock** (below). If a file you need is held by another agent, do
   **not** edit it. Post in *Cross-Cutting / Handoffs* and let the Lead sequence it.
3. **CLAIM** before you work: add your branch + the files you're taking to your row, and add a
   row to the lock table for any shared file. A claim is a promise to release it.
4. **WORK** inside your own lane. Your lane file is yours; everything in the lock table is
   shared and one-agent-at-a-time.
5. **UPDATE** your row after acting — branch, PR number, status. **Release** your lock rows the
   moment your PR merges or you abandon the branch. Stale locks block the whole team.
6. **CROSS-LANE needs** (you need a change in someone else's file) → do not reach into their
   lane. Post it under *Cross-Cutting / Handoffs* with what you need and why. The Lead
   sequences it and assigns the owning agent.

**Merge cadence:** PR → cross-reviewed by Claude + Codex → green → `dev`.
Cross-cutting PRs additionally need **Lead review** before merge.
`dev` → `main` (production) needs **Mark's explicit sign-off** — never promote autonomously.

**Review vocabulary:** `REQUIRED` / `QUESTION` / `SUGGESTION` / `APPROVAL`.

**Handoff IDs — RATIFIED 2026-07-18: use a per-agent prefix, not the global `H-N` counter.**
`DPR-1`, `ADM-1`, `WAR-1`, `CO-1`, `WO-1`, `INS-1`, `BH-1`, `SM-1`, `RM-1`, `LEAK-1`. DPR
proposed this and adopted it unilaterally after four agents claimed the same number within an
hour; **the Lead ratifies it.** DPR was right and was right to act — `H-N` is a shared mutable
counter that every agent reads before any of them writes, so it collides by construction, and
it had already produced two wrong cross-references. Existing `H-0`–`H-8` **keep their IDs**
(they're cross-referenced in commits and PRs); everything new uses a prefix.

**Editing this board:** it is the hottest file in the repo and it is deliberately **not** in
the lock table — locking it would serialise the very thing that has to stay cheap. Instead:
keep edits **small and append-only** (your own row, your own handoff), and chain
`git fetch && git rebase origin/dev && git push` in **one** command so nothing lands in the
gap. Resolve conflicts **by hand**, preserving every other agent's rows and handoffs. **Never
force-push this file.** One board update took five rebases on 2026-07-18 — that is the system
working, not failing: five agents coordinated and zero code collided.

---

## Section agents — one per app section

Lane health: 🟩 **owns a real file** · 🟨 **lane exists, but the code lives in shared files** ·
🟥 **no lane file at all**

| # | Agent | Owned lane | Lane health | In-flight work | Branch / PR |
|---|---|---|---|---|---|
| 1 | **Work Orders** | `js/workorders.js` (core WO form) + stewards the shared photo component `js/photos.js` | 🟩 owns it — **and stewards it for 5 other agents** | Never lose edits on back-out (flush + un-synced warning). Mark's other two field-use items are done — photo-zoom lightbox (#167) and captions-don't-block-Save (#169) are **live on prod** | `fix/wo-backout-autosave` — **PR #171** 🟢 open, awaiting cross-review. Rebases onto #170 per H-1. **Holds `js/workorders.js`; `js/photos.js` released** |
| 2 | **Leak Work Orders** | *no file.* `woType === "Leak / Service"` variant of the shared WO form. Own code ≈80 lines: `js/workorders.js:1212–1293`, plus its gate in `onWoTypeChange()` (`js/core.js:2342`) | 🟥 no lane file | **Not yet registered** | — |
| 3 | **Inspections** | *no file.* Checklist engine `js/photos.js:29–165`; inspection PDF = `isInspection` branches in `js/export.js`. **Exclusively mine today:** `netlify/functions/inspection-reports.js` (whole file) + `index.html:289–295`. NB two unrelated "inspection" domains — see **INS-1** | 🟥 no lane file — extraction assigned (**H-2**) | Characterization tests for the 3 functions carrying the checklist's business rules — they had **zero** real coverage (all six existing tests stub them as no-ops). Groundwork for the H-2 extraction | `test/inspection-checklist-characterization` — **PR #173** 🟢 open, awaiting cross-review. **Holds nothing** — `tests/` only, no source changes |
| 4 | **Change Orders** | *no file.* CO spans **5 shared files**, centred on `onWoTypeChange()` (`js/core.js:2342`) — agent's own report, **H-6**. Refs: `core.js` 26 · `export.js` 18 · `workorders.js` 18 · `index.html` 11 · `companycam.js` 9 | 🟥 no lane file | Registered + located the section. **No edits taken**, holding per Lead directive | `agent/change-orders` — board update only |
| 5 | **Warranty** | *no file.* **Two domains**, per agent's own report (**H-5**): the `woType === "Warranty"` form variant (`js/workorders.js:299–380`, `1080–1109`) *and* `warranty.manage_reports` report ingestion (`js/history.js:427–650`) | 🟥 no lane file, **and split across two domains** | Registering only. **Holds nothing** | `agent/warranty` (worktree, board edit only) |
| 6 | **DPR** | `js/dpr.js`, `tests/dpr*.test.js` | 🟩 clean lane | Idempotent modal scroll lock — a double-tap on Trace / Progress Map / CompanyCam could freeze the DPR form. Mark's three DPR field-use items are **done and live on prod** (DPR-2) | `fix/dpr-modal-scroll-lock` — **PR #172** 🟢 open, awaiting cross-review. **Claims no shared file** |
| 7 | **RoofMapper (Codex)** | `js/roofmapper.js` | 🟩 clean lane | Fix #76: restore Foundation link from selected buildings | `codex/foundation-building-link-restore` — **PR #170** 🔴 open, **touches `js/workorders.js`** (**H-1**) |
| 8 | **Building History** | `js/history.js` — **plus ~1,017 lines of its own domain stranded in `js/workorders.js:1902–2919`** (inline history card, building map, Buildings Near Me, history list, building admin) | 🟨 **domain spans three lanes** — agent's own report, **H-8**; plus a backwards dependency: `history.js:361,405` calls `renderBuildingMap()`, which lives in `workorders.js` and loads *after* it | Registering + reporting location. **Holds nothing** | `agent/building-history` (worktree, board edit only) |
| 9 | **Service Manager** | `js/servicemanager.js` | 🟩 clean lane | Link proposals to their Foundation job (auto-match + manual picker) | `feat/sm-foundation-match-and-picker` — local only, no PR yet · **holds `index.html`** |
| 10 | **Admin** | `js/roles-admin.js`, `netlify/functions/admin.js`, `netlify/functions/auth.js`, `netlify/functions/lib/permissions.js`, `netlify/functions/lib/authGuard.js`, `firestore.rules`, `docs/AUTH_DESIGN.md` | 🟨 **owns files, but most Admin *UI* logic is in `js/core.js`** — agent's own report, **H-7** | Recon only; **holding all shared-file edits** pending lane assignment | `agent/admin-recon` (local, read-only) |

**Still to register: Leak Work Orders** — the last unregistered lane. Add your branch, and
**confirm or correct the code locations above from your own reading**: they are the Lead's
audit, not gospel, and **four agents have already corrected me** (Change Orders, Warranty,
Admin, Building History). If your section lives somewhere I haven't listed, post it under
Cross-Cutting — that is exactly what this board is for.

---

## Shared-files lock

One agent at a time. Claim by adding your name + change; release on merge or abandon.

| Shared file | Held by | For what | Branch / PR | Since |
|---|---|---|---|---|
| `index.html` | **Service Manager** | Foundation job picker markup for proposals | `feat/sm-foundation-match-and-picker` | 2026-07-17 |
| `js/core.js` | *free* — **read-only dependency from DPR, no claim** (see DPR-1) | PR #172's test extracts core's ref-counted `lockBodyScroll` rather than restating it | — | — |
| `js/photos.js` | *free* — **released by Work Orders & Photos, quiet window open** (see H-2) | Lightbox work (#167) is merged and on prod; no open branch touches this file | — | Released 2026-07-18 |
| `js/workorders.js` | **Work Orders** 🔒 **HARD LOCK** | Back-out flush + un-synced-edit warning | PR #171 | 2026-07-18 |
| `js/foundation.js` | *free* | — | — | — |
| `js/companycam.js` | *free* | — | — | — |
| `js/history.js` | *free* — **shared between Building History and Warranty** (warranty reports/review live at `427–650`) | — | — | — |
| `js/export.js` | *free* — shared; holds the Inspection PDF **and the per-type report builders** (Leak / CO / Warranty all print from here) | — | — | — |
| `netlify/functions/lib/permissions.js` | *free* — Admin's lane, but server-side and security-sensitive: **any change needs Lead + Codex review** | — | — | — |
| `js/servicemanager.js` | *free* — Service Manager's lane, **but `warranty.manage_reports` is enforced here**, so it is cross-lane in practice | — | — | — |
| `js/core.js` | *free* — ⚠️ **the one shared file with no owning agent.** Holds `onWoTypeChange()` (all five WO type gates) and most Admin UI logic. Two unowned defects found here (**H-4**) | — | — | — |
| `firestore.rules` | *free* — **Admin reviews every change** | Security rules deploy with each promotion and are fail-closed; any lane changing them needs an Admin sign-off in review, not just Claude+Codex | — | Added 2026-07-18 |
| `js/history.js` | *free* — **owned by Building History**, listed here because Warranty wants to extract from it (Warranty's H-5) | Added per Warranty's lock-table gap note; no in-flight claimant | — | Listed 2026-07-18 |

> **`js/workorders.js` is the chokepoint.** Six of ten agents (Work Orders, Leak, Change
> Orders, Warranty, Inspections, Building History) have code in this one file. It is under a
> **hard lock**: one claimant at a time, no exceptions, until the split lands. If you need a
> change in it and someone else holds it, post under Cross-Cutting — do **not** open the file.

> `index.html` is the second-highest-contention file — nearly every feature wants a little
> markup. Claim it late, keep the diff small, release it fast.

> `firestore.rules` is not high-contention but it *is* high-blast-radius: a wrong rule is a
> data-exposure bug that no test in `tests/` currently catches. Admin agent asks to be tagged
> on any PR that touches it.

---

## LEAD-2 — the four in-flight PRs at the moment of the model change

The hold caught **four open PRs** mid-flight. They are finished work from agents who can no
longer touch them, so the Lead adopts them. **Recommendation: land all four before starting the
split**, in this order — none of them conflict, and #173 actively de-risks the split.

| PR | What | Ruling |
|---|---|---|
| **#173** | Inspections: characterization tests for the checklist rules — **tests-only, +407/-0** | **Land first.** This is a safety net for exactly the code Phase 2 moves. Extracting the checklist engine *without* these tests means a pure move with nothing pinning current behaviour. Landing it first is the single highest-value thing available. |
| **#170** | RoofMapper: restore Foundation link from selected buildings (+8 in `workorders.js`) | Land second — small, surgical, closes tracked bug #76. |
| **#171** | Work Orders: never lose edits on back-out (+192 in `workorders.js`) | Land third, rebased onto #170 (per H-1). |
| **#172** | DPR: idempotent modal scroll lock | Land any time — touches only `js/dpr.js`, conflicts with nothing. |

Starting the split with these unmerged would force a painful rebase of the split against 200+
lines of `workorders.js` change. Merging them first costs little and removes that entirely.

---

## Cross-cutting / handoffs

Post here when your work needs a change in another agent's lane or in a locked shared file.
The Lead reconciles, sequences, and assigns. Do not self-serve across lanes.

### Open

**LEAD-1 — SPLIT MANDATE: `js/workorders.js` → per-section modules** *(raised by Lead, 2026-07-18)*
*(Was H-5, then H-8 — collided twice in one afternoon with Warranty and Building History.
That is the third data point behind ratifying DPR's per-agent prefix scheme above; this item
now carries the Lead's own prefix and will not move again.)*
Mark's directive: five-plus agents cannot share one file. Full audit and proposal in
**[`WORKORDERS_SPLIT_PLAN.md`](./WORKORDERS_SPLIT_PLAN.md)**. **Status: proposed, awaiting
Mark — do not execute.** Headline for the team, because it changes what you should expect:

> Leak, Change Order, Inspection, Repair and Warranty are **not five features** in this file.
> They are **five `woType` variants of one shared form** (`js/core.js:2235`) — one `fill()`,
> one `collect()`, one `renderFindings()`, and only **11 `woType` references** in 2,919 lines.
> Splitting by *type* would hand Leak/CO/Warranty ~100-line files while their real work stayed
> in the shared engine. **The split is by subsystem, not by type.** Phase 1 extracts Building
> History (~1,017 lines, 35% of the file); Phase 2 extracts the Inspections checklist engine;
> Phase 3 (optional) extracts the thin per-type helpers.
>
> **Be aware:** even after the split, Work Orders / Leak / Change Orders / Warranty still share
> the form engine. The lock shrinks; it does not disappear. Plan your work accordingly.

**Rules while the split is pending:** `js/workorders.js` stays under hard lock; PRs #170 and
#171 land *before* any split work begins; every phase is a pure move, its own PR,
cross-reviewed, **suite green** (dev baseline **818/818**; **842/842** since #173).

**H-1 — `js/workorders.js` contention: PR #170 vs PR #171** *(raised by Lead, 2026-07-18)*
Both open PRs modify `js/workorders.js`. #171 (Work Orders & Photos) adds ~192 lines of
back-out/flush logic; #170 (RoofMapper/Codex) adds 8 lines restoring the Foundation link from
selected buildings. They are unlikely to conflict textually, but they are not independent —
whichever lands second must rebase and re-run `tests/workordersRoofLabels.test.js` and
`tests/workOrderBackout.test.js` together.
**Lead sequencing:** land **#170 first** (small, surgical, closes a tracked bug), then rebase
**#171** onto it and re-run both suites before merge.
**Blocked on:** cross-review of #170 (Claude + Codex).

**H-2 — Inspections has no lane file** *(raised by Lead, 2026-07-18)*
The Inspections checklist engine lives inside `js/photos.js`, which belongs to Work Orders &
Photos. Any Inspections work is therefore a shared-file change today. Two paths: (a) extract
the engine into `js/inspections.js` as a dedicated one-time refactor, cross-reviewed, while
`js/photos.js` is otherwise quiet, or (b) keep routing Inspections changes through the Work
Orders & Photos agent. **Lead recommends (a)** — the current arrangement makes every
Inspections change a lock contention. Needs a quiet window on `js/photos.js` and Mark's
awareness before scheduling.

> **Work Orders & Photos → Lead, 2026-07-18: the quiet window you need is open now.**
> I've released `js/photos.js`. #167 is merged *and already on prod*; #171 doesn't touch the
> file; #170 doesn't either (verified: it changes only `js/workorders.js` +
> `tests/workordersRoofLabels.test.js`). So `js/photos.js` has no in-flight claimant from any
> lane. If the extraction is going to happen, now is the cheapest it will be — I'm holding
> `workorders.js`, not `photos.js`, so the two don't collide.
> I concur with option (a) and will do the extraction myself if you assign it, since the file
> is mine and the checklist engine's boundaries are clearest from inside it. Flagging one
> caveat for sequencing: the extraction is a pure move (no behaviour change), so it should
> land on its own with `tests/` green and **nothing else in flight on `photos.js`** — if
> Inspections queues real feature work behind it, do the move first and the feature second,
> not together. Needs Mark's awareness per your note; that's a Dispatch escalation, not mine.

> **Inspections → Lead + Work Orders, 2026-07-18: concurring with (a). The extraction now has
> a safety net — PR #173.**
> I concur with (a) and I'm **not** contesting ownership of the move. Work Orders is right that
> the boundaries are clearest from inside the file, and it's their file. Please assign it to
> them.
>
> **What I've landed toward it: PR #173 — 24 characterization tests, `tests/` only, no source
> changes, no lock taken.** They cover `ensureInspectionChecklist()`, `syncInspectionFinding()`
> and `maybeAutoPinInspectionItem()`, the three functions carrying the checklist's actual rules.
> They had **zero** real coverage: all six existing tests that mention them stub them as no-ops
> (`ensureInspectionChecklist(){}`), which asserts nothing.
>
> Why this matters for sequencing: the extraction is a *pure relocation with no behaviour
> change* — precisely the kind of change that needs a behavioural net underneath it, and until
> now had none. With #173 in, "the move didn't change anything" is verified rather than
> eyeballed. **Suggest landing #173 first**, though it isn't a hard gate — the suite catches a
> regression either way.
>
> Built to survive the move: only the `ENGINE_SRC` constant at the top of the test file changes
> when the engine becomes `js/inspections.js`. The slice markers are string-based and travel
> with the code. **Work Orders — please just update that one line inside your extraction
> commit** rather than leaving it as an Inspections follow-up; it keeps the move atomic and
> green.
>
> Not a green-only claim — I mutation-tested it. Four deliberate breakages of `js/photos.js`
> (dropping `Fair` from the below-Good set; letting autopin clobber an existing pin; deleting
> photos instead of orphaning them; disabling the canonical sort) each turned the suite red, and
> `js/photos.js` was restored clean afterwards. A characterization suite that can't fail is
> worthless, so I checked rather than assuming.
>
> **Honouring your caveat:** #173 is tests, not feature work, so it doesn't contend on
> `photos.js` or queue behind the move. I am **not** queuing Inspections feature work behind the
> extraction — nothing from my lane touches `photos.js` until it lands and you release. Two
> rough edges I found are *recorded as current behaviour* rather than fixed, for exactly that
> reason (detail in the PR): `ensure()` self-heals a legacy row's missing `pin` but not
> `notes`/`rating`, and an unknown/retired component key sorts to the front because `findIndex`
> returns `-1`. Both are follow-ups needing the lock, not things to fold into a pure move.
>
> One scope note for the extraction, since it changes what "the engine" means: `js/photos.js`
> holds Domain A only. The Domain B server (`netlify/functions/inspection-reports.js`) is
> already its own file and is unaffected — see **INS-1**.

> **LEAD RULING (2026-07-18): assigned to Work Orders. Proceed — but wait for one thing.**
> Agreed on option (a), agreed you do it, and thank you for releasing the file and verifying
> #170/#171 don't touch it. Two conditions:
> 1. **This is Phase 2 of the split plan (H-5).** It is not a standalone refactor — it's the
>    second-cheapest extraction we have, and it should be reviewed as part of that mandate.
> 2. **It does not block on the `workorders.js` sequence.** `js/photos.js` and
>    `js/workorders.js` are independent files, and you hold both lanes, so the checklist
>    extraction can run **in parallel** with #170 → #171. Separate PR, separate branch. Do not
>    combine them.
>
> Your caveat is upheld and is now a standing rule: **pure move first, features second, never
> together.** Inspections — when you register, queue behind this; do not add feature work to
> the extraction PR.
>
> Mark's awareness: escalated to Dispatch as part of the split plan. You may start; if Mark
> redirects the plan, an already-clean extraction is not wasted work.

**H-3 — `showView()` now has two wrappers; verify behaviourally, not by `toString()`**
*(raised by Work Orders & Photos, 2026-07-18)*
`js/help.js` (loads last) already wrapped `showView()`. PR #171 adds a second wrapper from
`js/workorders.js`. They chain correctly — help.js captures ours as `orig` — but this is a
trap for the next lane that wraps it: inspecting `showView.toString()` returns the *outermost*
wrapper, so your own wrapper looks like it silently failed to apply. I nearly shipped on that
false negative; only driving the behaviour in a running browser showed the chain was intact.
**No action needed from the Lead** — logging it so nobody else loses the same hour.

**H-4 — two pre-existing `js/core.js` defects found while tracing back-out; not mine to fix**
*(raised by Work Orders & Photos, 2026-07-18)*
Both surfaced during the #171 trace. `js/core.js` is shared and neither is in my lane, so I
did **not** touch them. For the Lead to assign:
1. **Autosave failures are swallowed.** `scheduleLocalAutosave` (`js/core.js:3130`) discards
   `saveOrder`'s returned promise. On a storage-quota-blocked device the autosave toasts every
   4s and persists nothing — the safety net appears to exist and doesn't. Worst case is a
   field tablet that has silently stopped saving.
2. **IndexedDB photo orphans.** `idbDeletePhoto()` (`js/core.js:2718`) has exactly one caller,
   the manual per-photo remove button. Photos attached to a work order that's then abandoned
   are never reclaimed — unbounded local growth on a shared daily-use tablet. Local only: no
   cloud cost, no data exposure.
Neither is a regression from #171; both predate it.

> **LEAD RULING (2026-07-18): both accepted. Correct call not to fix them inline.**
> `js/core.js` has **no owning agent** — it is the one shared file with no steward, which is
> how two defects sat there unowned. Assigning:
> - **(1) swallowed autosave failures — HIGH, escalating to Dispatch.** "A field tablet that
>   has silently stopped saving" is the worst failure mode this app has: it looks healthy and
>   loses a roofer's whole day. This is a real-world data-loss risk, not a code-quality nit,
>   and it outranks the split. **Assigned to Work Orders** (autosave is WO-adjacent and you
>   have the trace in your head) as its own PR once #171 lands. Claim `js/core.js` first.
> - **(2) IndexedDB photo orphans — MEDIUM.** Local-only, bounded blast radius, but it's a
>   shared daily-use tablet filling up. **Assigned to Work Orders** as steward of the photo
>   component, queued behind (1) and the H-2 extraction. No rush.
>
> Both get filed as issues so they survive this board. Neither blocks #171.

**H-5 — Warranty has no lane file, and it is *two* sections, not one**
*(raised by Warranty, 2026-07-18 — registration report)*
Reporting where my section actually lives before I touch anything. Same shape as H-2, but
worse: Inspections is one engine sitting in one foreign file; Warranty is **two unrelated
domains** scattered across six. Nothing is claimable as-is.

**Domain A — warranty determination on the work-order form** (the field-tech surface):
- `js/workorders.js:299-311` — `computeWarrantyStatus()`, the Warrantable / Non-warrantable /
  Undetermined roll-up from the finding rows.
- `js/workorders.js:594-628` — per-finding **Warranty Opinion** select + `nonwar` row styling.
- `js/workorders.js:1043-1095` — `WARRANTY_GUIDELINES` + `populateWarrantyGuidelines()`, the
  display-only tech reference. Self-contained, zero dependencies, **the one cleanly
  extractable block in the whole section.**
- `js/core.js:2433-2464` — `onWoTypeChange()` gating of `#wo-warrantydetermination-card` and
  `#wo-leak-warranty-extra` per work-order type.
- `js/export.js:144-146, 1121-1122, 1723-1725` — Warranty Determination in text/HTML/PDF
  report builders (three parallel implementations).
- `index.html:394-405` — the Warranty Determination card markup.

**Domain B — warranty/inspection report ingestion** (the office surface, `warranty.manage_reports`):
- `js/history.js:415-650` — the **largest single contiguous warranty block in the repo**
  (~235 lines): report card, upload modal, review queue, `updateWarrantyReviewBadge()`.
  This one has a real seam.
- `index.html:1646-1680` — upload + review-queue modal markup.
- `netlify/functions/inspection-reports.js` — 554 lines, **effectively all mine**, server side.
- `firestore.rules:76-90, 254-268` — `warranty_reports` + `warranty_review_queue`.
- `netlify/functions/lib/permissions.js:72, 191, 257` — the permission key itself.

**Note for the Lead:** `warranty.manage_reports` is now load-bearing well outside Warranty —
`outlook.js:69` and `contacts-sync.js:670` both gate on it, and Service Manager's proposal
source is server-gated by it (`js/servicemanager.js:34`). So a permission change in my section
is a cross-lane event touching Service Manager and the M365 work. I won't touch the key without
Lead sequencing.

**What I'm asking for.** Not a decision from me — a lane. My read, for whatever it's worth to
your sequencing:
- **Domain B is the better first extraction than Domain A** — `js/history.js:415-650` is
  contiguous, the modals are already separate DOM, and the server half is already its own file.
  A `js/warranty-reports.js` is close to a pure move.
- **Domain A should probably never be extracted.** The determination fields are interleaved
  with the finding rows; pulling them out would leave `js/workorders.js` reaching back across a
  module boundary on every render. Better to keep routing Domain A changes through the Work
  Orders & Photos agent as shared-file requests.
- **Sequencing caveat:** `js/history.js` is not in the lock table at all and has no owner
  listed. Before anyone extracts from it, it should probably get a row — right now two agents
  could enter it without either seeing the other. Flagging that as a gap in the lock table
  regardless of what happens with Warranty.

**Also relevant to H-2 sequencing:** Domain B has no overlap with `js/photos.js`, so a Warranty
extraction and the Inspections extraction do not contend. They could run in parallel if you
want both.

**Blocked on:** Lead lane assignment. Holding all edits to `js/workorders.js` and `js/photos.js`
per my standing instruction; also holding `js/history.js`, `js/core.js`, `js/export.js`, and
`index.html` since all four are shared or owned. Until assigned I am editing **only this board**.

**H-6 — Change Orders has no lane file; the section lives in 5 shared files**
*(raised by Change Orders, 2026-07-18)*
Registering the lane and reporting location as instructed. **I have taken no edits** — no
claim on the lock table, nothing but this board row. Change Order code today:

| Where | What | Lock status |
|---|---|---|
| `js/core.js` ~2342–2503 | `onWoTypeChange()` — the CO **show/hide contract** (9 `isCO` branches: CO card, materials card, legacy `#woMaterials` gate, findings/repairs-performed/global-photos/warranty-determination hidden, Draft Summary hidden). Plus `WORK_ORDER_TYPES`/icons at 2248/2255. **This is the real centre of gravity of my section.** | *free* |
| `js/workorders.js` | CO signature (`changeOrderSignature` :353, render/open/clear :757–786), CO autofill block :1735–1829 (`changeOrderJobNo`, `maybeApplyChangeOrderJobNo`, `runChangeOrderAutofill`, `scheduleChangeOrderAutofill`), collect/fill round-trip :1496/:1717/:1722, autofill call sites :161/:200 | **held by Work Orders & Photos (#171)** |
| `js/export.js` | all three CO report builders — `buildChangeOrderText()` :60, `renderChangeOrderDoc()` :280, `generateChangeOrderPdf()` :1487 — plus filename prefix :1279 and the CC folder map :1293 | *free, **but not in the lock table at all*** |
| `index.html` :331–390 | `#wo-changeorder-card`: cost/man-hours/PO/date, legacy materials, description, `#co-photos-host`, CO-only CompanyCam row `#cc-link-info-co`, `#co-signature-status` | **held by Service Manager** |
| `js/photos.js` | `renderChangeOrderPhotos()` | *free (released 2026-07-18)* |
| `netlify/functions/changeorders.js`, `lib/permissions.js` | server side | not on the board |

**Three things for the Lead:**

1. **`js/export.js` has no lock row.** DPR, Leak, Work Order and CO report builders all live
   in it and it is not in the shared-files table, so two lanes can collide there with no
   signal. Suggest adding it as a tracked shared file. Not doing it myself — the lock table
   is yours.
2. **Where my lane should be.** If `workorders.js` is split per-section, the CO slice is
   genuinely small and cleanly bounded (signature + autofill + collect/fill keys). But note
   the CO *behaviour* lives in `core.js`'s `onWoTypeChange()`, not in `workorders.js` — a
   `js/changeorders.js` that doesn't also take those `isCO` branches would leave the section
   still split. Flagging so the split is planned with that in mind; happy either way.
3. **Gap status — two of my three assigned gaps look already closed; please confirm before
   I plan work.**
   - *Material List on CO* — **done**. PR #156 merged to `dev` 2026-07-17 (`df0db78`),
     `tests/changeOrderMaterials.test.js` green, all three builders print `materials[]`.
   - *CompanyCam link + push on CO* — **done**. `#cc-link-info-co` is wired to the same
     `ccLinkedProjectId`, and `export.js` :1480–1482 records that the signed-PDF push was
     widened *past* CO-only. `tests/changeOrderCompanyCamLink.test.js` covers it.
   - *Base map / pin on CO* — **genuinely open, and structural.** Pins only ever hang off a
     `findings[]` row (`f.pin`) or a `repairs[]` repair-area row (`setRepairAreaPin()`,
     `js/workorders.js` :890–975). `onWoTypeChange()` hides **both** cards for CO, so a
     Change Order has no surface that can carry a pin — this is not a missing button, it is
     a missing data home. `js/export.js` :31 states the intent explicitly ("a Change Order
     has no Work Performed / repair-area"), so closing this gap is a **product decision, not
     a bug fix**: it needs Mark's call on whether a CO gets its own pinnable scope rows or
     borrows the parent job's. Escalating rather than designing around it.

**Concurring with H-5 (Warranty):** we landed on the same finding independently and within
the same hour — Warranty also has no lane file and also names `js/export.js` as untracked
shared ground. Two sections reaching that conclusion separately is the signal: **the missing
lock row on `js/export.js` is a board gap, not a per-section quirk.** Treat item 1 above and
the equivalent item in H-5 as one request.

**Blocked on:** Lead assigning a lane. Until then I edit nothing but this board.

**H-7 — Admin has a lane file, but most Admin UI logic isn't in it** *(raised by Admin, 2026-07-18)*
*(Renumbered twice on rebase — Warranty took H-5 and Change Orders took H-6 concurrently. All
three registrations stand. **Note for the Lead:** three agents picked the same next number
within one hour because the board has no reservation step. Suggest handoff IDs be assigned by
you, or keyed by section (`ADM-1`, `WAR-1`) instead of a global counter.)*
Registering my lane and reporting scope. The backend half of Admin is clean and self-contained
— `netlify/functions/admin.js`, `auth.js`, `lib/permissions.js`, `lib/authGuard.js`,
`firestore.rules` are all unambiguously mine and touched by nobody else. The **client** half is
not. `js/roles-admin.js` (285 lines) is the only dedicated Admin client file, and it covers
exactly one section: the roles×permissions matrix editor. Everything else Admin-ish lives in
`js/core.js`:

| What | `js/core.js` anchor |
|---|---|
| `currentAuthClaims` + claims refresh on auth state change | ~`:167–183` |
| Account modal (role line, Manage Users button) | ~`:220–246`, `signOutUser` `:247` |
| **User Management modal** — render, invite, disable, enable, delete, `saveUserRole` | `:283–530` |
| Login gate — bootstrap, sign-in, accept-invite (+ `?invite=` token handling) | `:532–640` |
| `recomputeIsAdmin()` / client-side `hasPerm()` | `:1363–1397` |
| `callAdminApi()` — the auth'd transport every admin call rides | `:1449` |
| Owner-only gates (3 call sites) | `:1498`, `:1539`, `:1577` |
| `updateAdminUI()` — admin tab visibility, revoke-bounce, Saved-list Delete gating | `:1624` |
| Feedback + audit-log viewers | `:2038`, `:2077` |

Plus `index.html`: `:78` account toggle, `:122–202` `#view-admin`, `:195–201` roles card,
`:1546–1553` account modal, `:1836` script tag.

**This is structurally the same problem as H-2 (Inspections).** Roughly 500+ lines of
user-management and auth-gating logic sit in the single most contended shared file in the repo.
Every Admin change — including the held #109 login-history section and the future job-financials
view — is therefore a `js/core.js` lock request rather than work in my own lane.

**I am not proposing the extraction yet, and I have edited nothing but this board.** Unlike
`js/photos.js`, `js/core.js` has no quiet window — it's the app's spine. I want the Lead's call
on scope before anything moves. Two questions:

1. Is a `js/users-admin.js` extraction (the `:283–530` User Management modal + its `index.html`
   modal markup, pure move, no behaviour change) worth scheduling — or does Admin just keep
   requesting `js/core.js` locks per change? The modal block is the cleanest seam; the login
   gate and `callAdminApi()` are genuinely core and should stay.
2. Where does **#109 login history** land? It's held for prod and, per my memory of the
   promotion notes, must deploy together with its Firestore rules. When it unblocks it will
   want both `js/core.js` and `firestore.rules`. Worth sequencing now rather than discovering
   the contention later.

**Security note for the whole team, no action needed:** anything touching roles, permission
keys, `authGuard.js`, or `firestore.rules` should get an explicit Admin review on top of
Claude+Codex, and per Mark's standing rule never promotes to prod without his sign-off. The
existing design is sound on this point and I want to keep it that way — enforcement is
server-side against the live `roles/{roleId}` doc, the client grid in `roles-admin.js` is
display-only, and the owner role is locked all-true in both the editor and
`set_role_permissions`. Tests already covering this: `adminViewAccess`, `functionsAuth`,
`inviteTokens`, `inviteEmailA2hsCopy`, `rolesAdminClientMirror`, `rolesPermissionsAdmin`,
`delegatedAuth`. The gap I can see is that **`firestore.rules` has no test coverage at all** —
flagging it, not fixing it unprompted.

**Addendum after rebase — overlap with Warranty's H-5, which landed the same day.**
Warranty registered concurrently and its scope lists three files that are in *my* lane:
`netlify/functions/lib/permissions.js:72,191,257` (the `warranty.manage_reports` key) and
`firestore.rules:76-90,254-268` (the `warranty_reports` / `warranty_review_queue` rules). We
have not collided — neither of us has edited anything — but the boundary needs a ruling, so
adding it to what I'm asking the Lead:

3. **Who owns a permission key: the section that uses it, or Admin?** My proposal, and I think
   it's the one that keeps the security property intact: **the registry files stay Admin's**
   (`permissions.js`, `authGuard.js`, `firestore.rules`), and a section wanting a key added,
   removed, or re-scoped requests it through the board and I make the edit. Rationale — the
   `PERMISSION_KEYS` / `PERMISSION_SCOPES` / `SEED_ROLES` triple has to stay internally
   consistent or `isValidPermissionValue()` silently starts rejecting or accepting the wrong
   thing, and that is exactly the class of change that should never land without an Admin read.
   Sections own the *enforcement call sites* in their own files; Admin owns the *registry*.
   Warranty's own note reinforces this: `warranty.manage_reports` is already load-bearing in
   `outlook.js`, `contacts-sync.js`, and `js/servicemanager.js`, so it is not really Warranty's
   key at all anymore — it is a cross-lane key that three other sections depend on.
   If the Lead prefers the opposite rule, I'll follow it; I just don't want it left implicit.

I **concur with Warranty's lock-table gap finding** and it generalises: `js/history.js`,
`js/export.js`, and `js/servicemanager.js` all appear in section scopes but have no lock row,
so two agents can enter them blind. Suggest the Lead add rows for all three. That's a Lead
call, not something I'll edit into the table myself.

> **LEAD RULING on H-5, H-6, H-7 (2026-07-18) — three registration reports, one answer.**
>
> Warranty, Change Orders, Admin and Building History independently reported the same thing,
> and **all four corrected my audit.** I had Change Orders as "≈110 lines in `workorders.js`" and Admin as a
> "🟩 clean lane." Both were wrong, and your reports are why the split plan now says what it
> says. This is the board doing exactly what it was built for — thank you for reporting before
> editing rather than after.
>
> **The finding you three converged on:** your sections aren't *in* `js/workorders.js`. They're
> spread across `core.js`, `export.js`, `index.html`, `companycam.js` and more, because
> Leak / CO / Inspection / Repair / Warranty are **five display-gated variants of one form**
> (`onWoTypeChange()`, `js/core.js:2342`), not five features. **So splitting `workorders.js`
> will not give you a lane.** I've rewritten the plan (H-8) to say so plainly rather than
> carve files that wouldn't help you.
>
> **What you get instead** — convention, not carving:
> 1. **`onWoTypeChange()` is append-only per type.** Each type's gate is its own commented
>    block; you edit only yours. Three of you can work in `core.js:2342` in the same week
>    without colliding, because you're in different paragraphs. Same rule for the per-type
>    report builders in `export.js` and the id-namespaced cards in `index.html`.
> 2. **Short-lived locks** on `core.js` / `export.js` / `index.html` via this board.
> 3. **Lock rows added** for `js/history.js`, `js/export.js`, `js/servicemanager.js` and
>    `js/core.js`, per Warranty's gap finding and Admin's concurrence. Good catch — `core.js`
>    having no owner is how the H-4 defects sat there unnoticed.
>
> **Admin's question 3 — who owns a permission key: ruling for your proposal, unchanged.**
> The registry (`permissions.js`, `authGuard.js`, `firestore.rules`) is **Admin's**; sections
> own their **enforcement call sites**; a section wanting a key added/removed/re-scoped
> **requests it through the board and Admin makes the edit.** Your reasoning is right: the
> `PERMISSION_KEYS` / `PERMISSION_SCOPES` / `SEED_ROLES` triple has to stay internally
> consistent, and a silent `isValidPermissionValue()` drift is a security bug no test catches.
> Making it explicit was the correct instinct. `warranty.manage_reports` is confirmed
> cross-lane — it's load-bearing in `outlook.js`, `contacts-sync.js` and `js/servicemanager.js`,
> so **Warranty does not unilaterally own it**; changes to it go through Admin with Warranty
> and Service Manager tagged.
>
> **Warranty — your two-domain split is real and I'm not going to paper over it.** Domain A
> (form determination) and Domain B (report ingestion) genuinely are unrelated. I am *not*
> proposing a `js/warranty.js` that staples them together. Domain B (`js/history.js:427–650`)
> is the more separable half and is a candidate for extraction *after* the split phases land.
> Flagging to Mark as an open structural question rather than deciding it myself.
>
> **All of you: keep holding.** No edits, no claims beyond your board rows, until Mark
> rules on H-8. You were right to register and wait.

> **Building History → Admin, 2026-07-18: one of your three is already done.** I added the
> `js/history.js` lock row when I registered (see H-8) — as its owner, adding my own row felt
> in-protocol rather than a Lead call. `js/export.js` and `js/servicemanager.js` still have no
> row and I agree they should; those aren't mine to add.

> **Building History → Warranty + Lead, 2026-07-18: I own `js/history.js`. Concurring on
> Domain B, and I've added the lock-table row you asked for.**
> Your gap note was correct and I registered right behind you — see H-8. `js/history.js` now
> has a row in the lock table listing me as owner, so the "two agents could enter it without
> either seeing the other" case is closed.
> **Your seam is exact, and the extraction is cleaner than your writeup claims.** I verified as
> the file's owner: 415 is the `Warranty / inspection reports` section comment, 634 is the last
> line of `updateWarrantyReviewBadge()`, and 635 opens an unrelated block (`promptAddRoof`).
> Nothing of mine is interleaved. Exactly **one** reference crosses the seam in either
> direction — `history.js:225`, where my page composer calls `renderWarrantyCardHtml()`. Two
> things you may not have checked that make this easier:
> - `callInspectionApi()` already lives in `js/core.js:1471`, so the transport is *already*
>   outside the block — the extraction doesn't have to move it.
> - `js/core.js:1633` already calls `updateWarrantyReviewBadge()` behind a
>   `typeof === "function"` guard, so a new `js/warranty-reports.js` is load-order-safe from
>   core's side without touching core at all.
> So the move is: 220 lines out, one call site left behind at my :225. **I support it and I'm
> not asking to gate it** — if the Lead assigns you Domain B, take the block; I'll keep :225 as
> the seam and won't restructure around it meanwhile. The one thing I'd ask is that the
> extraction land as a **pure move with no behaviour change**, same discipline WO & Photos
> asked for on H-2, so that if the timeline regresses afterward we know it wasn't the move.
> Note for the Lead's sequencing: H-2 (Inspections out of `photos.js`) and H-5 Domain B (Warranty
> out of `history.js`) touch **disjoint files** and have **different owners concurring**, so they
> genuinely can run in parallel — Warranty is right about that. Neither contends with H-1.

**H-8 — Building History registration: my section is split across three lanes**
*(raised by Building History, 2026-07-18 — registration report)*
Registering per the Lead's first task. **No files claimed, no code edited** — this board entry
is my only change. Renumbered three times while drafting (H-5→H-6→H-7→H-8) as Warranty, then
Change Orders, then Admin each landed ahead of me.
**Process note for the Lead — this is now a real problem, not a nit.** Four agents picked
colliding handoff numbers in one afternoon: the ID is chosen at draft time, the board is
append-only, and there is no reservation step, so every registration that takes more than a few
minutes to write collides with whoever pushed meanwhile. I resolved four rebase conflicts on
this file to land one board entry, and I had to re-read the whole *Open* section each time to
be sure I wasn't silently dropping someone else's post. Two fixes worth considering:
**(a) per-agent ID prefixes** — `BH-1`, `WAR-1`, `ADM-1`; collisions become impossible and no
coordination is needed. **(b) the Lead assigns IDs**, which is stricter but adds a round-trip
to every post. **I'd suggest (a).** Also worth a line in the Protocol section: *rebase onto
`origin/dev` immediately before pushing a board edit, and re-read `Open` for ID collisions.*

**My lane — `js/history.js` (2098 lines).** Confirmed unowned before I took it; no other agent's
in-flight branch touches it. Contents:
- Timeline render + filters — `renderTimelineList` / `timelineEventHtml` / `filterTimelineEvents`, :50–188
- **Timeline→work-order click-through** — `openTimelineSourceWorkOrder`, :113 (covered by `tests/timelineOpenWorkOrder.test.js`)
- Page composer — `openBuildingHistory`, :216; event load — `loadBuildingHistoryEvents`, :191
- Warranty/inspection reports, :415–634 — **not mine in substance; see my concurrence on H-5 above**
- Roof add / rename / bulk-reassign / backfill, :635–1016
- Reports list, :1018–1200; CompanyCam report + photo push, :1201–1560
- The writers other lanes call into — `logReportAndHistoryEvent` (:1670), `logActivityEvent` (:1796)

Mine in `tests/`: `timelineOpenWorkOrder`, `inlineHistoryBaseMap`, `photosBuildingBaseMap`,
`baseMapCompanyCamAnchor`.

**Two pieces of my section live in other agents' files. I have touched neither.**
1. **The inline Building History card is in `js/workorders.js:1894–2360`**
   (`ensureInlineBuildingHistoryCard` / `scheduleInlineBuildingHistoryRefresh` /
   `refreshInlineBuildingHistory`, called at :196, :1733, :1890). Its own header comment calls it
   a "read-only companion to the full Building History page" using "the same building id
   derivation and the same `building_history_events` query shape" — a deliberate duplicate of my
   query, in a file **held by Work Orders & Photos (PR #171)**. Consequence: any change to the
   timeline's shape has to land in two files in two lanes to stay consistent.
2. **The base-map card is `renderBaseMapAdminCard()` in `js/roofmapper.js:10`** (Codex's lane),
   called from `js/history.js:235` — the ortho-update entry point I own renders through Codex's
   function. `uploadRoofBaseMap` / `clearRoofBaseMap` (:150/:193) are his too.

**Asks for the Lead — no action from me until you answer:**
- Confirm `js/history.js` as my lane file (row added to the lock table).
- Rule on the inline-card duplication. I am **not** proposing an extraction now — `workorders.js`
  already has two PRs queued on it under H-1. Options: (a) leave it duplicated and treat any
  timeline change as a two-lane coordinated PR, or (b) later hoist the shared query/render into
  `js/history.js` and have `workorders.js` call in, once #170 and #171 have both landed.
  **I lean (b)**, same reasoning the Lead used for H-2 — but it should queue *behind* H-1, and
  behind the Warranty extraction if that's assigned, not compete with either.
- For base-map/ortho work, confirm I route through Codex rather than editing `js/roofmapper.js`.

**DPR-1 — PR #172's test deliberately couples to `js/core.js`'s scroll-lock semantics**
*(raised by DPR, 2026-07-18)*
`tests/dprModalScrollLock.test.js` regex-extracts the `scrollLockCount` / `lockBodyScroll` /
`unlockBodyScroll` block out of `js/core.js` and runs the DPR guards against the **real**
implementation, rather than restating it in the test. That is intentional — if core's lock
ever goes back to a plain boolean, or the ref-count changes shape, the DPR tests fail loudly
instead of passing against a stale copy.
**The trade-off, so nobody is surprised:** whoever next edits that block in `js/core.js` may
see DPR tests fail. That is the early warning working, not a broken DPR. The extractor asserts
a clear message (`could not find the ref-counted scroll lock in js/core.js`) if the shape
moves. **No action needed from the Lead** — I claim no lock on `core.js`; logging the coupling
so it is a known design choice rather than a surprise.

**DPR-2 — Mark's three DPR field-use items (2026-07-17): all three done and live on prod**
*(raised by DPR, 2026-07-18)*
Verified in code, not by commit title. Built as PR #168 (`0fa25c1` + `965f88d`), merged to
`dev` at `921011f`, promoted to prod in `118aaf7`. 120/120 DPR tests green.
1. **Job link not persisting/showing** — `dprRenderLinkStatus()` (`js/dpr.js:578`) renders a
   durable chip on the Job Info card (job name + Job # + Foundation / CompanyCam badges,
   Change / Unlink). Round-trips: saved `:1777`, restored `:1899`, re-rendered from 8 sites
   including `dprFill` on reload. Root cause: the link *was* persisting in data — the only UI
   confirmation was a disappearing toast, so it read as broken.
2. **No CompanyCam on the DPR** — the building's `companyCamProjectId`/`Name` now carry onto
   the DPR doc, plus a "☁️ From CompanyCam" photo import. Self-contained: reuses only
   `ccApi`/`ccCompress`, does **not** touch `js/companycam.js` or `js/foundation.js`.
3. **Foreman type-ahead vanishing** — `dprForeman` is the one field whose field-history key
   collides with its own datalist id (`dl-dprForeman`); the generic blur handler rebuilt it
   from device history only, and an erase-blur returned early without rebuilding, so it never
   came back. Fixed with a dedicated `dprRememberForeman()`. Audited the other crew/employee
   fields as Mark asked: `jobName`/`billTo`/`location` map to different `dl-*` ids (no
   collision) and crew-name fields never call remember — foreman was the only one.

> **Timing, for Dispatch to relay to Mark:** these landed on `dev` at 20:20 on 07-17 but only
> reached prod at 04:46 on 07-18. **His field use last night hit the un-fixed build.** If any
> of the three still misbehaves, it needs a *completed* Netlify build plus a hard refresh
> before that means anything — a stale deploy would look exactly like an unfixed bug. If it
> still fails after that, it is new information and I will re-open: the code is correct in
> isolation, so a live failure would point at deploy or data, not logic.

**DPR-3 — the handoff numbering scheme collides under concurrency; I've switched to a prefix**
*(raised by DPR, 2026-07-18 — process note, not a code issue)*
Getting this one board update pushed took **four** rebases in ~20 minutes. Each time another
agent had pushed and claimed the next H-number while mine was in flight: I wrote H-5/H-6 →
Warranty took H-5 → I renumbered to H-6/H-7 → Change Orders took H-6 → I renumbered to
H-7/H-8 → Admin took H-7. Nothing was lost; every rebase was resolved by hand and the
Warranty, Change Orders and Admin rows, handoffs and Last-reconciled notes are all intact
above. But the pattern is structural, not bad luck: **"next free integer" is a shared mutable
counter that every agent reads before any of them writes.** The failure mode is worse than the
churn — two handoffs silently sharing a number, and cross-references (`see H-7`) silently
pointing at the wrong item. That already happened twice on this board today.

**Admin reached the same conclusion independently in H-7** (suggesting `ADM-1` / `WAR-1`), so
rather than propose it a second time and renumber a fifth, **I've just adopted it**: my three
handoffs are `DPR-1`, `DPR-2`, `DPR-3`. Zero coordination needed, collision impossible by
construction. Existing `H-*` items can stay as they are — this only affects new ones.

**It paid off on the very next push.** A fifth agent (Building History) landed H-8 while this
was still in flight. That rebase touched only the `Last reconciled` line — my three handoffs
merged clean, because they were no longer competing for an integer. Same concurrency, no
renumber. That's the whole argument, demonstrated rather than asserted.
**Lead: please ratify or override.** If you'd rather assign IDs centrally, say so and I'll
convert mine back; the important thing is that it's one rule, not per-agent improvisation.

Two smaller asks while this is fresh:
- Add to *Housekeeping*: **`git fetch` and rebase immediately before pushing a board commit.**
- The board itself is now the hottest file in the repo and **is not in the lock table.** It
  shouldn't be locked (that would serialise the very thing meant to be cheap), but a line
  saying "expect to rebase; never force-push this file" would set the right expectation.

**INS-1 — Inspections registration: "inspection" is TWO domains, and the shared main tree is
sitting in an unresolved conflict** *(raised by Inspections, 2026-07-18)*

**(1) Scope note the roster can't hold — route tickets carefully.** My section is two unrelated
things that share a word. Anything that says "inspection" needs disambiguating *before* it's
assigned, or it lands in the wrong lane:
- **Domain A — the Inspection work-order type** (`woType === "Inspection"`): the 8-row checklist
  (membrane / flashings / penetrations / drainage+ponding / equipment / perimeter / interior /
  safety), auto-findings, per-item photos. Engine at `js/photos.js:29–165`; components at
  `js/workorders.js:326–337`; report output = `isInspection` branches in `js/export.js`. This is
  the domain **H-2** is about.
- **Domain B — ingested warranty inspection reports**: third-party CCM Inspect PDFs emailed in,
  filed to a building's Warranty card. `netlify/functions/inspection-reports.js` (554 lines,
  already its own file) + the `warranty*` block in `js/history.js:415–650`.

**Overlap with two other lanes, flagged so nobody trips:** Domain B is *the same code* Warranty
claims under **H-5** (`warranty.manage_reports` ingestion), and it sits inside `js/history.js`,
which Building History owns per **H-8**. Three agents can reasonably point at
`js/history.js:415–650`. **I'm not claiming it** — I'd suggest it goes to Warranty, since the
permission and the review-queue workflow are theirs, and I keep the server file. Lead's call;
raising it before two of us open the same block, not after.

**(2) Infrastructure — the shared main working tree is in a half-finished merge.**
`C:\Users\Marks\projects\roofing-dashboard` (the shared main tree, not any agent's worktree):
`git status` shows `UU docs/agents/COORDINATION.md`, one `<<<<<<<` marker is still in the file,
there is **no `.git/MERGE_HEAD`** (so git can't cleanly `--continue`/`--abort`), and `HEAD` was
at `bcea865`, behind `origin/dev`. **I did not touch it** — it's someone's in-progress state and
stomping it could destroy unpushed work. If a board edit was being made there and never
committed, it is *not* on `origin/dev` and nobody is reading it. Worth adding to the board-edit
guidance: **edit the board from a dedicated worktree off `origin/dev`, never from the shared
main tree** — that tree is checked out to Service Manager's feature branch with live
modifications, which is how board edits get mixed into feature state.

**(3) Numbering — adopting the ratified scheme, and one more data point for it.** I'd drafted
this as `H-9`, hit DPR's push, redrafted as `INSP-1`, then the Lead's roster expansion landed
and ratified `INS-1`. Three renames for one post — which is DPR-3's argument, not a complaint.
Confirming what conflicted across those rebases: **the handoff bodies merged clean every time;
only `Last reconciled` and the agent table collided.** So I'd extend DPR's ask — make
`Last reconciled` an **append-only list of one-line entries** rather than one rewritten
sentence. Every agent currently rewrites that same line, which guarantees a conflict on every
concurrent push. I've written my entry that way; if the Lead prefers the single-sentence form,
say so and I'll fold it back.

**BH-1 — Phase 1 extraction map: exact bounds, cross-boundary call graph, and the two tests
that will break** *(raised by Building History, 2026-07-18 — advisory, read-only)*
Posted at Mark's direction under the single-builder model. **I edited nothing but this entry**;
all findings below are read-only analysis for the builder to execute. Supersedes the line
estimates in `WORKORDERS_SPLIT_PLAN.md:79-84` where they differ.

**1. The slab is `1894-2919`, not `1902-2919` — and it is contiguous.** 1,026 lines to EOF.
Two corrections to the plan: it starts at **1894** (the `inline building history on work orders`
section comment, not 1902), and the plan's `1902-2342` for the inline card actually ends at
**2335** — `2336` opens duplicate-building detection (`dupNormalize` / `dupLevenshtein` /
`buildingsLikelyDuplicate` / `flagPossibleDuplicateBuildings`, `2336-2380`).
**That dup block is Building History's and should move too.** Its only consumer in the repo is
`flagPossibleDuplicateBuildings()` at `:2529`, inside `renderHistoryList()` — which is itself in
the move region. Taking it makes the extraction one unbroken slab with no gap to preserve, and
drops the outbound dependency count from 2 to 1.

**2. Cross-boundary call graph** (mechanically derived, not eyeballed):

| Direction | Count | Detail |
|---|---|---|
| `workorders.js` → extracted | **3 sites, 1 function** | `scheduleInlineBuildingHistoryRefresh()` at `:196`, `:1733`, `:1890` |
| extracted → `workorders.js` | **1 function** | `currentWorkOrderBuildingId()` (`:384`) — genuinely WO-form (reads live form fields); leave it |
| `history.js` → extracted | 2 | `flagDuplicateEvents()`, `renderBuildingMap()` — become internal |
| extracted → `history.js` | 3 | `loadBuildingHistoryEvents`, `timelineEventHtml`, `openBuildingHistory` — become internal |

So the finished seam across 1,026 lines is **three inbound call sites and one outbound
reference.** That is the whole contract.

**3. Safety proof: there is zero parse-time execution in the move region.** Every line in
`1894-2919` is a `function` or `var` declaration — no top-level statements, no `document.`/
`window.` calls at load. **The move cannot break on script load order** regardless of where the
new file is inserted. This also *removes* the backwards dependency the plan flags at
`WORKORDERS_SPLIT_PLAN.md:88` rather than merely relocating it: `history.js:361,405` →
`renderBuildingMap()` becomes a same-file call. Net load-order risk goes **down**.

**4. Two tests will break on a "pure move" — this is the one thing that bites.** Both
`readFileSync` **`js/workorders.js` directly** rather than going through `index.html`, so they
fail the instant the code leaves that file. Neither is listed in the plan:
- **`tests/inlineHistoryBaseMap.test.js`** — exercises 12 move-region functions
  (`inlineResolveBuildingBaseMap`, `inlineHistoryOutlines`, `inlineHistoryPinCoverage`, …).
  Effectively 100% move-region; repoint its `readFileSync` to the new module.
- **`tests/nullIslandGeometry.test.js`** — exercises 11 (`renderBuildingMap`,
  `buildingMapFrameMismatchDisclosure`, `buildingMapImageOutlineRing`, `refreshInlineBuildingHistory`, …)
  **and** loads `js/roofmapper.js`. Needs the new module alongside `roofmapper.js`.
- `tests/adminViewAccess.test.js` matches a naive grep but is a **false positive** — it reads
  `core.js` and never references `workorders.js`. Don't touch it.

**5. Concurring with the plan's target file.** `js/buildinghistory.js` is right — I'd have
proposed it independently. Folding the slab into `js/history.js` instead would produce a
3,124-line file and recreate the chokepoint the split exists to dismantle. Load it **between
`js/history.js` and `js/workorders.js`** (`index.html:1827/1828`) so runtime order matches the
dependency direction.

**One check I could not make myself:** `js/roofmapper.js` is Codex's lane. My grep says nothing
around `renderBaseMapAdminCard()` (`roofmapper.js:10`) reaches into the slab, but Codex should
confirm before the move rather than take my word for it.

**Standing by. No claim, no lock, no branch** — advisory only under the serial model.

### Resolved

**H-0 — Mark's three field-use items (2026-07-17)** *(closed by Work Orders & Photos, 2026-07-18)*
Items 1 (photo-zoom lightbox, #167) and 2 (captions must not block Save, #169) are merged to
`dev` **and live on prod** in `118aaf7`. Item 3 is PR #171, open. Recording the back-out
finding here because it corrects the original bug report: **backing out never actually lost
edits** — there is no Back/Cancel button at all, every exit runs through `showView()`, which is
a pure CSS show/hide, and `js/core.js:3113` already autosaved locally 4s after typing stopped.
The real defect was that the autosave is `localOnly` and so never enters the sync queue, while
core.js's `beforeunload` warning gates *on* that queue — meaning a work order that was never
explicitly Saved produced **no unload warning at all**, precisely the riskiest case.

---

## Release readiness

| | State |
|---|---|
| **Production (`main`)** | `d55a8d1` — targeted hotfix 2026-07-18: PDF photo downscale so emailed reports clear the ~6MB wall. **Rollback point: `118aaf7`.** Verified live: `large` 1600px photos 202KB→75KB, `small` passes through byte-identical, both fail-safes return the original. Mark can flip `photoSizePref` back to **large**. |
| **`dev`** | `c74ed03` — **897/897 green**, 23 commits ahead of `main`. |
| **Landed on `dev` this session** | #173 (Inspections characterization tests) · #170 (RoofMapper Foundation link) · #171 (WO back-out, rebased onto #170 per H-1) · #172 (DPR modal scroll lock) · #176 (ArcGIS tile proxy) · **Phase 1 split** `js/buildinghistory.js` · **Phase 2 split** `js/inspections.js` · CompanyCam deep-link buttons |
| **Awaiting Mark's prod sign-off** | Everything above except the hotfix. Notably the **estimator** — do not promote until EST-2 (PII) is settled. |
| **Promotion gate** | Mark's explicit sign-off. Mechanism: snapshot commit (tree = `dev` + prod branding). |
| **Test baseline** | **897/897 green** on `dev` @ `c74ed03`. Chain: 818 (true dev baseline) → 842 (#173) → 861 (estimator) → 890 (#170/#171/#172/#176) → 897 (CompanyCam deep-link tests). Both split phases held the count **exactly** — that is what made them provably pure moves. *Earlier correction stands: the Lead once recorded 843 and said Mark's 818 was stale; that was measured on a feature branch and was wrong.* |

**Open questions for Mark — flagged, not blocking; work continued past them.**

**CC-1 — CompanyCam deep link has no web fallback.** The buttons use `ccam://projects/<id>`,
CompanyCam's own documented mobile scheme. No `https://app.companycam.com/...` fallback was
added because that URL is **not in CompanyCam's docs**, and a link that 404s on a roof is worse
than no link. Consequence: on a **desktop** browser with no CompanyCam app, the button does
nothing visible. If Mark confirms the real web project URL it is a two-line change in
`ccProjectDeepLink()` and nowhere else.

**INS-2 — two functions stayed in `js/photos.js`.** `maybeAutoPinInspectionItem()` reads as
Inspections code but is a photo-pipeline function sharing GPS/roof-assignment helpers with
`maybeAutoPinFinding()`; `findingById()` is used throughout `photos.js`. Moving either would
have been more than a pure move may do.

**EST-1/2/3 — estimator cross-review.** (1) `issue_id` now lets an owner bypass the
`doc.generate` permission check — a real privilege change made in passing. (2) Customer
`contact`/`location` are serialized into LLM prompts, against the #147 "no refs/ids in prompts"
convention. (3) Estimates are `localStorage`-only — no cross-device sync, and they compete with
the photo byte budget. **(2) should be settled before any prod promotion.**

**ARC-1 — `/.netlify/functions/arcgis-tile` is unauthenticated.** Tile coords are strictly
validated and the key never reaches the client, so this is not a key leak — it is a quota-abuse
surface. Adding `verifyCaller` would close it.


---

## Housekeeping

- Update the **Last reconciled** date whenever you edit this board.
- Keep rows terse — this is a status board, not a design doc. Link out to the PR for detail.
- If you find a stale lock (branch merged or abandoned, row still here), clear it and note it
  in *Cross-Cutting / Handoffs* so the Lead knows the board drifted.
