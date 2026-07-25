# RoofOps Agent Instructions

This repository is the source of truth for RoofOps Field, the Watkins Roofing field work order app.

Every assistant working here must preserve the current field workflow, avoid broad rewrites, and leave durable notes for the next assistant.

## Read First

Before changing code, read these files in order:

1. `README.md`
2. `PROJECT_VISION.md`
3. `APP_OVERVIEW.md`
4. `ARCHITECTURE.md`
5. `SECURITY_MODEL.md`
6. `DATABASE_SCHEMA.md`
7. `DEVELOPMENT_WORKFLOW.md`
8. `DEV_NOTES.md` for the specific area being changed
9. `ROADMAP.md` when the task affects product direction
10. The assigned GitHub issue or task prompt

If these sources conflict, stop and identify the conflict instead of silently choosing.

## Source Of Truth Priority

Use information in this order:

1. The current assigned GitHub issue or direct task
2. `AGENTS.md`
3. `PROJECT_VISION.md`
4. `SECURITY_MODEL.md`
5. `ARCHITECTURE.md`
6. `DATABASE_SCHEMA.md`
7. Existing code and tests
8. Existing docs
9. Prior chat history

Do not rely on remembered conversations when the repository says something different.

## Product Context

RoofOps Field is a working commercial roofing field app. It is used for Watkins Roofing service work.

It lets users create and amend work orders, document roof findings and repairs, add photos, place roof map pins, generate PDFs, email reports, sync with CompanyCam, maintain building history, use RoofMapper, manage daily progress reports, and support service-management workflows.

The app is field-first. A roofer on a roof should not be forced through an office-style workflow to do basic work.

## Architecture Rules

- Do not replace the app with a framework or build step unless Mark explicitly approves that migration.
- Preserve the static Netlify app architecture.
- Keep `index.html` and the `js/` modules working through plain script loading.
- Respect existing module boundaries and script load order.
- Make the smallest complete change that satisfies the task.
- Do not move code, rename fields, or split files as cleanup inside a feature task.
- Do not change unrelated files.

## Data And Security Rules

- Never expose API keys, service account JSON, bearer tokens, customer secrets, or private credentials.
- Firebase web config may be public; Firestore rules and server functions are the real security boundary.
- CompanyCam, Resend, Microsoft Graph, Foundation, Firebase Admin, ArcGIS, and AI-provider secrets stay server-side.
- Privileged or destructive work must be enforced server-side, not only hidden in the UI.
- Do not weaken `firestore.rules`.
- Do not add direct client deletes.
- Do not use production data casually. When production testing is unavoidable, use clearly labeled test records and approved cleanup paths.
- Do not deploy or promote production without Mark's explicit approval.

## Branch And PR Rules

- Never work directly on `main`.
- Use one branch per issue or task.
- One primary builder owns each branch.
- Do not edit another agent's active branch unless explicitly assigned.
- Keep changes reviewable.
- Do not merge your own work.
- Do not force-push unless Mark explicitly authorizes it.

## Testing Rules

Before declaring implementation complete:

1. Run relevant focused tests.
2. Run `npm test` when the change can reasonably affect shared behavior.
3. For UI changes, manually verify the affected workflow in a browser or deployed preview when possible.
4. For security or rules changes, include negative tests or a clear manual verification plan.
5. Report any tests that could not be run and why.

Do not claim tests passed unless they were actually run.

## Documentation Rules

Update documentation in the same branch when behavior changes.

Use:

- `APP_OVERVIEW.md` for user-facing workflow behavior.
- `ARCHITECTURE.md` for system structure.
- `DATABASE_SCHEMA.md` or `DATA_MODEL.md` for Firestore shape changes.
- `SECURITY_MODEL.md` or `docs/AUTH_DESIGN.md` for auth/security changes.
- `DEV_NOTES.md` for implementation gotchas, historical rationale, and bug context.
- `ROADMAP.md` for phased product direction.

## Completion Report

Every completed implementation report should include:

- What changed
- What did not change
- Files touched
- Tests run
- Security or data implications
- Deployment or environment requirements
- Known limitations
- Manual checks Mark should perform

## Prohibited Without Mark's Explicit Approval

- Merge to `main`
- Deploy to production
- Delete production records
- Purge buildings, work orders, reports, users, or training data
- Change Firebase Auth providers
- Rotate or reveal secrets
- Disable security rules
- Change billing, paid services, or production integrations
- Reintroduce Firebase Storage as a PDF system of record
- Replace CompanyCam as the preferred external report/photo record
- Re-architect the app into a framework/build-step app
