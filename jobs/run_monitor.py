"""
Standalone monitor worker.

Runs the daily monitoring scan for every user with active topics, persisting
each topic's results to the monitor_results table and emailing a digest when
the user has one configured.

Why this exists as its own entrypoint:
  The web process serves requests on a 512MB free-tier dyno. Running the scan
  in-process competes with request handling for that budget and was the source
  of OOM kills. Run as a separate, scheduled container instead — it boots, does
  the scan, and exits, so its memory is reclaimed and never touches the web
  process. On Render this is a Cron Job; anywhere with cron it is just:

      python -m jobs.run_monitor

  It is idempotent: results upsert per (user, topic), so a re-run overwrites
  rather than duplicates. A per-user failure is logged and skipped so one bad
  account can't sink the whole run.

Env:
  MONITOR_MAX_PER_SOURCE   papers pulled per source per keyword (default 5)
  MONITOR_RELEVANCE_MIN    minimum library-similarity to keep a paper (0.3)
"""

import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Allow `python jobs/run_monitor.py` as well as `python -m jobs.run_monitor`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db import Database
from agents.monitoring_agent import MonitoringAgent, MonitorTopic


def _is_due(topic) -> bool:
    """Whether a topic should scan on this run, given its cadence.
    paused -> never; weekly -> only if not scanned in the last 7 days; daily -> always."""
    cadence = getattr(topic, "cadence", "daily")
    if cadence == "paused":
        return False
    if cadence == "weekly":
        last = getattr(topic, "last_scanned_at", None)
        if not last:
            return True
        try:
            return datetime.fromisoformat(last) < datetime.now(timezone.utc) - timedelta(days=7)
        except ValueError:
            return True
    return True


def run() -> int:
    """Scan all active users. Returns the number of users scanned."""
    db = Database()
    monitor = MonitoringAgent()

    max_per_source = int(os.getenv("MONITOR_MAX_PER_SOURCE", "5"))
    relevance_min = float(os.getenv("MONITOR_RELEVANCE_MIN", "0.3"))

    users = db.list_users_with_active_topics()
    print(f"[monitor-worker] {len(users)} user(s) with active topics")

    scanned = 0
    for user in users:
        active = [t for t in db.list_monitor_topics(user.id) if t.is_active and _is_due(t)]
        if not active:
            continue
        topics = [
            MonitorTopic(name=t.name, keywords=t.keywords, sources=t.sources)
            for t in active
        ]
        print(f"[monitor-worker] scanning {len(topics)} topic(s) for {user.email}")
        try:
            _results, email_sent, email_error, failed = monitor.run_scan_persisted(
                topics=topics,
                user_id=user.id,
                recipient=user.digest_email or None,
                max_per_source=max_per_source,
                relevance_threshold=relevance_min,
            )
            for t in active:
                db.update_topic_scanned_at(t.id)
            if email_error:
                print(f"[monitor-worker]   email: {email_error}")
            elif email_sent:
                print(f"[monitor-worker]   digest emailed to {user.digest_email}")
            if failed:
                print(f"[monitor-worker]   sources unavailable: {', '.join(failed)}")
            scanned += 1
        except Exception as e:  # noqa: BLE001 — one user's failure shouldn't abort the run
            print(f"[monitor-worker]   FAILED for {user.email}: {e}")

    print(f"[monitor-worker] done — scanned {scanned}/{len(users)} user(s)")
    return scanned


if __name__ == "__main__":
    started = time.time()
    try:
        run()
    finally:
        print(f"[monitor-worker] elapsed {time.time() - started:.1f}s")
