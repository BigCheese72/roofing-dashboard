# Personal morning‑brief assistant — Microsoft 365 setup (Mark + Steve)

This sets up a **separate, personal** Microsoft 365 connection for Mark's
morning brief — his **mail (read + draft)** and **calendar (read + create)** —
on its **own Azure app registration**, completely isolated from the RoofOps
business M365 integration.

**Why separate?** The business app (RoofOps contacts‑sync) holds a broad grant
(Mail, Contacts, Files, mailbox rules). The morning brief has no business riding
on that. This personal app is scoped to **Mail + Calendar only**, and the code
(`netlify/functions/assistant-mail.js`) reaches Graph **only** through the
personal credential — it can **never** fall back to the business token. If these
steps aren't done, the assistant simply reports *"personal assistant credential
not configured"* and does nothing.

Claude built the code side. The steps below are the **manual** parts only Mark
and Steve can do (creating the app registration, consenting, and setting env
vars). **Claude never sees or handles any secret value** — you paste secrets
straight into Netlify.

---

## Part A — Create the Azure AD app registration (Mark)

1. Go to **https://portal.azure.com** and sign in as **marks@watkinsroofing.net**.
2. Search for and open **Microsoft Entra ID** (formerly "Azure Active Directory").
3. In the left menu, click **App registrations**, then **+ New registration**.
4. Fill in:
   - **Name:** `RoofOps Personal Assistant (Mark)` — a clear name so it's never
     confused with the existing business app.
   - **Supported account types:** *Accounts in this organizational directory
     only (Watkins Roofing only — Single tenant).*
   - **Redirect URI:** choose platform **Web**, and enter:
     `https://login.microsoftonline.com/common/oauth2/nativeclient`
     (This is only used once, to get the initial refresh token in Part C. It is
     a Microsoft‑hosted page that just displays the code.)
5. Click **Register**.
6. On the app's **Overview** page, copy these two values (you'll paste them into
   Netlify in Part D):
   - **Application (client) ID**  → this becomes `PA_MS_CLIENT_ID`
   - **Directory (tenant) ID**    → this becomes `PA_MS_TENANT_ID`

---

## Part B — Add the delegated scopes and grant admin consent (Steve is the tenant admin)

1. Still in the new app registration, click **API permissions** in the left menu.
2. Click **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**.
3. Search for and check **each** of these (delegated), then **Add permissions**:
   - **Mail.ReadWrite** — read message bodies **and** save drafts. (Read‑only
     `Mail.Read` would work for reading, but the brief also drafts replies, which
     needs write. Note: **no** send permission is requested — the code cannot send.)
   - **Calendars.ReadWrite** — read events **and** add new events to Mark's own
     calendar.
   - **offline_access** — lets the assistant keep working day‑to‑day without Mark
     re‑signing in (this is what issues the refresh token).
   - **User.Read** — lets the assistant confirm *which* account is connected
     (used by the `diag` check).
   - Do **not** add Contacts, Files/Sites, or MailboxSettings — the personal
     brief must not have them.
4. Click **Grant admin consent for Watkins Roofing** (this button needs
   **Steve**, the tenant admin). Confirm. All four permissions should then show
   **"Granted for Watkins Roofing"** with a green check.

---

## Part C — Create a client secret and get the initial refresh token (Mark)

**C1. Client secret**

1. In the app registration, click **Certificates & secrets** → **Client secrets**
   → **+ New client secret**.
2. Description: `netlify`. Expiry: **24 months** (calendar reminder to rotate it
   before it expires).
3. Click **Add**, then **immediately copy the secret _Value_** (not the Secret
   ID). It's shown only once. This becomes `PA_MS_CLIENT_SECRET`.

**C2. One‑time refresh token** (the `PA_MS_REFRESH_TOKEN` seed)

You authorize the app once, in a browser, to mint a long‑lived refresh token.

1. In a browser signed in as **marks@watkinsroofing.net**, paste this URL into
   the address bar — first replace `TENANT_ID` and `CLIENT_ID` with your Part A
   values:

   ```
   https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Foauth2%2Fnativeclient&response_mode=query&scope=offline_access%20Mail.ReadWrite%20Calendars.ReadWrite%20User.Read
   ```

