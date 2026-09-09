# Existing posted cash application controls — proposed migration640 slice

Owner ar_recovery; current bank worker baseline ba2c0b62. Root owns migration640 allocation, central operation contracts/policies, registry, and integration. This plan does not authorize worker schema changes. Bank posting/reversal is a separate dependency.

## Confirmed source map and first actual failing scenario

Current customer-allocations REST and writeApplyReceipt MCP call planReceiptApplication then applyReceiptPlan. Supplier-allocations REST and writeApplySupplierPayment MCP call planSupplierPaymentApplication then applySupplierPaymentPlan. Both exported apply functions accept mutable caller-built plans and insert allocation rows/update invoice balances and payment status without an effect permit or committed control event. CustomerAutoAllocate and supplierAutoAllocate also invoke these writers; bankRuleAutoPostLine invokes recordSupplierBankPayment. Mere source inspection is not yet actual policy-bypass proof for this slice.

First real PG RED: actual shared customer invoice posting, real independently approved bank receipt with empty immutable applications, then the exact legacy planReceiptApplication/applyReceiptPlan sequence used by REST/MCP to apply that already-posted receipt to the new target. Existing supported payment approval rule remains required. Expect refusal without a fresh immutable application approval; inspect balance/allocation/effect rows. No financial mocks. This separates original approved cash receipt from a subsequent unapproved subledger allocation.

## Proposed owned files and interfaces

Proposed frozen operations: cash_application.apply/entity cash_application_intent and cash_application.reverse/entity cash_application_reversal_intent, with payload kind customer/supplier. Reuse supported payment approval rule and existing read/write:bank-tx plus execution write:post, aligning customer/supplier payment parents. Current MCP cash-application wrappers advertise write:invoices; root must reconcile transport scope with the actual shared authority contract rather than invent write:bills or letting the wrapper scope substitute for domain authorization.

- New shared cashApplicationPlan.ts: strict discriminated customer/supplier payload with owned payment ID, explicit accounting date, bounded ordered unique invoice IDs and positive exact decimal string amounts. Decimal80; reject unsupported FX and mixed denominations; never accept caller-authored balances, statuses, actor identity or journal IDs.
- New cashApplicationControl.ts and cashApplicationMaterial.ts: prepareCashApplication(ctx,input) persists immutable intent and protected preparation event; executeCashApplication(ctx,intentId,{approvalId?}) rechecks current authority, original requester, exact material, policy and receipt replay using the existing kernel. Export materializeCashApplicationOperation(ctx,ref):Promise<ApMaterial> for root dispatch.
- New cashApplicationSources.ts: lock owned posted payment and live unreversed source journal, exact existing allocation population and active target invoice/journal bindings, current target balances, currency, chosen date/period/VAT/lockdown facts, supplier beneficiary where policy requires it. Bind existing bank parent receipt when applicable. Root must choose how subsequent authorized application extends the bank receipt's observation/reversal proof: do not mutate immutable bank intent or fabricate matching afterFingerprint. Safe initial refusal for bank-origin cash is preferable to silently breaking its reversal provenance.
- New cashApplicationEffect.ts: issued parent permit required before every balance/allocation/status mutation; exact numeric SQL; same-operation protected child events; immutable result records actual state after writes. No second cash journal is created merely to allocate already-posted cash. Reversal/unapplication must preserve original allocation evidence and prove its original effect, using a separate immutable inverse intent or explicit append-only inverse linkage chosen centrally.
- Existing receiptApplicationService.ts and supplierPaymentApplicationService.ts: route all exported apply paths through immutable approved execution or enforce an internal permit. Planning is read-only and not authority. Customer/supplier auto-allocation freezes selected targets before approval; background strings/source labels are not principals.
- REST customer-allocations/supplier-allocations and MCP writeApplyReceipt/writeApplySupplierPayment: expose preparation/approval/intended execution references with stable retry. Root owns MCP schema/discovery. Preserve already controlled bank-match creation path through bank parent.

## Adversarial and integration acceptance

