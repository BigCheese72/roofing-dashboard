# Mailbox change — additive move-only rules (Change Order, Warranty)

**Date:** 2026-08-03
**Actor:** Claude (Cowork), on behalf of Mark
**Mailbox:** marks@watkinsroofing.net (M365 delegated Graph)
**Access path:** dev endpoint `https://dev--leak-work-orders.netlify.app/.netlify/functions/contacts-sync`
via Mark's signed-in Chrome session (Firebase token: email=marks@watkinsroofing.net,
aud=watkins-service-orders-dev). Actions used: `folder_create`, `rules_create`, `rules_list`.
Note: this operates on the ONE real M365 mailbox regardless of dev/prod app deploy.

## Authorization
Mark authorized exactly two additive rules (this session):
1. Route "Change Order" report emails to their own folder.
2. Route "Warranty" report emails to the existing Warranties folder.
Explicitly OUT OF SCOPE (not done): ticket-vs-work-order split (pending Mark's decision),
any rule deletion, any folder rename.

## What changed (all additive, move-only, reversible)

### Folder created
- **RoofOps: Change Orders** (top-level) — was newly created (did not exist).
  - Warranties folder already existed; NOT created.

### Inbox rules created (move-only + stopProcessingRules; no forward/redirect/delete/markAsRead)
| Rule name | Sequence | Condition (subjectContains) | Moves to |
|---|---|---|---|
| RoofOps — Change Orders | 18 | `Change Order —` (em-dash U+2014) | RoofOps: Change Orders |
| RoofOps — Warranties | 19 | `Warranty —` (em-dash U+2014) | Warranties |

Both verified via `rules_list` immediately after creation: enabled, correct destination,
stopProcessingRules=true, zero prohibited actions. Rule count 17 -> 19.

## Why these conditions are high-confidence
Email subjects are built as `emailTypeSubject(woType) + " — " + jobName…` (js/core.js
EMAIL_TYPE_COPY, js/history.js). "Change Order" and "Warranty" each map to their own
subject prefix, emitted only by RoofOps report sends. The " —" em-dash anchor matches the
report subject prefix and avoids catching incidental mentions. Sequenced after existing
RoofOps rules (12–17); no subject overlap with any existing rule, so no shadowing. The
wo{job}@ / workorders@watkinsroofing.net sender is not caught by the sender-based category
rules (seq 1–11), confirmed empirically (2026-08-03 Service Work Order mail reached
RoofOps: Work Orders via seq 13).

## Reversal instructions
The delegated function is additive-only and CANNOT delete/edit rules or folders. To undo,
Mark (or an admin) does it in Outlook on the web (outlook.office.com, signed in as
marks@watkinsroofing.net):
1. Settings ⚙ → Mail → Rules → delete "RoofOps — Change Orders" and/or "RoofOps — Warranties".
2. (Optional) Delete the now-empty "RoofOps: Change Orders" folder from the folder list.
Warranties folder pre-existed and should be kept.
No mail was moved, sent, deleted, or marked read by this change; existing mail is unaffected
until a new matching message arrives.
