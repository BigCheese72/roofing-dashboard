# RoofOps Development Workflow

RoofOps is built through small, reviewable changes. The app is in real use, so stability matters more than speed.

## Branch Rules

- Do not work directly on `main`.
- Use one branch per issue or task.
- Use descriptive branch names:
  - `codex/123-short-description`
  - `claude/123-review-fix`
  - `fix/workorder-save-warning`
  - `feat/building-history-filter`
- One primary builder owns each branch.
- Do not share an active branch between coding agents.
- Do not merge your own work.
- Do not force-push without explicit approval.

## Normal Feature Flow

1. Mark describes the desired result.
2. ChatGPT turns it into a GitHub issue with requirements and acceptance criteria.
3. Codex implements the issue on its own branch.
4. Codex runs tests and prepares a pull request.
5. Claude or another reviewer performs independent technical review.
6. ChatGPT performs final product/architecture review when useful.
7. Mark tests or approves the result.
8. Only after approval does the change merge/promote.

## Before Coding

Read:

1. `AGENTS.md`
2. `README.md`
3. `PROJECT_VISION.md`
4. `APP_OVERVIEW.md`
5. `ARCHITECTURE.md`
6. `SECURITY_MODEL.md`
7. `DATABASE_SCHEMA.md`
8. `DEV_NOTES.md` sections related to the task
9. The assigned GitHub issue

Then inspect the existing implementation and tests.

## Implementation Rules

- Keep the change scoped to the issue.
- Preserve existing behavior unless the issue explicitly changes it.
- Avoid broad cleanup mixed into feature work.
- Avoid introducing dependencies unless necessary.
- Respect current plain-script load order.
- Do not add a build step unless explicitly approved.
- Do not bypass server-side authorization.
- Do not add client-only gates for sensitive work.
- Keep mobile field usability in mind.

## Testing

Install dependencies in a fresh clone before running tests.

```bash
npm install
npm test
```

On Windows PowerShell, if `npm` is blocked by script policy, use:

```bash
npm.cmd test
```

Testing expectations:

- Run focused tests during development.
- Run full `npm test` before broad or shared changes are declared complete.
- Add tests for new behavior.
- Add negative tests for security and permission changes.
- For UI behavior, verify in a browser or Netlify preview when practical.
- For integration work, document whether it was tested live, mocked, or only inspected.

## Documentation Updates

Update docs in the same branch when behavior changes.

- User workflow change: update `APP_OVERVIEW.md`.
- Architecture/module change: update `ARCHITECTURE.md`.
- Firestore shape change: update `DATABASE_SCHEMA.md` and possibly `DATA_MODEL.md`.
- Auth/rules/permissions change: update `SECURITY_MODEL.md` and possibly `docs/AUTH_DESIGN.md`.
- Gotcha, bug rationale, or implementation history: update `DEV_NOTES.md`.
- Product phase or future direction: update `ROADMAP.md`.

## Pull Request Requirements

Every PR should include:

- Issue addressed
- Summary of changes
- Files and systems affected
- Screenshots for visual changes
- Tests run and results
- Security implications
- Firestore rules/index changes
- Environment variable changes
- Deployment/migration steps
- Known limitations
- Manual verification steps for Mark

## Review Standard

Reviewers should classify findings as:

- `BLOCKER`: must fix before merge.
- `IMPORTANT`: meaningful reliability, security, usability, or maintainability concern.
- `SUGGESTION`: improvement, not required.
- `PASS`: area checked and appears correct.

Review should check:

- Requirement match
- Role/permission behavior
- Firestore rules and queries
- Server-function enforcement
- Error/empty/loading states
- Mobile usability
- Backward compatibility
- Test coverage
- Unrelated file changes
- Documentation updates

## Production Promotion

Production promotion requires Mark's explicit approval.

Do not:

- merge to production without approval
- deploy manually without approval
- change Netlify production env vars without approval
- run data cleanup or migration on production without approval
- delete or purge production data without approval

## Data Cleanup And Migrations

Live data cleanup must be scoped separately from feature work.

Before any data migration:

1. Write the migration plan.
2. Identify collections and records affected.
3. Define rollback or recovery options.
4. Test on clearly labeled test data or dev data first.
5. Get Mark's approval.
6. Log the outcome in docs.

## Multi-Agent Coordination

Only one builder should edit a branch at a time.

For shared files, coordinate before editing:

- `index.html`
- `js/core.js`
- `js/workorders.js`
- `js/photos.js`
- `js/export.js`
- `js/history.js`
- `js/buildinghistory.js`
- `js/roofmapper.js`
- `firestore.rules`
- `netlify/functions/lib/permissions.js`

Use `docs/agents/COORDINATION.md` only if it is actively maintained for the current branch. If stale, treat it as historical context and rely on current GitHub issues/PRs instead.
