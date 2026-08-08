# AGENTS.md

For product/architecture context, read `README.md`, `APP_OVERVIEW.md`, `DEV_NOTES.md`,
`ROADMAP.md`, and `DATA_MODEL.md` first (the README explains why these docs are the
handoff mechanism between AI sessions).

## Cursor Cloud specific instructions

This repo is a single product — **RoofOps Field**, a static vanilla-JS SPA
(`index.html` + `js/*.js` + `css/`) served alongside Netlify Functions
(`netlify/functions/`). There is **no frontend build step** and no framework/bundler.

Service / command reference (standard commands live in `README.md` and `package.json`):

- **Tests:** `npm test` (Node's built-in runner over `tests/**/*.test.js`, ~1455 tests).
  Pure unit/characterization tests with mocks — they need no running services,
  no network, and no secrets.
- **Lint:** none configured (no ESLint/Prettier). `npm test` is the only automated check.
- **Build:** none. Netlify serves the repo root as-is; `npm install` only installs the
  Functions' runtime deps (`firebase-admin`, `jimp`, `mssql`).
- **Run the app:** `netlify dev --offline` (serves the static app + all Functions at
  `http://localhost:8888`). `netlify dev` is the documented local environment; opening
  `index.html` directly is not sufficient for the Function routes.

Non-obvious gotchas:

- **`netlify-cli` is not a repo dependency.** The update script only runs `npm install`,
  which does NOT install `netlify-cli`. Install it once per VM to run the app, e.g.
  `npm config set prefix "$HOME/.npm-global"` then
  `PATH="$HOME/.npm-global/bin:$PATH" npm install -g netlify-cli`
  (a user prefix is required — the default global prefix `/` is not writable). `npx netlify-cli dev --offline` also works.
- **The app chooses its Firebase project at runtime from the hostname.** On `localhost`
  it talks to the real **`watkins-service-orders-dev`** cloud sandbox (Firestore + Email/
  Password Auth), NOT production and NOT a local emulator. There is no Firebase emulator
  in this repo; the browser talks directly to Google. Both web configs are committed in
  `js/core.js` (intentionally public per Firebase's design).
- **The whole UI is gated behind a Firebase Auth login.** The gate hides as soon as *any*
  Firebase user is signed in (claims/roles only affect privileged actions, not the gate).
  To get past it locally without real credentials, create a throwaway account in the dev
  sandbox via its public web API key (Email/Password sign-up is enabled), then sign in:
  `curl -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<DEV_apiKey_from_js/core.js>" -H "Content-Type: application/json" -d '{"email":"<you>@example.com","password":"<pw>","returnSecureToken":true}'`.
  Use clearly-labeled test data (e.g. "DELETE ME ...") since this writes to a shared dev sandbox.
- **Netlify Functions need secrets that are not present locally** (`COMPANYCAM_TOKEN`,
  `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`,
  `FOUNDATION_SQL_PASSWORD`, Microsoft Graph vars, etc. — see README "Environment
  Variables"). Without them, those Functions return 401/500 by design; this does not
  block core UI or Firestore work-order save/load. The AI "Draft Summary" button failing
  locally is expected (no AI keys).
- **Under `netlify dev --offline`, `manifest.json` and the service worker (`sw.js`) 404.**
  Cosmetic PWA-only quirk of offline static serving; core functionality is unaffected.
