# Split plan — `js/workorders.js`

**Status: PROPOSED — awaiting Mark's review. Do not execute.**
Author: Project Lead agent · 2026-07-18 · Baseline: `dev` @ `a851763`, **842/842 tests green**
*(= the true dev baseline of **818/818**, plus the 24 tests #173 added. An earlier revision of this
doc said 843 and claimed Mark's 818 was stale — that was a measurement taken on a feature
branch by mistake. **818 was right.**)*

---

## Headline: the file is not shaped the way we assumed

The mandate assumed Work Orders, Leak Work Orders, Change Orders, and Warranty are four
features tangled together in one file, and that splitting them apart gives four clean lanes.

**The audit says otherwise.** They are not four features. They are **five `woType` variants of
one shared form.**

```js
// js/core.js:2235
var WORK_ORDER_TYPES = ["Leak / Service", "Change Order", "Inspection", "Repair", "Warranty"];
```

One `fill()` loads any type, one `collect()` saves any type, one `renderFindings()` renders any
type. Across 2,919 lines there are only **11 `woType` references and 5 real branch points**:

| Line | Branch |
|---|---|
| 1728 | `woType === "Inspection"` → build checklist |
| 1779 | `woType !== "Change Order"` → skip job-no autofill |
| 1805 | `woType !== "Change Order"` → skip autofill |
| 1933 | `woType` change → refresh inline history |
| 2297 | `woType === "Inspection"` → pin toggle label |

The genuinely type-specific code inside `workorders.js` is **tiny**:

| Section | Lines | Where |
|---|---|---|
| Leak | ~80 | `isLeakNoJobName`…`renderLeakNoJobBadge` (1212–1293) |
| Change Order | ~110 | CO signature (756–792) + job-no autofill (1759–1829) |
| Warranty | ~110 | `computeWarrantyStatus` (299–380) + `populateWarrantyGuidelines` (1080–1109) |

### …and the type logic that *does* exist is not even in this file

