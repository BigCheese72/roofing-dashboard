# RoofOps Agent Coordination Board

**This board is the async source of truth for the agent team.** Agents cannot message each
other directly. Everything below is how we stay deconflicted: you read it, you claim here,
you update here. If it isn't on the board, it didn't happen.

Maintained by: **Project Lead agent**. Live cross-session coordination escalates to Dispatch,
which relays to Mark.

Last reconciled: **2026-07-18**

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

---

## Section agents

| Agent | Owned lane | In-flight work | Branch / PR | Status |
|---|---|---|---|---|
| **Service Manager** | `js/servicemanager.js` | Link proposals to their Foundation job (auto-match + manual picker) | `feat/sm-foundation-match-and-picker` — local only, no PR yet | 🟡 In progress — **holds `index.html`** |
| **Inspections** | inspection module (checklist / findings / inspection PDF) | None claimed | — | ⚪ Idle. **Note:** no `js/inspections.js` exists; the checklist engine currently lives inside `js/photos.js` — coordinate with Work Orders & Photos before touching it |
| **DPR** | `js/dpr.js` | None claimed | — | ⚪ Idle |
| **Work Orders & Photos** | `js/workorders.js`, `js/photos.js` (owns the shared photo lightbox) | Never lose edits on back-out (flush + un-synced warning) | `fix/wo-backout-autosave` — **PR #171** | 🟢 Open, awaiting cross-review — **holds `js/workorders.js`** |
| **RoofMapper (Codex)** | `js/roofmapper.js` | Fix #76: restore Foundation link from selected buildings | `codex/foundation-building-link-restore` — **PR #170** | 🔴 Open — **touches `js/workorders.js`, which #171 holds. Lead is sequencing (see Handoff H-1)** |

---

## Shared-files lock

One agent at a time. Claim by adding your name + change; release on merge or abandon.

| Shared file | Held by | For what | Branch / PR | Since |
|---|---|---|---|---|
| `index.html` | **Service Manager** | Foundation job picker markup for proposals | `feat/sm-foundation-match-and-picker` | 2026-07-17 |
| `js/core.js` | *free* | — | — | — |
| `js/photos.js` | *free* | — | — | — |
| `js/workorders.js` | **Work Orders & Photos** | Back-out flush + un-synced-edit warning | PR #171 | 2026-07-18 |
| `js/foundation.js` | *free* | — | — | — |
| `js/companycam.js` | *free* | — | — | — |

> `index.html` is the highest-contention file in the repo — nearly every feature wants a
> little markup. Claim it late, keep the diff small, release it fast.

---

## Cross-cutting / handoffs

Post here when your work needs a change in another agent's lane or in a locked shared file.
The Lead reconciles, sequences, and assigns. Do not self-serve across lanes.

### Open

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

### Resolved

*(none yet)*

---

## Release readiness

| | State |
|---|---|
| **Production (`main`)** | `118aaf7` — promoted 2026-07-18. DPR (crew/hours, toolbox talk, weather, section chips, foreman datalist), Service Manager workspace + AI scope-draft, photo lightbox zoom, RoofMapper job-link + Foundation anchor, tap-to-call, Help Center, contacts-sync inbox rules / morning-brief / create-draft. |
| **`dev` ahead of `main` by** | 1 commit — `eeb53e6`, login-gate scroll-lock fix (back-port of prod hotfix `27bacb9`, adapted to dev's ref-counted `lockBodyScroll`). |
| **Queued for next nightly promotion** | `eeb53e6` (scroll-lock fix). Anything that merges to `dev` before the next promotion joins this list. |
| **Promotion gate** | Mark's explicit sign-off. Mechanism: snapshot commit (tree = `dev` + prod branding). |

**In the pipe, not yet on `dev`:** PR #170 (RoofMapper), PR #171 (Work Orders & Photos),
Service Manager Foundation-match branch (no PR yet).

---

## Housekeeping

- Update the **Last reconciled** date whenever you edit this board.
- Keep rows terse — this is a status board, not a design doc. Link out to the PR for detail.
- If you find a stale lock (branch merged or abandoned, row still here), clear it and note it
  in *Cross-Cutting / Handoffs* so the Lead knows the board drifted.
