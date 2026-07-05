# IsaFlow ops — uptime/alerting probe (A–Z P3.2)

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
