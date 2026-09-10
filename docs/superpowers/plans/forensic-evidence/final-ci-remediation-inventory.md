# Final CI remediation inventory

Named inventory base: `447f1ecb3` (isolated branch
`feat/mcp-ci-remediation-inventory-20260910`). This is Phase 0 source/log
classification, not a new CI result. No tests, builds, PostgreSQL work or product
edits were performed for this inventory. Root instructions read; no nested test
or docs AGENTS/.claude.md files were found in the scoped paths.

## Evidence and arithmetic

- Original full CI: exact `c4b2c9859`, terminal handle26716, log
  `../mcp-forensic-artifacts-20260909/integrated-forensic-ci-c4b2c9859.log`.
  SHA256 `313dcdcb2e11f2a6443a47532252a4a4e606a7ae0fd998248a40b8da180a0be9`.
- Parsed every `FAIL` heading: **123 failing cases in28 files**. Source type,
  lint/security/docs/migration gates,450 components and build passed. Units:
  10612 passed,233 skipped. DATABASE_URL was unset: no built-in PG dispatch.
- Exactly five failures across `tests/unit/mcp/{tools-read,tools-write,
  listGlAccountsTool}.test.ts` were subsequently corrected, independently
  reviewed and67 focused cases passed (root6604c2ab3/bed33b4b3; see
  `registry-fixture-refresh.md`). Current named source has later161 census
  changes, so this is not a fresh full-suite161 success claim.
- The other25 failing test files are byte-unchanged between c4b2 and447f.
  **118 is the expected unresolved historical count, not a rerun result.**
  Their production dependencies changed meanwhile, so new failures can appear.

## Classification rules

`G` below means the historical failure is demonstrably at an unissued control
context or at an old implementation spy before the economic assertion executes.
That is a **fixture/entry-contract incompatibility**, not proof that the economic
behavior works. Its production outcome remains **unknown until re-exercised**
with a real issued context and current immutable approval/material interfaces.

`M` means an explicit missing mock export; `D` means a demonstrably obsolete
child-dispatch expectation. Neither permits discarding economic assertions.
There is **no newly confirmed production regression from this log alone**.
The five census corrections are the only already-verified removals from123.

## File-level inventory and ownership groups

Paths below are relative to `tests/unit/`; counts are exact c4b2 failures.
All groups start from447f1ecb3 or a root-approved descendant. Workers initially
own only their listed tests plus new focused test helpers and their plan section;
source fixes require a genuine current behavioral RED and root file allocation.

