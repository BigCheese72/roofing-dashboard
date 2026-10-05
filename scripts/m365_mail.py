#!/usr/bin/env python3
"""m365_mail.py — one-call access to Mark's Watkins M365 (Outlook) mailbox.

WHY THIS EXISTS
---------------
Reaching Mark's Watkins mailbox is a solved problem, but the path is easy to
rediscover from scratch every session. This script bakes the DOCUMENTED path in
so a future session can read mail, draft replies, and organize folders with ONE
command instead of relearning the wiring.

THE DOCUMENTED PATH (do not reinvent)
-------------------------------------
All mailbox access goes through ONE deployed backend action surface: the RoofOps
`contacts-sync` Netlify function, which holds the DELEGATED Microsoft Graph token
Mark consented to on 2026-07-13 ("as Mark", against /me only — it cannot touch
any other mailbox in the tenant even in principle). We call the DEV deployment on
purpose: it is the deploy that carries the delegated M365 refresh token.

    DEV endpoint:
    https://dev--leak-work-orders.netlify.app/.netlify/functions/contacts-sync

There is ALREADY one working M365 authorization. Never tell Mark to "re-auth" or
re-consent M365 — if a call fails it is almost always the Firebase sign-in token
(below), not the M365 grant.

AUTH — two ways in (pick one; never print either)
-------------------------------------------------
1. Firebase ID token (the human path, full action set). Mark is the app owner, so
   his token passes `warranty.manage_reports`. Supply it with --id-token /
   --id-token-file / env ROOFOPS_ID_TOKEN. It becomes `Authorization: Bearer …`.
   Get it from the SIGNED-IN dev app in Chrome (see "Signed-in-browser path").

2. ASIL bridge key (the non-human path, read + draft only). Supply --bridge-key /
   env ROOFOPS_ASIL_KEY. It becomes the `x-roofops-asil-key` header. The RoofOps
   side only lets this key reach: folders, list_messages, mail_read,
   attachments_list, attachment_get, calendar_list, create_draft. Anything else
   (move, folder_create, …) is refused server-side — use path 1 for those.

Signed-in-browser path (how a session gets the ID token):
   Open https://dev--leak-work-orders.netlify.app in Chrome, signed in as Mark,
   then run in that tab (the app exposes `fauth = firebase.auth()` globally):
       await fauth.currentUser.getIdToken()
   Pass the result to --id-token (or write it to a file and use --id-token-file).

HARD GUARDRAILS (enforced here, and again server-side)
------------------------------------------------------
Mail is READ + DRAFT + MOVE-TO-FOLDER ONLY. This tool CANNOT and MUST NOT:
  * send, reply-and-send, forward, or auto-send anything (no send path exists —
    the delegated token has Mail.ReadWrite and NO Mail.Send);
  * delete any message or folder;
  * mark anything read (reads are GET-only and never PATCH isRead).
Draft actions ONLY create a draft in Mark's Drafts for him to review and send
himself. Organize actions are ADDITIVE only: move-to-folder and folder-create.
This script refuses to build any action outside that allowlist.

No secret (ID token, bridge key, refresh token) is ever printed or logged.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

# The DEV deployment, deliberately — it holds the delegated M365 refresh token.
DEFAULT_ENDPOINT = (
    "https://dev--leak-work-orders.netlify.app/.netlify/functions/contacts-sync"
)

# The ONLY actions this tool will ever ask contacts-sync to perform. Everything
# here is read, draft-only, or additive-organize. There is deliberately NO send,
# delete, forward, reply-send, or mark-read action — not in this set, and not on
# the server. Building anything off this list is a hard error.
ALLOWED_ACTIONS = {
    "folders",          # read: list mail folders
    "list_messages",    # read: list messages in a folder
    "mail_read",        # read: full message bodies (never marks read)
    "attachments_list", # read: list a message's attachments
    "attachment_get",   # read: fetch one attachment's bytes
    "calendar_list",    # read: list calendar events
    "create_draft",     # write: DRAFT ONLY (never sends)
    "move",             # organize: move-to-folder ONLY (additive, reversible)
    "folder_create",    # organize: create a folder (additive, moves no mail)
}

# Actions the ASIL bridge key is allowed to reach server-side. Used only to warn
# early (the server is the real gate) so a bridge-key user gets a clear message
# instead of a raw 401 on move/folder_create.
BRIDGE_KEY_ACTIONS = {
    "folders", "list_messages", "mail_read",
    "attachments_list", "attachment_get", "calendar_list", "create_draft",
}


class Guardrail(Exception):
    """A request this tool refuses to make (never send/delete/mark-read/etc.)."""


class NotSignedIn(Exception):
    """No usable credential — carries the exact remediation for the caller."""


REMEDIATION = (
    "Not signed in — no M365 credential available.\n"
    "\n"
    "There is already ONE working M365 authorization; you do NOT need to re-auth\n"
    "or re-consent Microsoft. What is missing is a fresh Firebase sign-in token.\n"
    "\n"
    "Fix it one of these ways:\n"
    "  1) Open https://dev--leak-work-orders.netlify.app in Chrome, signed in as\n"
    "     Mark. In that tab run:  await fauth.currentUser.getIdToken()\n"
    "     Pass the value with  --id-token <token>  (or --id-token-file <path>,\n"
    "     or set ROOFOPS_ID_TOKEN).\n"
    "  2) For read + draft only, set ROOFOPS_ASIL_KEY (or --bridge-key <key>).\n"
)


# ---------------------------------------------------------------------------
# Credential resolution — returns the HTTP headers, never echoes the secret.
# ---------------------------------------------------------------------------
def resolve_headers(args, action):
    """Choose the auth path and build request headers. Firebase token wins."""
    id_token = args.id_token
    if not id_token and args.id_token_file:
        with open(args.id_token_file, "r", encoding="utf-8") as fh:
            id_token = fh.read().strip()
    if not id_token:
        id_token = (os.environ.get("ROOFOPS_ID_TOKEN") or "").strip() or None

    bridge_key = args.bridge_key or (os.environ.get("ROOFOPS_ASIL_KEY") or "").strip() or None

    headers = {"Content-Type": "application/json", "Accept": "application/json"}

    if id_token:
        headers["Authorization"] = "Bearer " + id_token
        return headers, "firebase"
    if bridge_key:
        if action not in BRIDGE_KEY_ACTIONS:
            raise NotSignedIn(
                "The ASIL bridge key cannot perform '" + action + "'. It is limited "
                "to read + draft actions server-side. Use a Firebase ID token "
                "(--id-token) for move/folder_create.\n\n" + REMEDIATION
            )
        headers["x-roofops-asil-key"] = bridge_key
        return headers, "bridge"
    raise NotSignedIn(REMEDIATION)


# ---------------------------------------------------------------------------
# Transport — POST {action, ...body} to contacts-sync. Guardrail-checked.
# ---------------------------------------------------------------------------
def call(action, body, args):
    if action not in ALLOWED_ACTIONS:
        # Belt-and-braces: this tool has no code path that reaches a send/delete/
        # mark-read action, and this makes that guarantee explicit and testable.
        raise Guardrail(
            "Refusing action '" + action + "': not in the read/draft/move "
            "allowlist. This tool never sends, deletes, forwards, or marks mail read."
        )

    headers, auth_mode = resolve_headers(args, action)
    payload = dict(body or {})
    payload["action"] = action

    if args.dry_run:
        return {
            "dryRun": True,
            "endpoint": args.endpoint,
            "authMode": auth_mode,          # "firebase" | "bridge" — never the secret
            "action": action,
            "requestBody": payload,
        }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(args.endpoint, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        if e.code in (401, 403):
            # Auth failure is almost always a stale Firebase token — NOT the M365
            # grant. Steer the caller to re-fetch the token, never to re-auth M365.
            raise NotSignedIn(
                "RoofOps returned HTTP " + str(e.code) + " for '" + action + "'. "
                "This is a sign-in/token problem, NOT the M365 grant (that is fine "
                "— do not re-consent Microsoft).\n" + (detail and ("Server said: " + detail + "\n") or "")
                + "\n" + REMEDIATION
            )
        raise SystemExit("RoofOps HTTP " + str(e.code) + " for '" + action + "': " + detail)
    except urllib.error.URLError as e:
        raise SystemExit("Could not reach RoofOps (" + action + "): " + str(e.reason))

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
def cmd_folders(args):
    return call("folders", {}, args)


def cmd_list_messages(args):
    body = {"pages": args.pages}
    if args.folder_id:
        body["folderId"] = args.folder_id
    else:
        body["folderName"] = args.folder
    return call("list_messages", body, args)


def cmd_mail_read(args):
    ids = list(args.ids)
    body = {"messageIds": ids} if len(ids) != 1 else {"messageId": ids[0]}
    return call("mail_read", body, args)


def cmd_create_draft(args):
    body = {}
    # Reply draft vs. fresh draft — mirrors contacts-sync create_draft.
    if args.reply_to:
        body["replyToMessageId"] = args.reply_to
    else:
        if not args.to:
            raise SystemExit("create-draft needs --to (a recipient) unless --reply-to is given.")
        body["toRecipients"] = list(args.to)
        if args.subject is not None:
            body["subject"] = args.subject
    if args.cc:
        body["ccRecipients"] = list(args.cc)

    body_text = args.body
    if body_text is None and args.body_file:
        with open(args.body_file, "r", encoding="utf-8") as fh:
            body_text = fh.read()
    if args.html:
        body["bodyHtml"] = body_text or ""
    else:
        body["bodyText"] = body_text or ""

    result = call("create_draft", body, args)

    # Attachments: the documented delegated create_draft path is BODY-ONLY — the
    # deployed contacts-sync action has no attachment field, and this tool never
    # invents an undocumented server contract. So we create the (body-only) draft
    # and tell the caller plainly that the file was NOT attached, rather than
    # silently dropping it. The draft still lands in Drafts for Mark to review.
    if args.attachment:
        note = (
            "ATTACHMENT NOT ADDED: '" + args.attachment + "'. The delegated "
            "contacts-sync create_draft path is body-only (no attachment action "
            "exists server-side). The draft was created without it — open the "
            "draft in Outlook and attach the file manually before sending."
        )
        if isinstance(result, dict):
            result = dict(result)
            result["attachmentWarning"] = note
        sys.stderr.write("[m365_mail] " + note + "\n")
    return result


def cmd_move(args):
    # Organize = ADDITIVE move-to-folder ONLY. Resolve a folder NAME to an id via
    # folder_create (idempotent: returns the existing folder if present) unless an
    # explicit --to-folder-id was given.
    dest_id = args.to_folder_id
    if not dest_id:
        if not args.to_folder:
            raise SystemExit("move needs --to-folder <name> or --to-folder-id <id>.")
        folder = call("folder_create", {"displayName": args.to_folder}, args)
        dest_id = isinstance(folder, dict) and folder.get("id") or None
        if not dest_id:
            raise SystemExit("Could not resolve destination folder '" + args.to_folder + "': " + json.dumps(folder))
    moves = [{"id": mid, "destinationId": dest_id} for mid in args.ids]
    return call("move", {"moves": moves}, args)


def cmd_folder_create(args):
    return call("folder_create", {"displayName": args.name}, args)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        prog="m365_mail.py",
        description="Read / draft / organize Mark's Watkins Outlook mailbox via the "
                    "delegated contacts-sync path. READ + DRAFT + MOVE ONLY — never "
                    "sends, deletes, or marks mail read.",
    )
    p.add_argument("--endpoint", default=os.environ.get("ROOFOPS_CONTACTS_SYNC_URL", DEFAULT_ENDPOINT),
                   help="contacts-sync URL (default: the DEV deploy that holds the delegated M365 token).")
    p.add_argument("--id-token", help="Firebase ID token (human path). Or ROOFOPS_ID_TOKEN.")
    p.add_argument("--id-token-file", help="File containing the Firebase ID token.")
    p.add_argument("--bridge-key", help="ASIL bridge key (read+draft only). Or ROOFOPS_ASIL_KEY.")
    p.add_argument("--timeout", type=int, default=45, help="HTTP timeout seconds (default 45).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the exact request (action + body, no secrets) without sending.")

    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("folders", help="List Outlook mail folders (read).")
    sp.set_defaults(func=cmd_folders)

    sp = sub.add_parser("list-messages", help="List messages in a folder (read).")
    sp.add_argument("--folder", default="Inbox", help="Folder display name (default Inbox).")
    sp.add_argument("--folder-id", help="Graph folder id (wins over --folder).")
    sp.add_argument("--pages", type=int, default=3, help="Pages of ~200 to pull, 1-5 (default 3).")
    sp.set_defaults(func=cmd_list_messages)

    sp = sub.add_parser("mail-read", help="Read one or more messages in full (read; never marks read).")
    sp.add_argument("ids", nargs="+", help="One or more Graph message ids.")
    sp.set_defaults(func=cmd_mail_read)

    sp = sub.add_parser("create-draft", help="Create a DRAFT (never sends).")
    sp.add_argument("--to", action="append", metavar="EMAIL", help="Recipient (repeatable).")
    sp.add_argument("--cc", action="append", metavar="EMAIL", help="CC recipient (repeatable).")
    sp.add_argument("--subject", help="Subject (fresh draft).")
    sp.add_argument("--body", help="Body text (or use --body-file).")
    sp.add_argument("--body-file", help="Read body from a file.")
    sp.add_argument("--html", action="store_true", help="Treat body as HTML (verbatim, no auto sign-off).")
    sp.add_argument("--reply-to", metavar="MESSAGE_ID", help="Draft a reply to this message id instead of a fresh draft.")
    sp.add_argument("--attachment", metavar="PATH", help="File to attach (see note: server path is body-only).")
    sp.set_defaults(func=cmd_create_draft)

    sp = sub.add_parser("move", help="Move messages to a folder (organize; additive, reversible).")
    sp.add_argument("ids", nargs="+", help="Message ids to move.")
    sp.add_argument("--to-folder", help="Destination folder name (created if absent).")
    sp.add_argument("--to-folder-id", help="Destination folder id (wins over --to-folder).")
    sp.set_defaults(func=cmd_move)

    sp = sub.add_parser("folder-create", help="Create a mail folder (organize; additive).")
    sp.add_argument("name", help="Folder display name.")
    sp.set_defaults(func=cmd_folder_create)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        result = args.func(args)
    except NotSignedIn as e:
        sys.stderr.write(str(e) + "\n")
        return 3
    except Guardrail as e:
        sys.stderr.write("[GUARDRAIL] " + str(e) + "\n")
        return 4
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