*(Correction to my first pass — caught by the Change Orders lane's own notes, then verified.)*

The real type-switching lives in **`onWoTypeChange()` at `js/core.js:2342`**. It is a **pure
display-gating function**: it shows and hides cards per `woType`. Its own comments are explicit —

> *"DISPLAY GATING ONLY — collect()/fill() round-trip materials[] for every type"*

The data model is entirely type-agnostic. A Change Order and a Leak Work Order are the **same
record shape**; they differ by which cards are visible and which report builder prints them.

Change Order references by file: **`core.js` 26 · `export.js` 18 · `workorders.js` 18 ·
`index.html` 11 · `companycam.js` 9 · `photos.js` 4.** Only a quarter of it is in the file we
were going to split.

**This makes the type-split conclusion much stronger.** Splitting `js/workorders.js` by type
would hand the Leak / Change Order / Warranty agents ~100-line files while their *actual* lane —
a branch in `onWoTypeChange()` in `core.js`, markup in `index.html`, a report builder in
`export.js` — stayed exactly as shared as it is today. **It would not reduce their collisions
at all.** It would just move a small amount of code and let everyone believe the problem was
solved.

### Why splitting by type would make collisions *worse*

If we create `js/leak.js`, `js/changeorder.js`, `js/warranty.js`, each agent gets a ~100-line
file — and **their actual work still lands in the shared form engine.** A Leak agent changing
how leak findings save is editing `collect()`. A Warranty agent changing the warranty date
field is editing `fill()`. We would have spent a risky 2,900-line refactor and the four agents
would contend on the *same* shared file as before, except now the lock is harder to reason
about because the lane boundary lies about where the work is.

**Splitting by `woType` is the wrong axis. The right axis is subsystem.**

---

## What *is* cleanly separable — the real finding

The largest genuinely independent thing in `js/workorders.js` is **not a work-order type at
all. It is Building History** — roughly **1,017 lines (1902–2919)**, about **35% of the file**:

- inline building-history card on the WO form (1902–2342)
- duplicate detection + Buildings Near Me (2343–2504)
- `renderHistoryList()` and building admin archive/unarchive/delete (2505–2636)
- the whole Leaflet building-map renderer (2648–2919)

And there is already a **`js/history.js` (2,098 lines)** that owns Building History. So the
Building History agent's domain is split across two files today — with a **backwards
dependency**: `js/history.js:361,405` calls `renderBuildingMap()`, which lives in
`js/workorders.js`, and `history.js` loads *first* (`index.html:1850–1851`). It works only
because the call happens at runtime, not load time. That is fragile and it is the single
clearest lane violation in the codebase.

Second finding, already tracked as handoff H-2: the **Inspections checklist engine lives in
`js/photos.js:40–165`** (`ensureInspectionChecklist`, `renderInspectionChecklist`), called from
`core.js:2474` and `companycam.js:344`. Inspections has no lane file either.

---

## Proposed split — by subsystem, in risk order

### Phase 1 — extract Building History *(the big win, ~1,017 lines)*
Move the building-history block out of `js/workorders.js` into **`js/buildinghistory.js`**, and
fix the load order so it sits next to `js/history.js`. This alone removes ~35% of the contended
file and resolves the backwards dependency.

- **Gives a clean lane to:** Building History agent
- **Removes from contention:** ~1,017 of 2,919 lines
- **Risk:** low. Pure move — no logic edits. Functions are globals on `window`; call sites are
  unchanged. Load-order change in `index.html` is the only structural edit.
- **Tests:** `inlineHistoryBaseMap`, `timelineOpenWorkOrder`, `buildingMatch`,
  `stableBuildingId`, `nullIslandGeometry` must stay green.

### Phase 2 — extract the Inspections checklist engine *(~130 lines)*
Move `ensureInspectionChecklist` / `renderInspectionChecklist` and the checklist item helpers
out of `js/photos.js` into **`js/inspections.js`**. Closes handoff H-2.

- **Gives a clean lane to:** Inspections agent
- **Risk:** low–medium. `photos.js` is actively stewarded; needs a quiet window on that file.
- **Tests:** `findingWithPhotosVisible`, `findingRepairPairing`, `inspectionCompanyCamLink`.

### Phase 3 — the per-type modules — **I now recommend AGAINST this**
Originally proposed as `js/leak.js`, `js/changeorder.js`, `js/warranty.js`. Having found
`onWoTypeChange()`, I don't think it earns its risk. It would move ~300 lines out of a
2,900-line shared file, and leave those three agents contending on `core.js`, `export.js` and
`index.html` exactly as before — while spending a risky refactor on the shared form engine to
get there. **Recommend: skip.** See "What Leak / CO / Warranty actually need" below.

### What Leak / Change Orders / Warranty actually need instead
Their collisions are not solved by splitting a file, because their code isn't concentrated in
one. What reduces *their* collision risk is **convention, not carving**:

1. **`onWoTypeChange()` is append-only per type.** Each type's gating is its own clearly
   commented block. Agents touch only their own block. It is already written this way — this
   just makes it a rule, and it means three agents can edit `core.js:2342` in the same week
   without conflicting, because they're editing different paragraphs.
2. **Report builders in `export.js` are already per-type.** Same rule.
3. **`index.html` cards are per-type and id-namespaced** (`#wo-changeorder-card`,
   `#wo-materials-card`). Same rule.
4. **Short-lived locks on `core.js` / `export.js` / `index.html`** via this board, rather than a
   structural split that wouldn't help.

This is a smaller, safer answer than the mandate assumed, and I believe it is the correct one.

### What deliberately stays shared
`js/workorders.js` after the split ≈ **1,500 lines** of genuine shared form engine:
`collect()`, `fill()`, `renderFindings()`, findings/repair pairing, materials, pins and repair
areas, the signature pad, and the building picker. **This stays a locked shared file
permanently.** Work Orders agent stewards it; everyone else requests changes through the board.

### Net effect

With Phases 1 + 2 only (Phase 3 dropped):

| | Before | After |
|---|---|---|
| Lines in `workorders.js` | 2,919 | ~1,900 |
| Agents with a real owned file | 5 of 10 | 7 of 10 (+ Building History, + Inspections) |
| Agents still sharing the form engine | 6 | 4 (Work Orders, Leak, CO, Warranty) |

That is a real improvement, and it is **less than "every agent gets a clean lane."** I would
rather say so now than promise clean lanes and have four agents discover the lock is still
there. The honest summary: **two agents get a genuine lane out of this; four keep sharing, and
their contention is managed by the board and by per-type conventions, not by carving files.**

---

## Sequencing rules (non-negotiable)

1. **One phase at a time**, each its own PR, each cross-reviewed (Claude + Codex) before `dev`.
2. **`js/workorders.js` is frozen to all other agents** for the duration of each phase. The
   Lead holds the lock on the board; the split PR is the only thing touching it.
3. **842/842 green after every phase.** A pure move that changes a test count is not a pure
   move — stop and investigate.
4. **Pure moves only.** No behavior changes, no cleanups, no "while I'm in here." Any bug found
   during the move gets filed, not fixed inline — a move PR must be reviewable as a diff of
   *location*, not logic.
5. **PRs #170 and #171 land first.** Both touch `js/workorders.js` today (handoff H-1).
   Starting the split before they merge would force a painful rebase on both.

## Decisions I need from Mark

1. **Approve Phases 1 + 2, drop Phase 3?** That is my recommendation. Phase 1 (Building
   History, ~1,017 lines) and Phase 2 (Inspections checklist) are clear wins with real lanes at
   the end. Phase 3 moves ~300 lines and helps nobody meaningfully.
2. **Accept that Leak / Change Orders / Warranty will not get their own files?** Their code is
   spread across `core.js`, `export.js`, `index.html` and `workorders.js` by design — it's one
   form with display gates. They get board-managed locks and per-type conventions instead. If
   you want them to have real files, that is a much larger re-architecture than a file split,
   and I'd want to scope it separately rather than smuggle it in here.
3. **One note on the baseline:** the mandate said keep 818/818 green. The suite is now
   **842/842** (818 baseline + 24 from #173). ~~I said 843 and that the mandate's 818 was stale.~~
   **Retracted — 818 was correct; I had measured a feature branch.** Floor is 842.

Nothing has been executed. `js/workorders.js` is under hard lock on the board, so nobody is
colliding while this waits.