| Group | File | Failures | Classification and assertions to retain |
|---|---|---:|---|
| GL | services/closedFiscalPeriodErrorContract.test.ts |4|G: closed/locked rejection, matchable class/status, valid open posting |
| GL | services/journalEntryReversalDate.test.ts |16|G: default/explicit date, SAST Date shape, target period, no earlier/malformed date, rollback |
| GL | services/journalEntryReversalPeriod.test.ts |1|G: derive target fiscal period; never inherit original period blindly |
| GL | services/journalEntryService.test.ts |5|G: owned draft post, missing/posted/reversed/closed refusal |
| GL | services/postToInactiveAccount.test.ts |6|G: all inactive accounts, company/entry ownership, typed actionable error, valid active posting |
| GL | services/gl/journalEntryReversal.test.ts |7|G: exact dimensions, posted original + reversed_at, second reversal refusal, actor attribution |
| BANK | services/bankAllocationBatchStamp.test.ts |2|G: clear stale allocation_batch_id on allocation and inverse |
| BANK | services/bankAllocationRowLock.test.ts |3|G: allocate/split/inverse owned row locks, concurrent exclusion |
| BANK | services/bankAllocationService.test.ts |4|G: VAT input system/1140 fallback, non-VAT bypass of VAT lookup, missing-account refusal |
| BANK | services/bankAllocationSign.test.ts |14|G: both party directions, gross/no VAT, refunds without fabricated payment/receipt, no refund matching |
| BANK | services/bank/bankAllocationDateShift.test.ts |3|G:00:30 SAST bank date preserved in account/split journal and receipt |
| BANK | services/bank/reverseReconciledAttribution.test.ts |3|G: issued actor provenance and tenant-bound reset |
| BANK | services/bank/supplierBankLineDocument.test.ts |8|G: one real payment/receipt, intended applications/default/opt-out, refunds no child cash |
| BANK | services/ar/receiptMatchConfirmService.test.ts |2|D: full-line journal + exact parent-owned applications; missing child association throws/rolls back |
| AR | mcp/actorPropagation.test.ts |1|G: credit-note document records issued actor/token, not caller-invented identity |
| AR | services/dateSweepP14.test.ts |1|G: invoice's accounting date remains local date |
| AR | services/directPostBypassGuards.test.ts |6|G: parent-controlled posting, no orphan journal, historical exception explicitly authorized |
| AR | services/p21InputValidation.test.ts |3|G: reserved draft-payment balance, linked credit-note exactly-once application |
| AR | services/postCustomerInvoiceToGlCancelledGuard.test.ts |1|G: cancelled invoice cannot repost despite missing journal link |
| AR | services/postingAgentThreading.test.ts |5|G: human/PAT/OAuth journal attribution from issued context through approved invoice parent |
| AP | services/sageCommitApInvoiceGuards.test.ts |4|M: mock lacks approveSupplierInvoice; inactive/date/import authorization behavior still required |
| AP | services/supplierInvoiceCancelReversal.test.ts |10|G: owned row lock, controlled inverse, paid/cancelled refusal, atomic race/rollback, no wrong-tenant post |
| AP | services/supplierPaymentVoid.test.ts |5|G: controlled inverse/unapply/cancel; status/reconciled refusal; atomic failure and prior inverse |
| AP | services/supplierPaymentWorkflowService.test.ts |2|G: owned bank lookup and foreign-bank refusal before effects |
| AP | services/ap/batchPaymentService.test.ts |2|G: batch journal association, no invalid source_document FK, approved atomic batch execution |

Totals: **GL39 + BANK39 + AR17 + AP23 =118**. The single AP draft-balance
case in p21 stays with AR ownership to avoid two agents editing one file.
The six directPost cases include three historical cases; AR owns the file but
coordinates historical-source assertions with AP, without duplicate edits.

## Concrete current interfaces and changed seams

- GL: `journalControlService.runJournalControl` requires `requireControlTx`,
  exact principal/company/person, `executeControlledOperation` and immutable
  material; generated journals require a real `ParentJournalControl` permit.
  `JournalControlOptions` supports approvalId/parentControl. Never fabricate
  parent permits or mock `requireControlTx` into granting authority.
- `journalEntryPostingService.reverseJournalEntry` now copies contra lines in
  SQL with cost_center/cc1/cc2/bu and preserves original posted status while
  stamping reversed_at. Old tests spying on `createJournalEntry` cannot observe
  that effect. `journalReversalDate.resolveReversalDate` still implements
  original-open-date/default-today and strict explicit target-date validation.
  Test that real helper for pure date decisions; prove persisted inverse and
  rollback independently rather than expecting a draft DELETE call.
- Bank adapters require issued authority before locks; immutable plan preparation
  precedes controlled execution. Existing options include intentId/approvalId,
  applications and autoApply. Default applications are chosen at preparation,
  not execution. Current `bankAllocationEffect` and inverse both explicitly clear
  allocation_batch_id: source support exists, but the two old cases still fail
  before reaching it. VAT preparation, default allocation, refunds and transfer
  have real shared implementations; their presence is not substitute test proof.
- `bankAllocationActor` derives human/agent/system and token from issued principal;
  arbitrary legacy postingAgent/actorTokenJti assertions are not authoritative.
  Preserve truthful issued actor attribution, not caller-spoofed metadata.
- `receiptMatchConfirmService.confirmReceiptMatch` passes exact applications into
  the approved bank parent and then reads its journal-bound customer payment.
  It deliberately no longer calls old `applyReceiptPlan` after posting. Its
  specific missing-child message changed to `Controlled bank receipt association
  unavailable`; throwing/atomicity and exact amounts remain mandatory.
- Sage commit now delegates to `approveSupplierInvoice`; the old mock omits this
  export. Old expectations to keep a direct post and unconditional closed-period
  bypass conflict with explicit persisted historical-import authorization.
  Replace that bypass expectation with authorized historical execution plus
  missing authorization/locked period/inactive account refusal scenarios.