2. Approve the sign‑in. The browser lands on a nearly blank Microsoft page whose
   **URL** contains `?code=`**`0.A...`** (a long value). Copy everything between
   `code=` and the next `&` (or the end).

3. Exchange that code for tokens. In a terminal, run this (replace `TENANT_ID`,
   `CLIENT_ID`, `CLIENT_SECRET`, and `PASTE_CODE_HERE`). The code expires in a few
   minutes, so do this promptly:

   ```bash
   curl -s -X POST "https://login.microsoftonline.com/TENANT_ID/oauth2/v2.0/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     --data-urlencode "client_id=CLIENT_ID" \
     --data-urlencode "client_secret=CLIENT_SECRET" \
     --data-urlencode "grant_type=authorization_code" \
     --data-urlencode "redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient" \
     --data-urlencode "scope=offline_access Mail.ReadWrite Calendars.ReadWrite User.Read" \
     --data-urlencode "code=PASTE_CODE_HERE"
   ```

4. The JSON response has a **`refresh_token`** field (a long string). That value
   is `PA_MS_REFRESH_TOKEN`. (You can ignore `access_token` — the app derives
   fresh access tokens from the refresh token automatically.)

> Keep the refresh token, client secret, tenant/client IDs somewhere safe only
> long enough to paste them into Netlify. Don't commit them anywhere.

---

## Part D — Set the Netlify environment variables (Mark)

In **Netlify → the `roofing-dashboard` site → Site configuration → Environment
variables**, add these **five** variables. Set the values you collected above.

| Variable name          | Value (from step)                          | Required? |
|------------------------|--------------------------------------------|-----------|
| `PA_MS_TENANT_ID`      | Directory (tenant) ID — Part A step 6      | **Yes**   |
| `PA_MS_CLIENT_ID`      | Application (client) ID — Part A step 6    | **Yes**   |
| `PA_MS_CLIENT_SECRET`  | Client secret **Value** — Part C1          | **Yes**   |
| `PA_MS_REFRESH_TOKEN`  | `refresh_token` from the JSON — Part C2     | **Yes**   |
| `PA_MS_MAILBOX`        | `marks@watkinsroofing.net`                 | Optional  |

Notes:
- `PA_MS_MAILBOX` is optional; if set, the `diag` check confirms the connected
  account matches it. It doesn't affect anything else.
- These are **new** names (`PA_MS_*`). Do **not** reuse or touch the existing
  `GRAPH_*` business variables — keeping them separate is the whole point.
- After adding them, **trigger a redeploy** (Netlify → Deploys → Trigger deploy)
  so the functions pick up the new values.

---

## Part E — Confirm it works

Once deployed, the assistant can call the `assistant-mail` function. A quick
proof (from the signed‑in dev/app page context, as Mark):

- `{"action":"status"}` → `{ "configured": true, ... }` once the env vars are set.
- `{"action":"diag"}` → returns the connected account's name/email; if
  `PA_MS_MAILBOX` is set, `expectedMatch` should be `true`.
- `{"action":"calendar_list","range":"today"}` → today's events.
- `{"action":"mail_list","top":10}` → the 10 most recent messages (subject, from,
  date, preview) — reading does **not** mark anything read.

If the env vars aren't set, every action returns HTTP **503** with
*"personal assistant credential not configured"* — never the business mailbox.

---

## What the assistant can and cannot do (guardrails)

**Mail — read + draft only.**
- ✅ Read message previews and full bodies (for quoting into the brief).
- ✅ Create **drafts** (fresh or replies) in the Drafts folder — Mark reviews and
  sends each one himself.
- 🚫 Never sends, deletes, forwards, or marks mail read. There is no code path
  that can.

**Calendar — read + create only.**
- ✅ List today's / this week's events.
- ✅ Add a new event to Mark's own calendar (additive).
- 🚫 No update or delete action exists — the assistant cannot move, change, or
  cancel any existing event (his or anyone else's). By default a created event
  invites **no** attendees; attendees are added only when Mark explicitly asks.

**Isolation.** This function reads only the `PA_MS_*` variables and uses a
separate stored‑token doc. It has no access to the business Contacts, Files, or
inbox‑rule permissions, and never falls back to the business grant.
