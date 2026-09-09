# K-134 — a header-only supplier invoice cannot be approved

**Claim.** `buildExpenseLines` produces nothing for a header-only bill, so approval
throws.

**Corrected trigger.** `buildExpenseLines`
(`supplierInvoiceWorkflowService.ts:29-67`) iterates `invoice.items ?? []` and returns
an empty array for a bill with no lines. `approveSupplierInvoice` then assembles
DR VAT input (`taxAmount`) + CR Accounts Payable (`totalAmount`) and nothing else, so
`validateJournalEntry` rejects it twice over: fewer than two lines, and debits ≠
credits. `postSupplierInvoiceToGL` builds the same lines and fails identically, so the
"Post to GL" bulk action cannot rescue the bill either. The document is permanently
stuck at `draft` — never a payable, never in the GL, invisible to aged creditors
(which excludes `draft`).

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts:29-67,144-186`.
- Executed RED test, 2 of 2 failing, with the service's own message:
  `Invalid journal entry: Journal entry must have at least 2 lines for double-entry;
  Entry is not balanced: total debit R150.00 != total credit R1150.00`.

**Reachability.** Header-only bills are written by the product, not only by hand:
- `core/recurringTransactionService.ts:217` inserts a supplier invoice from a recurring
  template with a total and NO line items at all — every recurring supplier bill in
  the system has this shape;
- `core/sageImportService.ts:421` writes items only when the Sage payload carried
  parseable lines;
- `pages/api/accounting/ai-invoice-pipeline.ts:133` inserts the header, then skips
  every extracted line failing its quantity/price check.

**RED test.** `tests/integration/k134-header-only-supplier-invoice-approval.int.test.ts`
(2 tests, 2 failed) — output in `red.log`.

**Proposed minimal fix.** In `buildExpenseLines`, when `items` is empty, return a single
line debiting `defaultGlAccountId` for `invoice.subtotal` with the invoice's own
description. That is the account the function already falls back to per line, and it
makes the journal balance for both the VAT and the zero-VAT case. Four lines, one
function, and it fixes `postSupplierInvoiceToGL` at the same time.

**Historical-data impact.** Bills that could never be approved and so never hit the
ledger. Read-only impact query (NOT run — production out of scope):

```sql
SELECT si.company_id, COUNT(*) AS headerless, SUM(si.total_amount) AS unposted
FROM supplier_invoices si
WHERE si.status IN ('draft','pending_approval')
  AND NOT EXISTS (SELECT 1 FROM supplier_invoice_items i
                  WHERE i.supplier_invoice_id = si.id)
GROUP BY si.company_id;
```

**Risks.** Bills previously stuck become approvable and will post expense to the default
expense account, uncoded. That is correct — an uncoded expense on the default account
is a bookkeeping task; an unposted liability is a wrong balance sheet. Worth a follow-up
that the recurring-template path writes a real line instead.

**Related.** Separate root cause from K-014 (double GL post) in the same file.
