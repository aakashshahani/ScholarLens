"""
One-shot helper to attach a pre-Clerk account to Clerk without losing its data.

Your existing papers are keyed to an internal user row, not to the auth
provider, so this only touches that one row — every paper/claim stays attached.

Pick ONE of the two ways:

  A) Fix the email, then sign in with Clerk using that same email. The server's
     automatic link-by-email step attaches Clerk to your existing row on first
     sign-in. Use this if your current account email isn't real (e.g. the
     aakash@example.com case):
        python -m jobs.link_account --from aakash@example.com --to you@real.com

  B) Link directly by Clerk id (works even if the emails differ). Create your
     Clerk account first, copy your user id (user_xxx) from the Clerk dashboard,
     then:
        python -m jobs.link_account --email aakash@example.com --clerk-id user_xxx
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Database


def main() -> None:
    p = argparse.ArgumentParser(description="Link a pre-Clerk account to Clerk.")
    p.add_argument("--from", dest="from_email", help="existing account email to rename")
    p.add_argument("--to", dest="to_email", help="real email you'll use with Clerk")
    p.add_argument("--email", help="existing account email (for direct id link)")
    p.add_argument("--clerk-id", help="Clerk user id (user_xxx) to link")
    args = p.parse_args()

    db = Database()

    if args.from_email and args.to_email:
        u = db.get_user_by_email(args.from_email)
        if not u:
            print(f"No user with email {args.from_email}")
            sys.exit(1)
        conn = db._get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE users SET email = %s WHERE id = %s", (args.to_email, u.id))
        conn.commit()
        cur.close()
        db._put_conn(conn)
        print(f"Updated email {args.from_email} -> {args.to_email} (user {u.id}).")
        print(f"Now sign in with Clerk using {args.to_email} — your papers will link automatically.")
        return

    if args.email and args.clerk_id:
        u = db.get_user_by_email(args.email)
        if not u:
            print(f"No user with email {args.email}")
            sys.exit(1)
        db.link_clerk_id(u.id, args.clerk_id)
        print(f"Linked Clerk id {args.clerk_id} to user {u.id} ({args.email}). Papers preserved.")
        return

    p.error("Provide either --from/--to, or --email/--clerk-id")


if __name__ == "__main__":
    main()
