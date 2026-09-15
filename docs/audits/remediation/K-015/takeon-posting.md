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

## The race the lookup left open, and where it actually was

`lockMigrationImport(companyId)` takes `pg_advisory_xact_lock(hashtext(company_id ||
':migration-import'))` at the start of both document steps, before any read. It is
transaction-scoped, so `withAuth`'s single request transaction releases it on COMMIT or ROLLBACK
with no unlock to forget; it is re-entrant; and it is keyed on the company, so two tenants never
wait on each other.

**The race was AP only, and the first version of this test proved nothing.** I wrote the
concurrency test against AR, it passed, and then it *kept* passing with the lock removed. The
reason: the AR insert names `ON CONFLICT (company_id, invoice_number)` against
`uq_customer_invoices_company_number`, so a second inserter already blocks on that index and then
does nothing. AR was never racy. AP's idempotency is a bare read-then-write on
`duplicate_fingerprint`, which cannot carry a unique index, so two concurrent runs each find
nothing and both insert.

**Correction (blind review, 2026-09-09).** The retargeted AP test *also* kept passing with the lock
removed, and the reason matters. The fixture DB carries
`uq_supplier_invoices_supplier_number UNIQUE (company_id, supplier_id, invoice_number) WHERE
deleted_at IS NULL AND invoice_number <> ''`. That index is **not** in production and not on
master: it is K-107's migration 646, applied ad-hoc to the shared fixture by a sibling remediation
branch (`for b in refs/remotes/origin; do git grep -l ...; done` finds it on no origin branch;
`fix/audit-k107-k120-k121-document-numbering` holds it locally). So the earlier sentence "AP has no
unique constraint at all" is true of production today and false of the fixture, and the lock is
genuinely load-bearing in production while the fixture hid that from the mutation.

The test now asserts the outcome the lock alone produces, in both worlds: one document, one journal
entry, and a skip reported as `Already imported` — the wizard's own words from the fingerprint
lookup — with no `duplicate key` text. Without the lock it goes red either way: two rows where the
index is absent, a raw 23505 message out of the row's savepoint where it is present. Verified by
mutation on 2026-09-09.

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

## The highest-risk unknown is CLOSED — the fix is forward-only

The memo named this as the question that decides forward-only versus a repair migration: whether
any production tenant had already committed documents with `amount_paid > 0` through either path.

**Measured on 2026-09-09 by the team lead**, with the read-only query below, against production:
**0 `customer_invoices` and 0 `supplier_invoices`** with `amount_paid > 0` carrying an
`auto_migration` journal. Nothing was posted under the old shape, so there is nothing to repair.
This change is forward-only: no reversing journals, no VAT201 restatement, no data migration.

This session did not run that query and does not touch the production database; the result is
recorded here as reported.

The query, for whoever needs to repeat it:

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

One thing the probe does not settle: it covers the `auto_migration` journals this branch changes.
The Sage commit path posts under `auto_invoice` and `auto_supplier_invoice` and is unchanged here,
so its own exposure belongs with that follow-up.
