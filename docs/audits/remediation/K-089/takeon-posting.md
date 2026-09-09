# R-001 / R-002 / R-020 — take-on posting (wizard path only)

Implements the independent design memo. Its central argument is right and is the reason the
earlier "full invoice plus settlement journal" shape on this branch is now gone.

## The shape

One entry per imported document, two lines, at `total - amountPaid`:

| Document   | Debit                           | Credit                          |
|------------|---------------------------------|---------------------------------|
| AR invoice | `receivable` 750.00             | `opening_balance_equity` 750.00 |
| AP bill    | `opening_balance_equity` 750.00 | `payable` 750.00                |

No revenue, no expense, no VAT line. `entryDate` stays the original invoice date, `source` stays
`auto_migration`, `gl_journal_entry_id` is still written. A document settled in full before the
cutover posts nothing at all: it is created with its `amount_paid`, and `gl_journal_entry_id` is
left null because there is no entry to point at.

## Why, in one line each

- **VAT decides it.** `getVATReturn` is GL-based and sweeps every posted line on a
  `vat_input`/`vat_output` account into the return, with `vat_type IS NULL` landing in boxes 1 and
  15. Neither import passes a `vat_type`, so posting the full invoice re-declared its VAT in a
  period that is usually already filed. Lines that are never written need no filter, and no future
  VAT or P&L reader has to remember a `source <> 'auto_migration'` clause.
- **It stops restating pre-cutover P&L** into a closed period.
- **The control account now equals the subledger** by construction, not by a compensating second
  journal. Both close-readiness sub-ledger checks pass after an import; they failed before.
- **It dissolves R-002.** Both lines carry one figure, so subtotal and tax never have to balance
  against anything.

## R-002 — rounding

`|subtotal + tax - total|` up to R0.05 imports as given and raises a **warning**, on a new optional
`warnings` field of `ImportResult`; above R0.05 the row is refused with the message naming all
three amounts. Refusing at half a cent lost real invoices over the exporter's own rounding. No
rounding account is introduced: there is no such role in `SYSTEM_ACCOUNT_KEYS` and adding one would
make a new account mandatory on every tenant's chart for an edge case.

## R-020 — opening balances and documents

`importOpeningBalances` now refuses a trial-balance row whose account is a `receivable` or
`payable` control account, naming the invoice step that owns those balances. At `completeSession`,
a non-zero `opening_balance_equity` residual over `auto_migration` entries is **recorded on the
session's errors, not enforced**: the wizard is finished by then, and refusing to mark it complete
would strand the operator with imported data and no way forward.

## Scope

**Wizard path only.** `sageMigrationCommitService` posts its own journals through
`postCustomerInvoiceToGL(..., { historicalImport: true })` and its own expense/VAT/AP line array,
and is unchanged here — a separate follow-up, as instructed. `historicalImport` therefore still has
that caller; it is not orphaned by this change.

## Carried consequences, stated

- `gl_journal_entry_id` on a migrated document points at an entry for the OUTSTANDING amount, not
  the total. A reader that reverses a document from its posting entry is wrong for migrated
  documents. Named in the memo; not addressed here.
- **Payments-basis VAT**: output VAT on the outstanding portion is still owed when collected after
  the cutover, and take-on creates no deferred-VAT balance for it. It has to come in on the opening
  trial balance's VAT control accounts.
- `opening_balance_equity` is absent from many tenants' charts, and it is now required for ANY
  take-on file, not only part-paid ones. The step fails up front with a message naming the role and
  the remedy, and a test covers exactly that.
- `standardRatedSupplies` and `standardRatedPurchases` on the VAT return DO move when documents are
  imported: they are read from the invoice tables, not the GL, so any import that creates a document
  moves them under any posting shape. Every VAT201 box, transaction list and total is unchanged,
  which is what the memo asked for; the two turnover figures are asserted explicitly so the
  behaviour is recorded rather than discovered.

## The highest-risk unknown is still open

Whether any production tenant has already committed documents with `amount_paid > 0` through either
path decides forward-only versus a repair migration. **This session does not touch the production
database**, so the read-only query below has not been run. K-015 proves the AP wizard step never
once succeeded, so AP wizard exposure should be zero — but AR and the Sage path are unmeasured, and
the memo is explicit that zero must not be assumed from the AP evidence.

```sql
SELECT ci.company_id, ci.invoice_number, ci.total_amount, ci.amount_paid, ci.balance,
       je.entry_number, je.source, je.entry_date,
       SUM(jl.debit - jl.credit) FILTER (WHERE ga.account_subtype = 'receivable') AS ar_movement,
       SUM(jl.credit - jl.debit) FILTER (WHERE ga.account_subtype = 'vat_output') AS vat_declared
  FROM customer_invoices ci
  JOIN gl_journal_entries je ON je.id = ci.gl_journal_entry_id AND je.company_id = ci.company_id
  JOIN gl_journal_lines jl   ON jl.journal_entry_id = je.id AND jl.company_id = ci.company_id
  JOIN gl_accounts ga        ON ga.id = jl.gl_account_id AND ga.company_id = ci.company_id
 WHERE ci.company_id = $1 AND ci.amount_paid > 0
   AND je.source IN ('auto_migration', 'auto_invoice') AND je.status = 'posted'
 GROUP BY 1,2,3,4,5,6,7,8;
-- Same shape for supplier_invoices / 'payable' / 'vat_input' / 'auto_supplier_invoice'.
```
