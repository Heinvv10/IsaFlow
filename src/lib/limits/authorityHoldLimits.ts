// src/lib/limits/authorityHoldLimits.ts
//
// Batch maxima for every path that runs many elements in ONE request transaction while holding the company authority
// key. The key serialises every permission-checked transaction in a company from its first check to COMMIT, and every
// other same-company request waits at most 5 s for it before answering 503 (migration 838). The rule: a request must
// not hold the key longer than half that bound, 2.5 s. Each maximum below is set from measured per-element holds
// (tests/integration/controls/authorityBulkMeasure.int.test.ts and authorityBulkLimits.int.test.ts, on the shared
// fixture on velo-server at load 12-22, 2026-09-11): the per-element cost varied by up to 60% between runs, so each
// maximum keeps the WORST observed hold under 2.5 s, not the typical one. Remeasure before raising one. Plain numbers,
// no runtime: the UI imports them to split its own requests.

/** Documents approved and posted per call: bulk_approve_supplier_invoices, bulk_approve_credit_notes and the
 *  supplier-invoice bulk action route. Typically 88 ms per document, worst 144 ms: 15 x 144 = 2.2 s. */
export const MAX_POSTED_DOCUMENTS_PER_REQUEST = 15;

/** Customer invoices finalized per call (bulk_finalize_invoices): the same posting cost with the PDF really rendered,
 *  PLUS one object-storage upload per invoice that the fixture cannot make. 12 x 144 = 1.7 s leaves about 65 ms per
 *  upload; measure the upload in production before raising it. */
export const MAX_FINALIZED_INVOICES_PER_REQUEST = 12;

/** Bank lines per call: bulk_allocate_bank_transactions, reverse_bank_allocation_batch and reverse_allocations.
 *  Typically 160-210 ms per line, worst 344 ms (a reversal): 6 x 344 = 2.1 s. */
export const MAX_BANK_LINES_PER_REQUEST = 6;

/** Rule-sweep lines ATTEMPTED per request (bankRulesAutoPostSweep): posted lines are bounded by
 *  MAX_BANK_LINES_PER_REQUEST above (same controlled allocation, measured 213-318 ms per posted line over HTTP on
 *  the shared fixture at load 20-22, 2026-09-12); a REFUSED line costs 6 ms (unverified beneficiary, refused before
 *  the intent) to 28 ms (closed period, refused after it), so refusals get their own, wider bound. Worst case:
 *  6 x 318 + 18 x 28 = 2.4 s. Lines beyond either bound are deferred to the next request (`autoPostDeferred`). */
export const MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST = 24;

/** Recurring invoice templates generated and posted per "run all due" request (recurring-invoices-run; the route
 *  answers `remaining: true` and the page calls again). Worst measured 334 ms per template plus 425 ms fixed:
 *  6 x 334 + 425 = 2.4 s. */
export const MAX_RECURRING_INVOICES_PER_RUN = 6;

/** Supplier payments per payment batch, bounded at CREATION because processing posts the whole batch in one request
 *  (batch-payments-action process). Worst measured 228 ms per payment plus 243 ms fixed: 8 x 228 + 243 = 2.1 s.
 *  A batch created before this bound with more payments still processes whole (a known long holder). */
export const MAX_BATCH_PAYMENTS_PER_BATCH = 8;