- Current 25 files still use historical SQL/CRUD mocks; no blanket assertion
  that all118 are obsolete is justified. Payment void and generated journals
  now need original controlled effect/history provenance, not a posted-row seed
  silently treated as legitimate controlled history.

## Recommended first assignment: GL39

This is tied-largest and independent of bank/AR/AP test files. Use one worker
on the six GL files, exact447f base, while a second owns BANK39 and a third AP23.
Root can own AR17 plus shared integration/contract decisions. Do not start
parallel heavy processes: source inspection and tests authored in parallel,
focused unit/PG/static runs serialized by explicit root leases.

1. Reproduce the six-file group on the assigned exact base before edits. Save
   named cases/error output; report any changed count instead of assuming39.
2. Add a traceability table mapping every old economic assertion to its new unit
   or actual PG assertion before changing tests. Keep pure date/error contracts
   as units using real helpers. Preserve direct unissued calls as negative
   authority regressions, and exercise positive writers through real issuance.
3. Reuse `tests/integration/controls/glSharedWriters.int.test.ts` and
   `journalVatLocks.int.test.ts` fixtures/interfaces. Add actual GL regressions
   for all uncovered persisted date/period/dimension/status/typed error cases;
   do not seed fictitious effect/audit receipts. A new dedicated fixture helper
   may own only synthetic source setup and real approval/context calls.
4. Any economic failure under valid current authority is a new product candidate:
   reproduce with real PostgreSQL, request root ownership of the exact source
   helper, implement the real shared fix, and independently review named commit.
5. Never fix CI by asserting only `Authenticated control transaction required`
   where the old test verified a financial effect. Moving an effect assertion
   to real PG requires retained mapping and passing actual PG proof before its
   obsolete unit-spy equivalent is removed. No skips, blanket catch/resolves,
   weakened amounts, or manufactured approval/hash/receipt rows.

## Acceptance for subsequent groups

BANK: reuse bankAllocationControls, bankRefundControls, bankDefaultAllocation,
bankVatFallback, bankAllocationDimensions actual PG suites. Add missing batch
stamp/row-lock/SAST/attribution and receipt-parent regressions. Verify no extra
payment/receipt for refunds, exact gross direction/no VAT, positive normal
child cash, chosen applications frozen before approval, inverse of prior
reallocation, stale approval, tenant and rollback. Do not restore execution-time
auto-selection to satisfy an old strategy spy. Named-source review before merge.

AR: reuse arSharedWriters/arMaterial/cashApplicationControls and historicalImport
execution fixtures. Exercise draft reservation, linked-note application once,
invoice date and cancellation guard, approved parent-generated journal, actual
human/PAT/OAuth attribution. Keep a negative unissued call separately. Historical
posting is allowed only under the real saved import authority; no boolean waiver.

AP: reuse apSharedWriters/cashApplicationAdversarial and actual historical Sage
source/execution fixtures. Preserve invoice paid/status guards, bank ownership,
void/inverse accounting and immutable history, batch FK and parent journal links.
A pre-reversed header without valid controlled history is an explicit legacy
provenance scenario, not a mocked successful inverse. Approval/current authority
and all writes must roll back together on failure.

For every group: focused unit + relevant real PG + source/test TS + scoped lint,
independent named review, correction verification, then root integration. Only
then rerun complete integrated `bun run ci`; build/type/lint/component success at
old c4b2 is not final CI. New161 registry HTTP contracts and full synthetic
financial workflows remain distinct outstanding programme acceptance checks.

## GL implementation checkpoint

Branch feat/mcp-ci-gl39-20260910, base447f + plan7239. Focused six-file baseline
at03:53 reproduced exactly39 failures/36 passes; log
`/tmp/isaflow-gl39-baseline-447.log`. New gl39Fixture/gl39Posting/gl39Reversal
actual PG tests are authored before any old assertion removal. No production
edits. Fixture uses real withControlRequest, current rights, source material,
approval request/independent decision and actual GL effects. A transaction-local
synthetic contra-post trigger will test rollback (DDL itself rolls back).
