# AP CI assertion migration

Exact isolated base f5d017f5f; inventory7239fad40. Own only five units: sageCommitApInvoiceGuards, supplierInvoiceCancelReversal, supplierPaymentVoid, supplierPaymentWorkflowService and ap/batchPaymentService, plus new AP fixture/PG tests and this traceability map. No BANK/AR/GL production or tests, shared authority or migration edits. Root/nested accounting/AP instructions read. Baseline actual focused run:23 failed/2 passed across5files, terminal1,527ms; artifact ap-ci-baseline-red.log. Four Sage failures are missing approveSupplierInvoice mock;19 are unissued-control boundaries before economic assertions. These failures alone do not establish production regressions.

Preserve the original tests until actual replacement proof passes. New fixture apCiWorkflowFixture will seed synthetic owned source documents/accounts/periods only, establish real withControlRequest/app_user/RLS, and use real requestOperationApproval/independent decideOperationApproval. No constructed permits/effects or fake kernel. New apCiInvoiceCancellation/apCiPaymentWorkflow/apCiBatch integration tests cover uncovered cases; existing apSharedWriters, cashApplicationAdversarial and historicalImportExecution/SageSource suites provide related proof but are not assumed to cover a different producer.

| Old assertions | Required retained proof |
|---|---|
| Invoice cancel locks then reverses approval journal | Actually approve/post a bill, cancel with independent approval, exact inverse dimensions/money/status; separate held-lock concurrent refusal/serialization |
| Already reversed invoice journal | Distinguish legitimate retained cancelled receipt replay from unexplained pre-reversed legacy header; no second inverse, never silently authorize forged provenance |
| Reverse failure and savepoint | Inject actual SQL failure after inverse prefix; caught error cannot commit journal/status/evidence/approval consumption; retry remains valid |
| Paid/partially paid/cancelled refusal | Current source statuses tested under actual issued authority; no new effects or balance changes |
| Unposted cancellation | Real draft source cancel has no journal; actual controlled effect/status retained |
| Concurrent cancel winner | Two requests against same source produce at most one economic inverse; stale/unrelated approval cannot create another |
| Cancelled/foreign post refusal | Actual current shared post boundary refuses both before journal; tenant snapshots unchanged |
| Payment inverse/unapply/cancel | Produce actual payment with invoice allocation; independently authorize unapplication/inverse as current contract requires; exact invoice paid amount, retained positive application history and cancelled cash |
| Payment nonprocessed/reconciled refusal | Actual owned status/reconciliation blocks, not mocked read-only state |
| Payment prior inverse/savepoint | Valid committed inverse replay vs unexplained legacy journal, complete transaction rollback |
| Payment bank lookup/foreign bank | Owned active bank posts correct credit; foreign bank under same payment refuses approval/material/effect, no foreign GL leg |
| Batch no captured-document FK misuse | Real nonempty approved batch posts with source_document_id absent and exact supplier_payment_batches.gl_journal_entry_id; child payment links and amounts agree |
| Sage inactive/ordering/closed-period | Current commitAPInvoice delegation unit retains exact date/input/refusal, no raw posted SQL. Actual historical AP import must preserve original closed period with authenticated retained source/independent approval, inactive/locked/unauthorized refusal and rollback. Sage ledger source is not automatically proof for admin invoice commit; unsupported trusted admin ingress is reported as a gap |

Two currently passing AR delegation assertions inside the Sage-owned file remain intact. Old unconditional historical bypass and internal-spy expectations may be replaced only with the documented current contract and corresponding real proof. Pure adapters may mock collaborators for forwarding/error propagation but cannot count as approval/authority or economic acceptance. No blanket requireControlTx mock, skip or removal of financial assertions.

Execution: read actual material/producer dependencies and finish case-level mapping; write new PG cases before any production change; request serialized PG lease. Report any real producer RED to root with exact source allocation before fixes. Only then adapt obsolete units to meaningful current pure forwarding/validation and explicit unissued negative tests, linking every migrated economic assertion here to a passing actual case. Final focused units, real PG, source/test TS, scoped lint, independent named review, root integration and full integrated CI remain required.
