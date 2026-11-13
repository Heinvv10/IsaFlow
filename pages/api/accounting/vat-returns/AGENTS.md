# VAT Returns API

VAT period submission workflow. Computes the return via `getVATReturn`, then posts the clearing journal that zeros Output/Input VAT balances and moves the net to Accrued Expenses.

Service: `src/modules/accounting/services/reports/vatSubmissionService.ts`. Computation service: `vatReturnService.ts`.

## Endpoints

| Method + path | Handler | Purpose |
|---|---|---|
| `GET /api/accounting/vat-returns` | `index.ts` | List submitted VAT returns. Filter: `?year=YYYY`. |
| `POST /api/accounting/vat-returns` | `index.ts` | Submit a VAT return. Body: `{ periodStart: YYYY-MM-DD, periodEnd: YYYY-MM-DD, sarsReference?: string, bankAccountId?: uuid }`. Posts the clearing journal and inserts `vat_returns` row. UNIQUE per `(company_id, period_start, period_end)` — second submission throws "already exists". |

## Auth

`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` — writes gated by role.

## Clearing journal

**Payable case** (output > input, the usual scenario):
```
DR 2120 VAT Output    = total_output_tax    (closes the output liability)
CR 1140 VAT Input     = total_input_tax     (closes the input receivable)
CR 2130 Accrued Exp   = net_vat             (net payable to SARS)
```

**Refund case** (input > output): flip the Accrued Expenses line to DR.

Balance enforced by `createJournalEntry.validateJournalEntry`. Source tag: `auto_vat_submission` (added to the `gl_journal_entries.source` CHECK constraint + `GLEntrySource` TS union as part of mig 402).

## Tables

- `vat_returns` (mig 402) — one row per submitted period per company. UNIQUE on `(company_id, period_start, period_end)`. Index on `(company_id, period_start DESC)`. FK to `gl_journal_entries.id` via `journal_entry_id`.

## Gotchas

- **No dedicated "VAT Payable" account** in the default chart. Net VAT lands in 2130 Accrued Expenses. If a tenant wants a dedicated VAT-Payable liability account, they should add one and override the service (not a per-tenant setting today).
- **`vat_returns` needs an explicit GRANT for app_user** — mig 402 was initially deployed without grants; the POST endpoint 500'd with "permission denied" until a manual `GRANT SELECT, INSERT, UPDATE, DELETE ON vat_returns TO app_user` was applied.
- **Period shape is a date range, not a period_id** — callers pass `periodStart`/`periodEnd` instead of a fiscal-period UUID. SA default is bi-monthly (Category B filers): Feb/Apr/Jun/Aug/Oct/Dec cover the two months before their end.
- **`getVATReturn` is read-only** — it can be called any number of times to preview the submission, without creating a `vat_returns` row. The POST/submit flow persists it.
- **Idempotency**: the UNIQUE constraint on `(company, periodStart, periodEnd)` is the only guard. If the first submission raced against a second, the second will fail at the INSERT (after the journal has been posted in a race window). For safety, run submissions sequentially per period.
