# Trial lifecycle emails cron

Daily job that emails the owners of each trial company at four points of its 30-day trial:

| Stage | When | Email |
|---|---|---|
| `setup_nudge` | 3 or more whole days after signup | the setup steps not done yet (skipped, nothing sent, when setup is complete) |
| `check_in` | 10 or more whole days after signup | service check-in: how it is going, help, setup checklist |
| `ending_soon` | the trial ends within 5 days | the end date and how to upgrade |
| `ended` | the trial ended in the last 7 days | what happens now and how to upgrade |

Each stage goes once per company (`trial_lifecycle_emails`, migration 1040). Only the latest due stage
is sent: after missed days a company gets the current email, never a burst of old ones. Demo and
internal companies, suspended companies, companies with a paying subscription, and ids in
`TRIAL_EMAIL_EXCLUDE_COMPANY_IDS` are never mailed. Code: `src/modules/onboarding/services/trialLifecycle/`.

## Environment (`/home/velo/isaflow/.env.local`)

| Var | Meaning |
|---|---|
| `CRON_SECRET` | already set for the other crons |
| `TRIAL_LIFECYCLE_EMAILS_ENABLED` | `1` to send. Anything else: every run is a dry run |
| `TRIAL_UPGRADE_URL` | optional `https://` or `mailto:` link for the upgrade button; default emails accounts@isaflow.co.za |
| `TRIAL_EMAIL_EXCLUDE_COMPANY_IDS` | optional comma-separated company UUIDs never to mail |

An env change takes `bash scripts/deploy/restart-colours.sh`, never `systemctl restart`.

## Dry run first

```bash
printf "X-Cron-Secret: %s\n" "$CRON_SECRET" | curl -sS --fail -X POST -H @- \
  'http://127.0.0.1:3101/api/cron/trial-lifecycle-emails?dry_run=1&limit=5'
```

The answer lists company id, stage, action (`would_send`, `would_skip_setup_complete`, `no_recipient`)
and recipient count. It never lists email addresses. `limit` defaults to 50, clamped 1 to 200.

## Install on velo-server (after the PR is merged and released)

```bash
sudo cp /home/velo/isaflow/scripts/isaflow-trial-lifecycle-emails.service /etc/systemd/system/
sudo cp /home/velo/isaflow/scripts/isaflow-trial-lifecycle-emails.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now isaflow-trial-lifecycle-emails.timer
sudo systemctl list-timers isaflow-trial-lifecycle-emails.timer
journalctl -u isaflow-trial-lifecycle-emails.service -n 50 --no-pager
```

Until `TRIAL_LIFECYCLE_EMAILS_ENABLED=1` is set, the timer only runs dry runs.

## Remove

```bash
sudo systemctl disable --now isaflow-trial-lifecycle-emails.timer
sudo rm /etc/systemd/system/isaflow-trial-lifecycle-emails.{service,timer}
sudo systemctl daemon-reload
```
