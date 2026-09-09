# K-038 — Sage invoice migration discards source payment balances

**Claim (B F32, critical):** `commitARInvoice`/`commitAPInvoice` omit `amountPaid`, so a
part-paid R1,150 invoice imports as R1,150 outstanding.

**Corrected trigger:** Accurate, and the loss happens one layer later than "the mapper never
had it": the mapper *does* compute the figure, the `Mapped*Invoice` types drop it, and the
commit never writes it. Status is also wrong, not just the amount.

## Disposition: confirmed

## Evidence (all refs `git show ebeac9ca:<path>`; unchanged since 5661d6f0)
- `src/modules/accounting/services/core/sageAutoImportService.ts:246` and `:262` —
  `mapSageARInvoices` / `mapSageAPInvoices` both emit `amountPaid: inv.Total - inv.AmountDue`.
- `src/modules/admin/services/sageMigrationTypes.ts:40-60` — `MappedARInvoice` and
  `MappedAPInvoice` declare no `amountPaid` field, so the value is invisible downstream.
- `src/modules/admin/services/sageMigrationCommitService.ts:105-119` — the `customer_invoices`
  INSERT names 16 columns; `amount_paid` is not one, and `status` is hardcoded `'approved'`.
- `:139-146` — the AP path calls `createSupplierInvoice`, whose `SupplierInvoiceCreateInput`
  (`src/modules/accounting/services/ap/supplierInvoiceService.ts:66-72`) likewise has no paid
  field; `:180` then sets `status='approved'` unconditionally.
- Fixture schema: `customer_invoices.amount_paid numeric(15,2) DEFAULT 0`, and
  `balance numeric(15,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED`
  (same on `supplier_invoices`). So a dropped payment inflates the stored balance directly.
- No Zod/validation layer strips it: `pages/api/admin/migration/sage-commit.ts:53-78` casts
  `req.body` straight to `CommitBody` and forwards it.

## Reachability
`POST /api/admin/migration/sage-commit` → `withAdmin` → `commitSageMigration`
(`sageMigrationCommitService.ts:260-266`) → `commitARInvoice` per record. Staff-only, but it is
the supported onboarding path for every Sage client, so every migrated ledger is affected.

## RED test
`tests/integration/k-038-sage-migration-discards-amount-paid.int.test.ts` — real Postgres.
Sage row Total 1150 / AmountDue 500. Mapper yields `amountPaid` 650; the committed row has
`amount_paid` 0 and `balance` 1150. FAILS: `expected +0 to be 650`. Output in `red.log`.

## Proposed minimal fix
1. Add `amountPaid?: number` to `MappedARInvoice` and `MappedAPInvoice` in
   `sageMigrationTypes.ts`.
2. In `commitARInvoice`, add `amount_paid` to the INSERT column list with
   `${Math.min(inv.amountPaid ?? 0, inv.totalAmount)}`, and derive `status` as
   `paid` / `partially_paid` / `approved` from that value instead of the literal.
3. For AP, add `amountPaid` to `SupplierInvoiceCreateInput` (or `UPDATE supplier_invoices SET
   amount_paid = ... ` alongside the existing status UPDATE at `:180`) and derive status the
   same way.
Note this records the balance only; it does not create payment documents or a bank/GL leg, so
the AR/AP control accounts will not match the subledger unless opening balances cover the
difference. Flag that to whoever runs the next migration.

## Historical-data impact
Every invoice imported through this path since the feature landed carries `amount_paid = 0`
and `status = 'approved'`, so aging, statements and the customer/supplier balance are
overstated by whatever was already paid in Sage. Read-only impact query:
```sql
SELECT company_id, count(*) AS invoices, sum(total_amount) AS overstated_max
FROM customer_invoices
WHERE amount_paid = 0 AND status = 'approved' AND created_by IS NOT NULL
GROUP BY company_id ORDER BY 3 DESC;
```
This over-counts (genuinely unpaid invoices look identical), so it bounds rather than measures
the exposure. Sage's `AmountDue` is not stored anywhere in IsaFlow, so an exact reconciliation
needs a re-pull from Sage per migrated company.

## Risks
Fixing the amount without the corresponding cash/GL entries changes the AR/AP subledger
without changing the control account. Treat the fix and any historical correction as separate
decisions.
