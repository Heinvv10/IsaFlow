# K-015 / K-089 — migration wizard wrote columns that do not exist

**Trigger.** `importAPInvoices` and `importARInvoices` INSERT `balance_due`; no table in the
schema has that column (`balance` is GENERATED as `total_amount - amount_paid`). The AR INSERT
also wrote `reference`, which `customer_invoices` does not have either. Every row raised 42703,
the per-row `catch` counted it `skipped`, and the aborted transaction made the closing
`updateSession` raise 25P02 — so both wizard steps returned 500 and imported nothing.

**Before.** POST /api/accounting/migration/{ap,ar}-invoices: 500, 0 rows, `skipped` = row count.
**After.** Rows import. `balance` is left to the generated column; the source reference goes to
`supplier_invoices.reference` (AP) and `customer_invoices.external_ref` (AR, migration 530).
Each row now runs inside its own savepoint, so a row that genuinely fails is contained: it is
counted `skipped` with an error, the remaining rows still import, and `updateSession` survives.
`imported`/`skipped` are now decided by the row's real outcome, not by reaching the end of a block.

**Files.**
- `src/modules/accounting/services/ap/migrationApService.ts`
- `src/modules/accounting/services/core/migrationImportService.ts`

**Tests.** Real PostgreSQL, service driven inside the single request transaction `withAuth`
supplies. `tests/integration/k015-ap-migration-balance-due-column.int.test.ts` (4) and
`tests/integration/k089-ar-migration-balance-due-column.int.test.ts` (4) — 8 passed. Each file
covers: import with `amountPaid` > 0 (amount_paid preserved, balance derived, balanced journal
agreeing with the invoice), a mid-batch failing row, same-name contact in a second tenant, and an
unmatched contact. Mutation checks for all five production edits in `green.log`.

**Migration / rollback.** None. Revert the two files to roll back.

**Historical data.** No stored rows can be wrong — no INSERT ever succeeded. The impact is
absence. Read-only check for tenants whose wizard run died:
```sql
SELECT company_id, id, ap_invoices_imported, ar_invoices_imported, errors
  FROM migration_sessions
 WHERE errors::TEXT LIKE '%balance_due%' OR errors::TEXT LIKE '%"reference"%';
```

**Limits.** Proven at the service layer inside a withAuth-shaped transaction, not through an HTTP
request with a live GoTrue session. R-001 and R-002 both still reproduce — see below; not fixed here.

## R-001 / R-002 on the fixed path (measured, not fixed)

**R-001 — reproduces.** Importing a fully paid bill (total 115, amountPaid 115) stores
`amount_paid` 115, `balance` 0, `status` 'paid', and posts exactly one journal: DR expense 100 +
DR VAT 15 / CR payable 115. Measured: payable control net credit 115.00, journal entries 1,
bank/cash lines 0. The subledger says nothing is owed while the AP control account still carries
the full 115, and no settlement journal or bank leg exists.

**R-002 — reproduces.** subtotal 33.33 + tax 5.00 against total 38.34 makes the journal
DR 38.33 / CR 38.34. `postJournalEntry` rejects it: "Entry is not balanced: total debit R38.33 !=
total credit R38.34 (difference: R0.01)". Result `{imported: 0, skipped: 1}`, 0 invoice rows. The
savepoint now contains it — the run no longer 500s — but the row is dropped with only an error
entry, so a rounding difference in the source file silently loses the document.
