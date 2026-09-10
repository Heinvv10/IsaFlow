# K-123 — listDisputes returns the page size as the total

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** The total count returns the row count of the current page, so pagination is wrong.

**Corrected trigger.** The arithmetic is confirmed; the stated consequence is not. disputeService.ts:246
returns `total: disputes.length` and issues no COUNT(*). But the only UI consumer,
`pages/accounting/disputes/index.tsx:48`, reads `json.data.disputes` and ignores `total` entirely —
it has no pager at all. So the live harm is (a) `total` is a lie for any API/MCP consumer, and
(b) the disputes page silently truncates at the default limit of 50 with nothing on screen saying so.
"250 disputes invisible" is true of the UI regardless of this bug.

**Disposition: confirmed** (medium, reporting-only; no ledger effect).

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/disputeService.ts` :186-247.
- RED: `tests/integration/k123-list-disputes-total.int.test.ts` — 1 failed. 3 open disputes,
  `limit: 2` → `total` 2, expected 3.

**Reachability.** `pages/api/accounting/ar/disputes/index.ts:50` under `withAuth`.

**Proposed minimal fix (1 file).**
Add a matching `COUNT(*)` per filter branch — the same four-branch shape
`getRecurringInvoices` already uses (recurringInvoiceService.ts:43-64) — and return
`Number(countRows[0]?.cnt || 0)`. The count must repeat the branch's WHERE, not the LIMIT/OFFSET.

**Historical-data impact.** None. No rows are written or read incorrectly; only the reported count
is wrong.

**Risks.** Doubling the query count on a hot list endpoint. Negligible at dispute volumes; the
existing indexes on `customer_invoice_disputes(company_id, status)` cover the count.