Real PG must prove required approval and self-approval through another PAT refusal; current caller/requester/approver revocation; stale target invoice/status/journal/paid balance and changed payment allocation population; tenant isolation; exact remaining balance/over-allocation; bounded decimals; unsupported FX; concurrent application and idempotent retry; transaction rollback of allocations/balances/history/effect; explicit accounting date period/VAT/lockdown; valid source evidence where required; and approved inverse restoration without deleting original evidence. Parent bank reversal after an authorized later application must either correctly include a bound application chain or explicitly require controlled unapplication first. Do not certify this dependency by happy-path balance checks alone.

Actual RED executed under exclusive root lease: one failure in1.13s (`cash-application-red.log`). Production legacy application committed115 to the target, marked invoice paid and receipt reconciled, despite the required supported payment policy and no fresh application approval. This is a genuine financial policy bypass, not a fixture or unsupported-rule failure. Pool closed and lease returned. Root accepted proposed operation/entity and existing permission contracts. No implementation, migration, full CI, HTTP, or production verification is claimed by this checkpoint.


## Allocation consumer inventory at frozen f671a156

Every TypeScript mention is listed below, including comments/schema allowlists so they are not mistaken for financial readers. New cash files are excluded from this frozen baseline. Each active sum needs active-row semantics; each cutoff report needs original application/reversal accounting dates; protected evidence may intentionally include historical rows.

- `pages/api/accounting/customer-allocations-export.ts`
- `pages/api/accounting/customer-allocations.ts`
- `pages/api/accounting/customer-payments-export.ts`
- `pages/api/accounting/customer-statement-detail.ts`
- `pages/api/accounting/customer-statement.ts`
- `pages/api/accounting/supplier-allocations.ts`
- `src/modules/accounting/services/ap/batchPaymentService.ts`
- `src/modules/accounting/services/ap/supplierAllocationLines.ts`
- `src/modules/accounting/services/ap/supplierPaymentApplicationService.ts`
- `src/modules/accounting/services/ap/supplierPaymentService.ts`
- `src/modules/accounting/services/ap/supplierPaymentSettlement.ts`
- `src/modules/accounting/services/ap/supplierStatementBalancesService.ts`
- `src/modules/accounting/services/ap/unappliedPaymentService.ts`
- `src/modules/accounting/services/ar/customerInvoiceCancelService.ts`
- `src/modules/accounting/services/ar/customerPaymentService.ts`
- `src/modules/accounting/services/ar/receiptAllocationLines.ts`
- `src/modules/accounting/services/ar/receiptApplicationService.ts`
- `src/modules/accounting/services/ar/unappliedReceiptOrigin.ts`
- `src/modules/accounting/services/ar/unappliedReceiptService.ts`
- `src/modules/accounting/services/bank/bankAllocationChildEffect.ts`
- `src/modules/accounting/services/bank/bankAllocationSources.ts`
- `src/modules/accounting/services/bank/bankAllocationUnwind.ts`
- `src/modules/accounting/services/controls/apOperationMaterializer.ts`
- `src/modules/accounting/services/controls/approvalQueries.ts`
- `src/modules/accounting/services/controls/arSourceMaterial.ts`
- `src/modules/accounting/services/controls/transactionEvidenceApprovals.ts`
- `src/modules/accounting/services/controls/transactionEvidenceRelations.ts`
- `src/modules/accounting/services/core/nlQueryFkPairs.ts`
- `src/modules/accounting/services/core/nlQueryValidationService.ts`
- `src/modules/accounting/services/core/paymentLock.ts`
- `src/modules/accounting/services/reconciliation/settlementFlagService.ts`
- `src/modules/accounting/services/reconciliation/unappliedCashService.ts`
- `src/modules/accounting/services/reconciliation/unpostedDocumentService.ts`
- `src/modules/accounting/services/shared/agingRewind.ts`
- `src/modules/accounting/services/shared/autoAllocateStrategy.ts`

Root ownership intersections: controls/{apOperationMaterializer,arSourceMaterial,approvalQueries,transactionEvidenceApprovals,transactionEvidenceRelations}; AR/AP cancellation and settlement shared contracts; historical aging/report semantics. Worker owns cash application adapters and must coordinate these intersections before edits. NL allowlists/FK catalog and autoAllocateStrategy comments need classification, not blind SQL predicate edits. Existing source baseline lacks subsequently integrated payment-release additions; root must reconcile the final integration tree inventory before closing the reader migration.

