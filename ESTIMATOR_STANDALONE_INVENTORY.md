# Estimator — extraction inventory for the standalone tool

**This branch (`estimator-standalone`) is the preserved copy of the estimator.** It is pinned at
`23d25b6`, the last dev commit that contained the estimator in full. **Do not delete this
branch.** After the removal lands on `dev`, this is the only place the code exists.

Written by the Project Lead agent, 2026-07-18, as Step A of Mark's decision to pull the
estimator out of RoofOps and rebuild it as a standalone tool outside the app.

---

## ⚠️ Read this first: "estimator" means two unrelated things in this repo

| | |
|---|---|
| **The estimator TOOL** | Codex's owner-only estimating workspace. This is what moves out. |
| **The `estimator` ROLE** | A pre-existing job role in the permissions system — a person whose job is estimating. **Nothing to do with the tool. It stays in RoofOps.** |

A blind find-and-replace on the word "estimator" would delete a live role and break the roles
grid, the DPR role tests, and the permissions registry. The removal commit deliberately leaves
every one of these alone:

- `netlify/functions/lib/permissions.js` — the `estimator` role definition (id/label)
- `docs/AUTH_DESIGN.md`, `ROADMAP.md` — role documentation
- `netlify/functions/contacts-sync.js` — `TITLE_WORDS` regex (matches the job title in signatures)
- `tests/dpr.test.js`, `tests/rolesPermissionsAdmin.test.js` — role-permission tests

---

## What comprises the estimator tool

### Owned outright (whole files — lift these first)

| File | Size | Contents |
|---|---|---|
| `js/estimator.js` | 1,249 lines · 61 functions | The entire client: intake form, deterministic EPDM SA calculator, saved job files, RoofMapper map import, CompanyCam project linking, proposal text generation, line-item repricing |
| `tests/estimator.test.js` | 335 lines | Its test suite |

All 61 functions are `estimator*`-prefixed, verified to have **zero global-namespace collisions**
with the rest of the app. That naming discipline is why the extraction is clean.

Entry points the UI calls: `estimatorOnShow`, `estimatorOpenRoofMapperMaps`, `estimatorAskAi`,
`estimatorApplyEpdmSaRules`, `estimatorCalculateFromForm`, `estimatorSaveCurrent`,
`estimatorOpenSaved`, `estimatorCreateProposal`.

### Server-side AI (extract, do not re-point at RoofOps)

`netlify/functions/lib/aiProvider.js` — the estimate-intake block, roughly lines 606–740:
- `MAX_ESTIMATE_TOKENS`, `ESTIMATE_NUMERIC_FIELDS` (31 fields), `ESTIMATE_TEXT_FIELDS`,
  `ESTIMATE_ENUMS`
- `ESTIMATE_PLAYBOOK` — **the Warrensburg Post Office estimating playbook.** This is the
  domain knowledge worth the most here: EPDM SA specifics, fastener/screw rules, splice-tape
  ratios, RPF/RUSS, warranty and markup structure. Do not lose this prose.
- `ESTIMATE_SYSTEM` — the system prompt
- `sanitizeEstimateInput`, `clampEstimateFields`, `clampEstimateDraft`,
  `composeStubEstimateDraft`, `draftEstimate`, and the local `n()` numeric coercion helper
- `draftEstimate` in `module.exports`

`netlify/functions/ai-service.js` — the `action === "estimate_epdm_sa"` branch and its
owner gate.

### Shared UI wiring (removed from RoofOps; rebuild natively in the standalone)

- `index.html` — `#tab-estimator` button, the whole `#view-estimator` section (~160 lines),
  and the `<script src="js/estimator.js">` tag
- `css/app.css` — the `.estimator-*` rules (21 lines: hero, layout, results grid, tables)
- `js/core.js` — owner-gated tab visibility in `updateAdminUI()`, the `estimator` entry in
  `FEEDBACK_VIEW_LABELS`, the `showView()` owner gate and view list entry, and the
  `estimatorOnShow()` dispatch
- `js/help.js` — the `estimator:` help-topic mapping

### Reverted as part of the removal (EST-1)

`netlify/functions/ai-service.js` previously gated the whole endpoint with
`requirePermission(event, "doc.generate")`. The estimator changed it to `verifyCaller` plus a
per-action check in which **an owner bypasses the `doc.generate` check entirely** for
`issue_id`. That was a privilege change to an existing endpoint, made in passing. With the
estimator gone the original gate is restored.

---

## Notes for whoever builds the standalone

1. **Storage is `localStorage`-only** (`ESTIMATOR_STORE_KEY`). No Firestore, no rules. Saved
   estimates do not sync across devices and share the browser's 5–10MB budget with photos.
   A standalone tool should almost certainly pick real storage.
2. **The AI never prices the job.** The prompt is explicit — *"Never invent a dimension… Return
   missing items as missingInputs"* — and the model output is whitelist-clamped to known
   numeric/enum/text fields. The deterministic calculator does the arithmetic. **Preserve that
   split**; it is the reason the feature was trustworthy.
3. **The PII question that triggered this move (EST-2) follows the code.** `ESTIMATE_TEXT_FIELDS`
   includes `contact` and `location`, which are serialized into the prompt. Moving the tool out
   of RoofOps removes it from the app, but the standalone still needs a deliberate answer on
   whether customer contact details go to a third-party model.
4. **RoofMapper and CompanyCam coupling.** `estimatorCollectRoofMapperMaps` /
   `estimatorApplyRoofMapperMap` read RoofMapper's local outlines, and the CompanyCam link
   functions call the app's `ccApi` proxy. The standalone needs its own path to both, or those
   features come out.
