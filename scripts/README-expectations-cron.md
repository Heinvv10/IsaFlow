# Supplier Expectation Cron (PRD-05 Phase 6)

Daily job that recomputes each supplier's expected billing cadence, detects
gaps (invoices that should have arrived but didn't), and — when opted in —
sends chase emails automatically.

## What it does

1. For every active company: `recomputeAllForCompany` refreshes cadence +
   expected amount from recent `supplier_invoices` rows.
2. `detectGaps` creates `expected_invoice_alerts` rows for every locked
   expectation whose next expected date has passed without an invoice
   arriving within ±7 days.
3. If the company has `chase_auto_send_enabled=TRUE`, emails chase messages
   to overdue alerts (age ≥ `chase_grace_days`) where the supplier has an
   email on file and `chase_opted_out=FALSE`.

Step 3 is off by default. See "Opt-in rollout" below.

## Install on velo-server

```bash
# Copy the unit files
sudo cp /home/velo/isaflow/scripts/isaflow-expectations.service /etc/systemd/system/
sudo cp /home/velo/isaflow/scripts/isaflow-expectations.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# Generate a CRON_SECRET and add to /home/velo/isaflow/.env.local
echo "CRON_SECRET=$(openssl rand -hex 32)" | sudo tee -a /home/velo/isaflow/.env.local

# Restart the app so it picks up CRON_SECRET, then enable + start the timer
sudo systemctl restart isaflow
sudo systemctl enable --now isaflow-expectations.timer

# Verify
sudo systemctl list-timers isaflow-expectations.timer
# Manual run:
sudo systemctl start isaflow-expectations.service
# Inspect:
journalctl -u isaflow-expectations.service -n 50 --no-pager
```

The timer fires at 07:00 SAST daily with a randomised 0–300s jitter.

## Opt-in rollout (chase emails)

Chase auto-send is off by default — detection still runs, alerts still appear
in `/accounting/suppliers/missing-invoices`, but nothing leaves the system
until a human turns it on. Two levels of opt-in:

- **Per company**: `companies.chase_auto_send_enabled = TRUE` — globally
  enables auto-chase for the tenant.
- **Per supplier**: `suppliers.chase_opted_out = TRUE` — mutes auto-chase for
  a specific supplier even when company-level is on.
- **Grace period**: `companies.chase_grace_days` (default 3) — minimum days
  overdue before auto-chase fires.

## Manual one-shot

The endpoint accepts ad-hoc triggering with a valid `X-Cron-Secret`:

```bash
curl -X POST \
  -H "X-Cron-Secret: $CRON_SECRET" \
  http://127.0.0.1:3101/api/cron/expectations-daily
```

Response shape:
```json
{
  "success": true,
  "data": {
    "startedAt": "...",
    "finishedAt": "...",
    "companiesProcessed": 12,
    "totalGapsCreated": 3,
    "totalChasesSent": 1,
    "perCompany": [
      { "companyId": "...", "recomputed": 20, "locked": 15, "gapsCreated": 1, "chasesSent": 0, "chasesSkipped": 0 }
    ]
  }
}
```

Per-company failures are captured in the `perCompany[].error` field and
logged — they don't abort the run.