## Frozen storage decision and isolated foundation

Root accepted nullable application_intent_id, reversed_at, reversal_intent_id on both live allocation tables. Positive allocation rows remain; reversal binding is one-way and owned. Historical reads use original intent accounting_date/reversal intent reversal_date; current sums filter reversed markers. Root owns640 DDL and later global maker-hook registration for these new intents. No row deletion or negative-amount workaround is permitted.

Cash worktree/branch: `.worktrees/mcp-forensic-cash-application-20260909` / `feat/mcp-forensic-cash-application-20260909`, exact base f671a156; bank tree preserved. Pure plan/preparation boundary missing-module REDs → five focused units GREEN. Current source/preparation is authored against frozen names but has no actual schema or PG preparation proof yet. Deferred source admission for supplier batch-origin payments must be reconciled with the newer release stack, which is absent from this worker baseline; never infer a valid posted source merely from an arbitrary owned journal ID.

## Cash foundation dependency checkpoint

Owned pure plan, source/target locks, preparation, apply materializer and internal permitted apply effect are implemented. Source validates live exact original cash journal and supported denomination, locks original invoice denomination rows, validates owned current target journals, observes complete bounded allocation history, current period/VAT/lockdown and beneficiary state. Preparation freezes exact sources. Apply material compares immutable fields/fingerprint and verifies actual after-state for known receipts; internal effect appends intent-linked rows and records exact balance/status changes with protected child history, without a second cash journal.

Five focused units, full source TypeScript and scoped source lint passed (`cash-foundation-unit.log`, `cash-foundation-types.log`, `cash-foundation-lint.log`). Missing-module boundary/pure RED logs preserved. No640 DDL or actual preparation/execution GREEN exists yet; central dispatch, maker hook, public executor, inverse, current/history reader migration, legacy adapters and full workflow adversarial proof remain required. This is a dependency checkpoint for independent review, not a completed cash application capability.

## Origin correction and inverse work in progress after73eb6e05

Author source review found current payment/JE amount agreement insufficient for bank-origin cash: a fresh application source could adopt jointly doubled balances despite immutable original bank intent amount. Genuine actual source PG RED reproduced (`cash-original-bank-amount-red.log`,967ms). Correction authenticates exact bank effect, same-operation committed parent change and owned protected evidence, then compares original financial payment/bank fields and exact journal line account/amount/direction/VAT/dimensions with the original recorded plan. It returns only compact proof identity/fingerprint, not decrypted private data. Three real PG GREEN (`cash-bank-origin-three-pg.log`,1.37s) cover doubled balanced amounts, swapped direction and unchanged valid source. Pool closed and lease returned. Cash child events now explicitly use permit.operationId.

Inverse pure plan and issued-context boundary RED→three units GREEN. Uncommitted inverse source/material/preparer/internal effect verify exact original effect allocation IDs and amounts, preserve positive rows with inverse markers, recompute remaining active application status and restore invoice balances. Neither inverse nor public execution has actual PG verification yet; root640 schema/operation/maker-hook and central dispatch are pending. Additional date-agreement source test is authored for the next PG run. Current-state readers are worker-owned as coordinated; historical/central intersections remain root-owned. No final integration or capability completion is claimed.

## Verified preparation and inverse dependency checkpoint

Root640 migration630742aa cherry-picked as041a4990; only appended progress-ledger conflict resolved by retaining root additions. Full source TypeScript, scoped cash source lint and eight focused units passed (cash-origin-inverse-types.log, cash-origin-inverse-lint.log, cash-origin-inverse-unit.log). Five real PostgreSQL checks passed in4.88s using vitest.integration.config.ts (cash-preparation-five-pg.log): immutable preparation preserves balances/allocation population, tampered original bank amount and direction refuse, unchanged bank-origin cash admits, mismatched target invoice/JE date refuses. Pool closed and DB lease returned. Original legacy adapter bypass remains deliberately excluded and unresolved.

