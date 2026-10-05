# Ticket vs. Work Order split — email subject change + tickets mail rule

**Date:** 2026-08-03
**Actor:** Claude (Cowork), on behalf of Mark (project handed over)
**Authorization:** Mark confirmed Option A — separate leak/service TICKETS from repair WORK ORDERS.

## Code change (js/core.js — EMAIL_TYPE_COPY)
- Added `"Leak / Service": { subject: "Service Ticket", noun: "Service ticket" }`.
- Result: the Leak/Service report type now emails as **"Service Ticket — …"** (customer-safe;
  never says "Leak"). The plain work order ("Repair", shown as "Work Order") keeps the default
  **"Service Work Order — …"**. Change Order / Inspection / Warranty unchanged.
- Cache-buster bumped 20260803a -> 20260804a (index.html; sw.js left at 20260801a per its
  network-first design, matching the prior deploy).
- Full test suite: 1455 pass / 0 fail. Verified live on dev (build 20260804a):
  Leak/Service->"Service Ticket —", Repair->"Service Work Order —", others unchanged.
- Branch: feat/leak-service-ticket-subject -> merged (ff) to dev @ 99d9f1e, pushed origin/dev.

## Mailbox change (additive, move-only)
- Folder created: **RoofOps: Tickets** (new).
- Rule created via delegated contacts-sync `rules_create` (move-only, stopProcessingRules,
  no forward/redirect/delete/markAsRead):
  | Rule | Seq | subjectContains | Moves to |
  |---|---|---|---|
  | RoofOps — Tickets | 20 | `Service Ticket —` (em-dash U+2014) | RoofOps: Tickets |
- Verified via rules_list. Rule count 19 -> 20. No overlap with "Service Work Order" rule
  (-> RoofOps: Work Orders), so tickets and work orders now separate cleanly.
- Access path: dev endpoint contacts-sync via Mark's signed-in Chrome session
  (email=marks@watkinsroofing.net, aud=watkins-service-orders-dev). One real M365 mailbox.

## Routing after this change
- Leak/Service ticket -> "Service Ticket —" -> RoofOps: Tickets (NEW)
- Repair work order   -> "Service Work Order —" -> RoofOps: Work Orders
- Change Order        -> "Change Order —" -> RoofOps: Change Orders
- Inspection          -> "Inspection —" -> RoofOps: Inspections
- Warranty            -> "Warranty —" -> Warranties

## Reversal
- Mail: additive-only function cannot delete rules/folders. To undo, in Outlook web
  (outlook.office.com as marks@watkinsroofing.net): Settings -> Mail -> Rules -> delete
  "RoofOps — Tickets"; optionally delete the empty "RoofOps: Tickets" folder.
- Code: `git revert 99d9f1e` on dev (and the prod promotion commit, if promoted).
- No mail was sent, moved, deleted, or marked read.

## Not done (left to Mark)
- Duplicate-rule deletion ("RoofOps — Work Orders -> RoofOps (v2)") — Mark will do himself.
- Dead "Leak Work Order"-subject rules (Leak Orders, Leaks v2) still orphaned.
