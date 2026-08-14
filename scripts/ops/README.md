# IsaFlow ops

Two independent things live here:

1. **Uptime/alerting probe** (A–Z P3.2) — below.
2. **Production DB backup + restore drill** — see `#backups` at the end.

---


The admin platform was once down for weeks unnoticed (July-4 audit H4).
`uptime-probe.sh` closes that hole: every 5 minutes it checks app health,
admin health, and one authenticated API call, and alerts a Telegram chat on
any state change (one `[ALERT]` per OK→FAIL, `[RESOLVED]` on recovery,
re-alert every `REALERT_HOURS` — default 6 — while red).

Bugsink new-issue alerting already runs in real time via the
`bugsink-telegram-relay` Cloudflare Worker
(`https://bugsink-telegram-relay.velocityfibre.workers.dev`, repo at
`~/Workspace/bugsink-telegram-relay`). The probe's Bugsink poll is optional
belt-and-braces and stays `[SKIP]` until `BUGSINK_TOKEN` is provisioned.
(The poll's endpoint shape should be validated against the `bugsink` skill
notes when the token lands — Bugsink serves `/api/canonical/0/`, not `/api/0/`.)

## Install — HEIN-GATED (do not install autonomously)

1. `cp scripts/ops/isaflow-ops-env.example /home/hein/isaflow-ops.env`
   and fill in: the alert bot token + chat id, the Demo admin login.
   `chmod 600 /home/hein/isaflow-ops.env`.
2. ```bash
   sudo cp scripts/ops/isaflow-uptime-probe.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now isaflow-uptime-probe.timer
   ```
3. Verify: `systemctl list-timers isaflow-uptime-probe.timer` and
   `journalctl -u isaflow-uptime-probe.service -n 20`.

## Drill (run after install, and after changing the bot/chat)

```bash
# Force a failure without touching prod: point the app check at a dead port.
PROBE_APP_URL=http://localhost:9 PROBE_STATE_DIR=$(mktemp -d) \
  bash scripts/ops/uptime-probe.sh
```

Expected: `[FAIL] app /api/health ...` on stdout AND a 🔴 [ALERT] message in
the Telegram chat. Run it again with the same `PROBE_STATE_DIR` to confirm
dedup (no second message); drop the override to see ✅ [RESOLVED].

## Notes

- The probe exits 0 even on check failures — Telegram is the signal. This
  keeps systemd from entering failed state for outages already alerted.
- Session reuse: the authed check keeps a cookie jar in
  `~/.local/state/isaflow-probe/` and logs in only when the session expires,
  to stay clear of the login rate limit (10/15min/email) shared with the
  golden suite.
- Admin authed coverage: the admin platform's API auth is currently broken
  (stale `platform_admin` password — HUMAN-GATED fix). The admin /api/health
  check covers liveness today; extend the probe with an admin login check
  once the credential is rotated.

---

<a id="backups"></a>

# Production DB backup + restore drill

Daily `pg_dump` of the production database plus a weekly drill that proves the
dump actually restores.

## Why this exists

Before 2026-08-14 the IsaFlow production database had **no backup of any kind**.
Seven `isaflow-*` systemd timers were running (uptime probe, dunning, fraud
scan, matview refresh, …) and none of them was a backup; the only dumps on the
host belonged to QFieldCloud and Signum. There is one server, no staging, and
no PITR, while Brightsphere and Velocity Fibre carry live ledgers.

## Layout

| Thing | Path |
|---|---|
| Source of truth | `scripts/ops/` in this repo |
| Installed to | `/opt/isaflow-ops/` |
| Dumps | `/srv/storage/backups/isaflow/` (0700, separate 3.7T disk) |
| Units | `isaflow-backup.{service,timer}`, `isaflow-restore-drill.{service,timer}` |

**Not** `/home/velo/isaflow/scripts/` — `deploy.sh` rsyncs that directory with
`--delete`, so a backup job living there would be silently removed by the next
deploy.

## Schedule

- **Backup** — daily 01:30 SAST. Chosen to clear the other jobs on this host
  (02:03 ar-matview-refresh, 02:30 qfc-pg, 02:33 fraud-scan, 03:00 signum).
- **Restore drill** — Sunday 04:30 SAST, after signum's own drill at 04:00.

## Retention

30 days of dailies; the 1st-of-month dump is kept ~13 months.
At ~9 MB per dump this is negligible against 2.8T free.

## What the drill actually asserts

1. The latest dump is **less than 48h old** — otherwise a green drill would be
   reporting on a backup job that had stopped running.
2. It restores into a scratch database (`--no-owner --no-acl`; the app role is
   not a superuser here).
3. Every table's row count matches the **manifest written at dump time** — not
   live, which moves between the dump and the drill and could only ever be
   compared approximately.
4. The **restored ledger balances**: zero companies where posted debits ≠
   credits. A restore that loses journal *lines* keeps entry counts intact and
   silently unbalances every company, so row counts alone would not catch it.

Verified to fail on a truncated dump and on a single-row discrepancy — not just
to pass on a good one.

## Commands

```bash
# install / refresh after editing anything here
bash scripts/ops/install-backup-ops.sh

# run now
sudo systemctl start isaflow-backup.service
sudo systemctl start isaflow-restore-drill.service

# logs / schedule
journalctl -u isaflow-backup.service -n 50 --no-pager
systemctl list-timers 'isaflow-*' --no-pager
```

## Restoring for real

```bash
# inspect without restoring
pg_restore --list /srv/storage/backups/isaflow/latest.dump | less

# into a scratch database first — never straight over production
createdb isaflow_recovery
pg_restore --no-owner --no-acl -d "$URL_BASE/isaflow_recovery" \
  /srv/storage/backups/isaflow/latest.dump
```

## Alerting

Failures email via `alert-email.py` (`ALERT_EMAIL`, else `SMTP_USER`).

Two traps were found here and are fixed, but worth knowing if you touch it:

- `SMTP_PORT=465` is **implicit TLS**. The helper now derives that from the
  port; previously it spoke plain SMTP to 465, the server never sent a
  greeting, and the failure surfaced as a bare `TimeoutError` that looks
  nothing like a TLS problem.
- The certificate is `*.jnb1.host-h.net` while the host is
  `mail.isaflow.co.za`, so SNI must be overridden via `SMTP_TLS_SERVERNAME`
  (the app's nodemailer transport does the same with `tlsServername`).

## Not covered

- **No PITR.** These are daily snapshots; worst-case loss is ~24h of writes.
  WAL archiving is the next step if that window is too wide.
- **Off-host copy.** `/srv/storage` is a different disk, not a different
  machine. A host loss still loses the backups.
