# Demo Data Freshness

Use this when the demo dashboard shows stale operational dates, such as invoices
thousands of days overdue.

## Scope

The tools here target only the IsaFlow Demo company:

`00000000-0000-0000-0000-000000000001`

It refreshes:

- open customer invoice `invoice_date` and `due_date`
- open supplier invoice `invoice_date` and `due_date`
- imported or matched bank transaction dates

It does not change amounts, counterparties, invoice numbers or non-demo tenants.

## Rebuild the Demo company (preferred)

`scripts/reseed-demo-company.ts` replaces every Demo transaction with fictional,
date-safe data in one transaction: a rolling 24-month window ending on the run
date, nothing dated after it, healthy ageing, bank reconciled to last month end,
payroll paid to last month with this month in draft. It refuses any company but
the Demo company and reads its database URL from `DEMO_RESEED_DATABASE_URL` only
(never `.env.local`). It prints the host and database, never the password.

```bash
# 1. What is wrong today (read-only, exit 1 when a check fails)
DEMO_RESEED_DATABASE_URL=postgresql://... bun scripts/reseed-demo-company.ts \
  --company 00000000-0000-0000-0000-000000000001 --check-only

# 2. What the run would delete, insert and keep (writes nothing)
DEMO_RESEED_DATABASE_URL=postgresql://... bun scripts/reseed-demo-company.ts \
  --company 00000000-0000-0000-0000-000000000001 --dry-run

# 3. The reseed itself: COMMITs only when every post-check passes
DEMO_RESEED_DATABASE_URL=postgresql://... bun scripts/reseed-demo-company.ts \
  --company 00000000-0000-0000-0000-000000000001
```

Keep the printed `run record` line (txid, git SHA, date, seed): it is the event
record of the reseed. On production this is a separate step that needs Hein's
approval, off-hours, never while a deploy or its verification is running. The
contract, the wipe and keep lists and the post-checks are in
`scripts/lib/demoReseed/.claude.md`.

`scripts/seed-demo-data.ts`, `scripts/seed-payroll-data.ts` and
`scripts/seed-practice-data.ts` are retired: each now runs this same reseed.

## Refresh Existing Demo Data (dates only)

Superseded by the rebuild above. To shift open document dates without a reseed:

```bash
bun scripts/refresh-demo-dashboard-dates.ts --company 00000000-0000-0000-0000-000000000001          # preview
bun scripts/refresh-demo-dashboard-dates.ts --company 00000000-0000-0000-0000-000000000001 --apply  # apply
```

Then recheck `/api/accounting/dashboard-todos` or the accounting dashboard. The
maximum overdue age should be measured in days or weeks, not years.
