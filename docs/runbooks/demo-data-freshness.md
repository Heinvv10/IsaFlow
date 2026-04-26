# Demo Data Freshness

Use this when the demo dashboard shows stale operational dates, such as invoices
thousands of days overdue.

## Scope

The refresh targets only the ISAFlow Demo company:

`00000000-0000-0000-0000-000000000001`

It refreshes:

- open customer invoice `invoice_date` and `due_date`
- open supplier invoice `invoice_date` and `due_date`
- imported or matched bank transaction dates

It does not change amounts, counterparties, invoice numbers or non-demo tenants.

## Refresh Existing Demo Data

1. Confirm `.env.local` points at the intended demo database.
2. Preview the current age profile:

   ```bash
   bun scripts/refresh-demo-dashboard-dates.ts
   ```

3. Apply the refresh:

   ```bash
   bun scripts/refresh-demo-dashboard-dates.ts --apply
   ```

4. Recheck `/api/accounting/dashboard-todos` or the accounting dashboard.
   The maximum overdue age should be measured in days or weeks, not years.

## Rebuild Demo Seed Data

For a full reseed, run:

```bash
bun scripts/seed-demo-data.ts
```

The seeder now uses a rolling month window around the current date so new demo
records do not age into obviously stale dashboard data.
