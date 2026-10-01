# Design — R-001 / R-002 / R-020: take-on of partly paid documents

Read at K-015 tip `0a6c4c83`, K-038 tip `2b8261ae`, `origin/master` 5661d6f0.

## 1. What Sage and Xero do

Neither re-posts a pre-cutover document's P&L. Xero *conversion balances* and Sage's take-on put **only
the outstanding amount** on the AR/AP control account, contra to a conversion/opening-balance suspense
account. Revenue, expense and VAT are never re-posted, and the already-paid portion never appears at
all — the bank's own opening balance already carries that cash.

## 2. Recommendation — post the OUTSTANDING amount only (option A)

Reject the "full origination + settlement journal" shape now on the K-015 branch. Post one two-line
entry per take-on document. Role: `opening_balance_equity` (`systemAccountKeys.ts:41`), which
`resolveSettlementAccountId` in `migrationPostingSupport.ts` already resolves once per step.

Both examples: total 1150.00 (subtotal 1000, VAT 150), 400.00 already paid, outstanding 750.00.

| Document    | Debit                          | Credit                         |
|-------------|--------------------------------|--------------------------------|
| AR invoice  | `receivable` 750.00            | `opening_balance_equity` 750.00 |
| AP bill     | `opening_balance_equity` 750.00 | `payable` 750.00               |

No revenue, no expense, **no `vat_output` / `vat_input` line at all**. `entryDate` stays the original
invoice date, `source` stays `auto_migration`, keep writing `gl_journal_entry_id`.

Why A beats B (full + settlement):

- **VAT decides it.** `getVATReturn` (`vatReturnService.ts:58-104`) is GL-based: every posted line on
  a `vat_input`/`vat_output`/`tax` account in the period is read, and `vat_type IS NULL` is swept into
  **box 1 / box 15**. Neither migration path passes `vatType`, so under B every take-on document
  re-declares its VAT in the new system for the original period. `no_vat` does not fix it — it maps to
  input box 18 (`vatReturnService.ts:35`). Under A the lines do not exist, so nothing needs excluding.
- **B restates pre-cutover P&L** into a closed period, visible in every P&L, AFS and pack spanning it.
- **B needs a permanent filter** — a `je.source IS DISTINCT FROM 'auto_migration'` clause every future
  VAT and P&L reader must repeat, which misses the Sage path entirely (it posts `auto_invoice` /
  `auto_supplier_invoice`). **A also dissolves R-002** (§4): both lines carry one figure.

Cost of A: `gl_journal_entry_id` now points at an entry whose amount is the outstanding, not the total,
so readers that reverse a document from its posting entry are wrong for migrated documents (§7).

## 3. R-020 — opening balances plus documents

Under A the rule is enforceable, not advisory: **the opening trial balance must not carry an AR or AP
control line when the AR/AP document steps are used.** The documents supply those balances;
`opening_balance_equity` absorbs both contras and nets to zero once take-on is complete, which is the
account's stated purpose. Enforce in `importOpeningBalances`: refuse a TB row whose
`account_subtype` is `receivable` or `payable`, naming the AR/AP step instead. Mirror check at wizard
end: a non-zero `opening_balance_equity` residual means TB and documents disagree.
`customer_invoices.external_ref` having no reader is separate and harmless; leave it.

## 4. R-002 — rounding

**Do not add a rounding account.** There is no `rounding` role in `SYSTEM_ACCOUNT_KEYS`, and adding one
makes a new account mandatory on every tenant's chart for a take-on edge case. Under A the journal
cannot go unbalanced, so only the stored figures are in question. Rule: `|subtotal + tax - total| <= 0.05` imports as given with a **warning**; above 0.05 refuses the row
with the existing message naming all three amounts. The branch drops the document at 0.005, losing a
real invoice over a cent of the source's own rounding. `totalAmount` drives `balance` and the control
account, so cents of drift in `subtotal`/`tax_amount` cost nothing once VAT is not posted.

## 5. Files, functions, tests
On top of `0a6c4c83` and `2b8261ae`:

- `core/migrationPostingSupport.ts` — add `buildTakeOnLines(controlAccountId, clearingAccountId,
  outstanding, side)`; make `resolveSettlementAccountId` unconditional, since every take-on row needs
  the clearing account now, not only part-paid ones.
- `ap/migrationApService.ts` — in `importAPInvoices`, drop `default_expense`/`vat_input` resolution and
  the two-entry shape; post one take-on entry at `totalAmount - amountPaid`. Relax the R-002 guard.
- `core/migrationImportService.ts` — same in `importARInvoices`; add the control-account refusal to
  `importOpeningBalances`.
- `admin/services/sageMigrationCommitService.ts` — `commitARInvoice`: replace
  `postCustomerInvoiceToGL(..., { historicalImport: true })` with the take-on entry. `commitAPInvoice`:
  replace the expense/VAT/AP line array (`:250-256`) with take-on lines. Keep `createSupplierInvoice` and
  `settledAtSource` unchanged.
- `ar/customerPaymentAllocationService.ts` — `historicalImport` loses its only caller. Mention, do not delete.

Tests, real Postgres, `tests/integration/`, each mutation-proof:

1. Part-paid AR and AP: entry balanced; `receivable`/`payable` net movement equals `total - amountPaid`;
   `default_revenue`, `default_expense`, `vat_output`, `vat_input` net movement exactly 0.
2. `arSubLedgerCheck` and `apSubLedgerCheck` return `pass` after a mixed file. Today both `fail` past R100.
3. Fully paid document: control movement 0, status `paid`, no P&L line.
4. VAT201 unchanged: snapshot `getVATReturn` over the period before and after the import, assert every
   box amount and transaction count is identical.
5. R-002: a 0.01 discrepancy imports with a warning; 0.50 is refused naming all three amounts.
6. R-020: a TB carrying a `receivable` control line is refused; `opening_balance_equity` nets to zero
   after TB + AR + AP on a consistent fixture.
7. Sage parity: 1, 3 and 4 through `commitARInvoice` / `commitAPInvoice`.

## 6. Historical impact (read-only; no repair written)
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

K-015 proves the AP wizard step never once succeeded, so AP wizard exposure should be zero; AR and the
Sage path are the ones to count. A repair would be, per document, a reversing journal plus the take-on
entry plus a VAT201 restatement for any filed period — a separate, approved change.

## 7. Risks and the highest-risk unknown
- Readers that reverse a document from `gl_journal_entry_id` become wrong on migrated documents.
- **Payments-basis VAT**: output VAT on the outstanding portion is still owed when collected after
  cutover, and A creates no deferred-VAT balance for it. It is lost unless the opening TB carries it on
  the VAT control accounts.
- `opening_balance_equity` is absent from many tenants' charts (roles audit, 2026-09-04), so the step now
  fails for every take-on file, not only part-paid ones.
- **Highest-risk unknown:** whether any production tenant has already committed documents through either
  path with `amount_paid > 0`. It decides forward-only fix versus repair migration. The query above
  answers it; do not assume zero from the K-015 evidence, which covers AP only.
