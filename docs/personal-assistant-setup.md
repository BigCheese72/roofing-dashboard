# Personal morning‑brief assistant — Microsoft 365 setup

The morning‑brief assistant reads Mark's mail (bodies), drafts replies, and — once
one scope is added — reads and adds calendar events. It runs on the **existing
RoofOps M365 app registration and delegated grant** (the same one `contacts-sync`
already uses). **No new app registration, no new credential, no `PA_MS_*` env
vars.**

## Status

| Capability | Works now? | Needs |
|---|---|---|
| **Mail body reading** (`mail_read`) | ✅ **Yes, today** | Nothing — `Mail.ReadWrite` is already granted |
| **Draft replies / compose** (`create_draft`) | ✅ Yes | Nothing — already shipped |
| **Calendar read + create** (`calendar_list`, `calendar_create`) | ⏳ Not yet | The one step below (Steve + Mark) |

Until the calendar step is done, `calendar_list` and `calendar_create` return a
clear no‑op — `{ "calendarScopeGranted": false, "error": "calendar scope not
granted yet …" }` — instead of failing. Mail actions are unaffected.

---

## The one remaining step — add the Calendars scope

The RoofOps M365 app registration currently has these **delegated** Graph scopes
(admin‑consented by Steve on 7/13): `Mail.ReadWrite`, `MailboxSettings.ReadWrite`,
`Contacts.ReadWrite`, `Files.ReadWrite`, `User.Read`. It has **no** Calendars
scope. Adding it is a three‑part step:

1. **Steve (tenant admin) adds the scope to the app.**
   Azure portal → **Microsoft Entra ID** → **App registrations** → open the
   RoofOps M365 Integration app → **API permissions** → **+ Add a permission** →
   **Microsoft Graph** → **Delegated permissions** → search for and check
   **`Calendars.ReadWrite`** → **Add permissions**.

2. **Steve grants admin consent.**
   On the same **API permissions** page, click **Grant admin consent for Watkins
   Roofing** and confirm. `Calendars.ReadWrite` should then show
   **"Granted for Watkins Roofing"** with a green check.

3. **Mark re‑signs‑in to refresh the token so it carries the new scope.**
   Open **`https://dev--leak-work-orders.netlify.app/.netlify/functions/ms-auth-start`**
   (or the production URL `https://leak-work-orders.netlify.app/.netlify/functions/ms-auth-start`)
   in a browser signed in as **marks@watkinsroofing.net**, and complete the
   Microsoft sign‑in. This mints a fresh delegated refresh token that now
   includes `Calendars.ReadWrite`; the app stores it automatically.

That's it. No env‑var changes and no redeploy are required — the app already
requests `Calendars.ReadWrite` in its sign‑in flow, and the calendar actions
detect the new grant on the next call and switch themselves on.

> **⚠️ Order matters — do steps 1 & 2 BEFORE step 3.** The sign‑in flow
> (`ms-auth-start`) now always requests `Calendars.ReadWrite`. If admin consent
> for it has **not** yet been granted, re‑running `ms-auth-start` can fail the
> whole sign‑in (Microsoft error **AADSTS65001**, "consent required") — which
> would also block re‑authorizing the mail/contacts scopes bundled with it. The
> **currently stored token keeps working untouched**, so there is no rush and no
> reason to run step 3 early. Only click `ms-auth-start` **after** Steve's
> "Grant admin consent" shows the green check on step 2.

> **Why the re‑sign‑in is needed:** the stored refresh token was issued before
> the calendar scope existed, so it doesn't carry it. Only a fresh interactive
> sign‑in (after admin consent) produces a token that does. The refresh path is
> written to return whatever scopes the token actually holds, so calendar
> "lights up" automatically the moment the new token is stored — no code change.

---

## Actions (all on `POST /.netlify/functions/contacts-sync`, Mark's Firebase login required)

| action | reads/writes | notes |
|---|---|---|
| `mail_read` | **read** | `{ messageId }` or `{ messageIds: [...] }` → subject + from + date + **full body text** + preview + recipients. GET only; never marks read. |
| `calendar_list` | **read** | `{ range: "today" \| "week" }` or `{ start, end }` → events (subject, start/end, location, organizer, attendees, preview). Gated until the scope is added. |
| `calendar_create` | **write (additive)** | `{ subject, start, end, timeZone?, location?, body?, isAllDay? }` → adds an event to Mark's own calendar. Gated until the scope is added. |
| `create_draft` | **write (draft only)** | reply or fresh draft in Drafts; never sent (unchanged, pre‑existing). |

## Guardrails (unchanged discipline)

- **Mail: read + draft only.** No send/delete/forward/mark‑read path exists; the
  delegated grant has **no `Mail.Send`**, so a send is impossible in principle,
  and reading never marks a message read.
- **Calendar: read + create only.** No update or delete action exists — the
  assistant cannot move, change, or cancel any existing event (Mark's or anyone
  else's). A created event carries **no attendees**, so it never emails an
  invitation — creating an event sends no mail and notifies no one. (Mark adds
  attendees himself in Outlook if he wants to invite people.)
