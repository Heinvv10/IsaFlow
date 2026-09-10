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

Tests-first implementation state (no original unit retired):1d58db164 adds issued AP producer fixture and seven cancellation cases;7ba1062a2/acb89741e adds four payment and one actual nonempty batch case with real beneficiary verification/local evidence storage;cb6ed77b5 strengthens status cases to obtain actual approval before asserting financial refusal;24be67f9c adds inactive/ordinary closed-period post refusal;1da6caec3 adds three distinct historical AP/legacy admin cases. Total16 new PG cases, queued under root's exclusive lease protocol. Original23 failed units remain unchanged until the relevant producer cases actually pass.

The old Sage test title claims an unconditional direct-post exception. Current named commitAPInvoice instead calls ordinary approveSupplierInvoice, has no approval/import reference parameter, and its platform-admin callers do not issue the ordinary ControlTx. New historical AP tests do not establish that admin capability: they deliberately distinguish supported CSV retained-source execution from actual admin invoice ingress refusal/rollback. This is a required remaining authority/adapter capability, not permission to reintroduce a raw posted-status write or to claim all migration paths work.

## Exact failing-case traceability

C = apCiInvoiceCancellation.int.test.ts; P = apCiPaymentWorkflow.int.test.ts; B = apCiBatch.int.test.ts; H = apCiHistoricalIngress.int.test.ts; L = apCiLegacyInverse.int.test.ts. The names below identify actual test cases, not inferred production coverage. Existing two passing AR Sage unit assertions remain unchanged. No real authority, kernel, posting, inverse, beneficiary verification or financial DB write is mocked in C/P/B/H.

| Historical failing unit case | Current assertion location |
|---|---|
| Sage checks deactivated accounts before posting | C `refuses inactive posting...` (no retained prefix); Sage forwarding unit delegates exact original input |
| Sage inactive refusal writes no posted status | C inactive refusal exact state; Sage shared inactive refusal propagates and raw status writes remain zero |
| Sage create→guard→post ordering | Sage document→shared approval order, zero raw JE create/post; C actual inactive/closed guard leaves no retained prefix |
| Sage unconditional no-period-check post | H `retains the separately supported historical AP source date...` proves approved R1150/date/closed period; H distinct legacy admin refusal preserves state. Unconditional bypass intentionally not restored; admin saved-authority ingress remains REQUIRED gap |
| Cancel locks row then reverses journal | C `waits for the actual owned invoice row lock...` + `reverses the real approved invoice...` |
| Cancel skips already reversed journal | L still-approved legacy bill associated with a journal actually posted and reversed via independent shared journal approvals: fresh AP cancellation succeeds, full journal/line state unchanged, one existing inverse, invoice paid0. C separately verifies committed cancellation replay |
| Cancel reversal failure does not flip status | C `rolls back an inverse prefix...` exact complete before/after plus approval retry |
| Cancel blocks invoices with payments | C approved paid and partially_paid refusal cases, exact unchanged state |
| Cancel blocks already-cancelled invoice | C first case distinguishes same approved receipt replay from a newly approved operation (04006942b actual focused PG31336 passed) |
| Cancel unposted invoice without reversal | C `cancels an unposted bill...` compares entire journal population |
| Cancel concurrent winner | C `serializes two independently requested cancellations...` exactly one inverse |
| Cancel savepoint/400 failure | C caught final status SQL failure preserves journals, lines, invoices, payments, versions, effects and protected/event rows; ordinary savepoint rollback does not require poisoning unrelated outer work |
| Cancelled invoice cannot repost | C `refuses cancelled and foreign invoice posting...` specific cancelled refusal, unchanged state |
| Wrong tenant cannot post | Same C case uses actual other-company issued caller and owned missing-source refusal |
| Void reverses/unapplies/cancels | P first case exact bank credit115, invoice paid0, retained positive allocation115, cancelled payment, one contra |
| Void nonprocessed refusal | P status case obtains actual independent approval then requires `Only processed` refusal |
| Void reconciled refusal | P status case uses actual reconciled status and independent approval then requires reconciled refusal |
| Void savepoint failure | P final status failure exact unchanged financial/history state and successful same-approval retry |
| Void prior reversal | L still-processed legacy cash associated with an actually posted/reversed manual journal: fresh AP void cancels cash, paid115→0, retains allocation115 and unchanged full journals/lines with one inverse. P separately verifies committed void replay |
| Process owned bank query | P actual owned bank GL credit0/115, correct company/journal/account association |
| Process foreign bank refusal | P foreign source account cannot produce any financial change or foreign GL leg |
| Batch no invalid document FK | B real approved nonempty producer journal has source_document_id=null |
| Batch persisted journal association | B exact processed batch journal ID equals every child payment journal and owned posted source_record_id; totals115/115 |

Actual run53295:14 passed/3 failures (two historical fixture levels, one overstrong outer-rejection expectation). Corrections d6618e0af use real level3 accounts and exact savepoint-state assertion. Full17 PG61630 then passed2.65s; all pools/local storage listeners/triggers closed. Focused old five-file group after adaptation96e0a7181:11 passed539ms, including both unchanged AR forwarding cases. Full source TS, dedicated test TS and typed scoped lint93540 terminal0. No production file changed. Final04006942b assertion subsequently passed focused PG31336; no final integrated CI claim, root owns re-run after reviewed integration.


Independent review correction d41636d07 adds two distinct legacy cases rather than substituting already-cancelled receipt replay for a live parent. Both manual original journals and inverse journals are genuinely created/posted/reversed with independent journal approvals, then associated to owned legacy parent source rows; no approval/effect/audit receipt is seeded. Actual31336 terminal0 proves those two cases plus the newly-approved re-cancel refusal in1.89s. Eight other tests were filtered by command -t, not skipped in committed source. With17 earlier PG cases,19 distinct cases now have actual passing evidence (the corrected first case was re-run). All pools closed. Fixture actor calls real withControlRequest, whose withPrincipal checks controlWriteFailed before returning; the caught ordinary final-status SQL failure is still only a savepoint rollback test, not a claimed mandatory audit-failure test.

Final94583 terminal0: dedicated test TypeScript includes the added legacy cases, typed scoped lint checks all12 owned test/helper paths, and11 focused units pass. Application source remains unchanged and full source TS93540 passed. All resource leases released. Final named review and root integration pending; remaining legacy admin saved historical-authority ingress remains required programme work.
