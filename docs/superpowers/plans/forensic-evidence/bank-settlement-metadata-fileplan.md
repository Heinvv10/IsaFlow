# Bank settlement metadata correction

Base: `5972786f8`. Owner: invoice_evidence. Isolated branch: feat/mcp-bank-settlement-metadata-20260909.

## Contract and owned files
- `bankAllocationChildEffect.ts`: relative invoice application must derive settlement metadata using the existing shared `recomputeInvoiceStatus` rule before recording protected after-state.
- `bankAllocationReversalEffect.ts`: inverse must clear metadata for reopened balances, retain allocation history, preserve atomicity and approvals.
- New `bankSettlementMetadata.int.test.ts`: real approved AR/AP postings, full/partial settlement, retry timestamps, inverse clearing, rollback and retained history.
- Existing `ar/invoiceStatusRecompute.ts` defines paid_at as balance settlement time, preserving an existing date; AP matched flag/date uses the same threshold. No new date semantics or operations.

## Tests first
Six actual PostgreSQL scenarios authored before source changes. Four expected RED: full settlement dates missing and inverse dates/flags stale for AR/AP. Partial and rollback controls must continue passing. No principal/helper mocks; existing PDF snapshot side effect suppressed as in canonical bank lifecycle fixture.

## Verification and decisions
- Tests-first `697d07afc`: actual PostgreSQL handle3403 terminal1, four intended RED failures (AR/AP missing paid_at after full application; AR/AP stale metadata after inverse), two partial/rollback controls passing. Log: `bank-settlement-metadata-red.log` in programme artifacts.
- Correction uses unchanged shared `recomputeInvoiceStatus` after a relative SQL balance change. Its existing one-cent settlement threshold and preservation of unpaid sent/overdue states replace the duplicate bank CASE. `paid_at` remains transaction-time settlement metadata; approved accounting dates remain in payment/journal/history provenance, unchanged.
- `bankAllocationChildEffect.ts` is the actual application mutation location, explicitly approved by root as ownership adjustment. `bankAllocationEffect.ts` needed no edit. Both effects re-read the settled owned invoice before protected history recording; no helper mutation or allocation deletion.
- Combined new six plus existing thirteen bank lifecycle PostgreSQL tests: handle45408 terminal0, 19/19 pass, `bank-settlement-metadata-green.log`.
- Added decrypted protected before/after assertions and reran six metadata tests: handle37538 terminal0, 6/6 pass, `bank-settlement-metadata-audit-green.log`. Both pool and actual synthetic captured-evidence HTTP server closed. DB lease released to root.
- Source typecheck (`bunx tsc --noEmit`) and scoped ESLint on both source files handle48544 terminal0; logs `bank-settlement-metadata-ts.log` and `bank-settlement-metadata-lint.log`. Heavy lease released. Independent named-commit review pending. No production verification.

## Separate reachability finding (read-only)
At exact `5972786f8`, registered `void_receipt` / `void_payment` in `src/lib/mcp/toolIndex.ts` call `writeVoidPayments.ts` -> `core/paymentVoidService.ts:163` -> legacy `bankAllocationUnwind.ts` for non-bank-backed shapes. The payment loader checks ALS and owned payment row locks, not an issued ControlTx/approved immutable inverse. Journal-backed shapes subsequently encounter the controlled journal reverse boundary; journal-less shapes do not. Exported legacy unwind helpers themselves mutate balances, recompute status and DELETE original allocations without parent permits. This is confirmed source reachability, not yet an actual exploit reproduction. Root owns the separate correction; nothing outside this slice was edited.