Named foundation includes inverse plan, preparation, material and internal permitted effect as a dependency for central dispatch; no public apply/reverse executor or actual inverse financial workflow has been verified. Required next: central operation/maker hook, execution and approved application/inverse PG, active/as-of reader migration, legacy adapters and full adversarial scenarios. Source-only inverse is not capability completion.

Current integration reader reconciliation at84b7ab5c adds ap/batchPaymentWriteService.ts, ap/paymentReleaseSource.ts and controls/invoiceRiskQueriesPayments.ts to the frozen original list. Root notified these intersections require migration; no blind current-only predicate may replace historical accounting-date semantics.

## Direction review repairs and first reader migration

Independent reviewer confirmed two direction gaps at9f2abf8a. Actual target invoice journal swapped debit/credit still admitted; actual independently approved direct customer receipt with swapped cash journal legs also admitted. Initial legacy test failed only overlong payment_number and was corrected before genuine RED. Evidence: cash-reader-green-direction-red.log (target RED), cash-legacy-direction-red.log (legacy RED,1.37s). New shared cashAccountingLegs proof binds current owned AR/AP control account, exact debit/credit direction and total; cash also requires one owned bank account with correct type/subtype and explicit bank identity when present. Current account/line facts join the approval fingerprint; protected original bank evidence remains mandatory for bank-origin cash.

Actual payment lock initially returned115 for reversed115 history (cash-reader-red.log). Actual AR unapplied report returned0 before application and after inverse (cash-reader-date-red.log), while active-date0 was correct. Current customer/supplier lock sums now exclude reversed markers. Owned customer/supplier unapplied reports and customer origin aggregation use immutable application/inverse accounting dates. Four actual customer reader cases GREEN. Supplier and origin aggregate parallel source edits have sourceTS/lint verification only; actual AP/origin report cases remain required. Other reader inventory remains open.

Eleven realPG GREEN8.63s, eight units, fullsourceTS and scopedlint GREEN: cash-eleven-pg.log and cash-reader-direction-{types,lint,unit}.log. PG poolclosed/session37317 terminal0; lease returned. Raw legacy application adapter bypass remains skipped and unresolved. No public apply/inverse financial capability or full historical reporting completion claimed.


## Root central cash operation dependency

Root isolated cash-dispatch branch at9f2abf8a; db897b3b carries previously reviewed immutable-maker kernel hook from591a0171. Added cash_application.apply and cash_application.reverse canonical intent associations, bank read/write plus posting authority, configured payment policies, actual shared material dispatch and both immutable maker tables.2 genuine unsupported-operation unitRED→2GREEN; sourceTS/scoped source lintGREEN. Actual fresh approved bank receipt + customer invoice: removing new cash maker hook allowed U2 proxy approval request (genuine1RED); restoring hook refused proxy/self approval, permitted U2 independent decision, preserved unpaid invoice (1PGGREEN, pool closed). Durablecash-maker-pg-red.log/cash-maker-pg-green.log. Test added to existingcashApplicationControls.int.test.ts; merge append without losing author reader/correction tests.

This dependency enables actual shared approval binding, not final public cash execution acceptance. Author's pending direction-source review findings, real inverse/public executor, all current/historical readers and legacy adapter bypass remain open. Named independent review requested separately. No main integration or finalCI/transport claim.

## Public executor first actual inverse workflow

Central db897b3b/96ccacfb cherry-picked as eaa7a9bd/60ef5d55; append conflicts retained both author and root tests/ledger. Public executeCashApplication and executeCashApplicationReversal use real approval kernel, current maker identity and shared original-authority replay. Two missing-export execution-boundary RED→four boundary tests GREEN. Actual independently approved existing bank cash application→idempotent retry→independently approved inverse→idempotent retry GREEN3.33s (cash-public-inverse-pg.log). Initial actual inverse encountered overlong savepoint name; corrected and preserved cash-public-inverse-savepoint-red.log. Retained positive115 allocation carries inverse intent; invoice paid restored0; original bank cash journal unchanged. SourceTS/scopedlint GREEN (cash-public-types.log, cash-public-lint.log). PG poolclosed and both leases returned. This is one customer workflow, not supplier/concurrency/rollback/transport/full-reader acceptance. Legacy adapters remain open next.
