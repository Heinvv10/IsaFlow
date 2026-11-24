# Subscription Charges Cron

Hourly job that bills recurring IsaFlow subscriptions through Paystack.
Endpoint: `POST /api/cron/subscription-charges` (`X-Cron-Secret` header).

This job debits real cards. Read the dry run before you enable the timer.

## What it does

Each run, in order:

1. `resolveStaleSubmittedCharges` settles or fails charges whose Paystack
   webhook never arrived.
2. `generateDueCharges` queues one charge for every `active` or `past_due`
   paid subscription whose `current_period_end` has passed, for the next
   period, using the company's active Paystack mandate. It then voids queued
   charges of subscriptions flagged `cancel_at_period_end` and closes those
   out.
3. `runQueuedCharges` debits up to 100 queued or retry-eligible charges
   (3 attempts, 24 hours apart; after the last failure the subscription goes
   `past_due`).

The period moves forward only when a charge settles.

## Unbilled subscriptions (no mandate)

A paid subscription past its period end whose company has no active Paystack
mandate gets no charge, so it is never billed. Each run:

- counts them in `generated.unbilledNoMandate` and lists up to 50 in
  `generated.unbilled` (company id, subscription id, period end, days overdue);
- logs one warn per subscription and one summary warn, both with
  `reason: "unbilled_no_mandate"`.

Nothing changes the subscription's status. Find them with:

```bash
journalctl -u isaflow-subscription-charges.service --no-pager | grep unbilled_no_mandate
```

## Dry run

Same auth, nothing written, no Paystack call:

```bash
set -a; . /home/velo/isaflow/.env.local; set +a
printf 'X-Cron-Secret: %s\n' "$CRON_SECRET" | curl --silent --show-error --fail \
  -X POST -H @- 'http://127.0.0.1:3101/api/cron/subscription-charges?dry_run=1'
```

If `.env.local` cannot be sourced (some values break `sh`), export only
`CRON_SECRET` from it by hand.

The response `data` has:

- `wouldCreateCount` / `wouldCreate`: charges a live run would queue, with
  `periodStart`, `periodEnd`, `amountCents` and `daysOverdue`;
- `unbilledCount` / `unbilled`: paid subscriptions that would stay unbilled;
- `skipped.existing` / `skipped.zeroAmount`;
- `wouldAttempt`: charges already queued or due a retry (a live run also
  attempts the ones in `wouldCreate`).

Lists are capped at 200 rows; the counts are not.

**Check `daysOverdue` before enabling.** A subscription whose period lapsed
months ago is charged one period per settled debit, so a live run every hour
bills each missed period in turn until it catches up.

## Install on velo-server (post-merge, after the release that ships it)

`CRON_SECRET` is already in `/home/velo/isaflow/.env.local` for the other
IsaFlow cron units.

```bash
# 1. Dry run (above) and read wouldCreate and unbilled.

# 2. Install the units
sudo cp /home/velo/isaflow/scripts/isaflow-subscription-charges.service /etc/systemd/system/
sudo cp /home/velo/isaflow/scripts/isaflow-subscription-charges.timer   /etc/systemd/system/
sudo systemctl daemon-reload

# 3. Enable the timer
sudo systemctl enable --now isaflow-subscription-charges.timer

# 4. Verify
systemctl list-timers isaflow-subscription-charges.timer --no-pager
journalctl -u isaflow-subscription-charges.service -n 50 --no-pager
```

To stop billing: `sudo systemctl disable --now isaflow-subscription-charges.timer`.
