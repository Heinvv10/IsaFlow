# Cash historical reader correction

Base: exact6be6e286f. Owner ar_recovery, isolated feat/mcp-forensic-cash-history-20260909. Scope local synthetic readers/tests only; no source repair, migration, control contracts, registry or production activity. Root owns resource leases and integration. Prior cash authorship means this is author follow-up, never independent certification.

## Confirmed source observations and evidence contract

Current unapplied AR queries select every non-cancelled payment, including drafts; AP queries select current processed/reconciled status. Both therefore erase earlier historical cash after a later parent cancellation. Controlled application intervals already use immutable application accounting_date and inverse reversal_date. Watermarks currently inspect only payment/allocation created_at; retained inverse changes neither timestamp.

Direct customer_payment.cancel and supplier_payment.void kernel effects retain operation_id and a matching control_change_events accounting_date/binding_hash. The original payment retains gl_journal_entry_id; actual posted contra journal retains reversal_of and entry_date. Bank-origin cancellation is a bank_allocation.reverse parent effect plus a child bank_allocation.payment_cancelled event bound to the same operation_id. Do not invent standalone bank-child cancellation or reinterpret reversed_at wall-clock time as accounting date. Scope lifecycle evidence by company, original payment/journal identity, actual effect/operation and exact event. Ambiguous or missing legacy evidence is unknown.

## File-level slices

1. New tests/integration/controls/cashHistoryReaders.int.test.ts plus own fixture helper as needed: reuse real synthetic cash fixture and approved shared workflows. First prove currently dated AR and AP cash disappear from an earlier cutoff after actual legal parent cancellation/void. Use direct cash process/cancel where supported; bank children require their approved bank-parent inverse. Separate setup errors from acceptance RED.
2. Actual retained inverse watermark RED: capture report postedThrough after approved apply, perform approved unapplication in a later transaction, require strictly later watermark from real persisted inverse/event times. No arbitrary wall-clock date substitution.
3. ar/unappliedReceiptService.ts, ap/unappliedPaymentService.ts: derive eligible cash population at requested cutoff from posted original journal and retained dated lifecycle; exclude drafts; preserve application/reversal interval and current balance. Page, orphan population and aggregate queries must use the same eligibility. Include all consumed original/contra/application/inverse/event timestamps in watermark.
4. ar/unappliedReceiptOrigin.ts: reuse the same historical cash population and retained intervals so origin totals equal listing universe; preserve tenant-owned journal join and unknown attribution categories.
5. Missing legacy evidence: propose additive historyCoverage metadata with status complete/partial, unresolved payment/allocation counts and reason codes. Do not silently date untracked late allocations at payment_date. Exclude unresolved historical balances from asserted totals and clearly disclose incomplete coverage. Existing numeric/date fields and cursor remain compatible. Root must expose coverage in transport envelopes; no registry edits by this worker.
6. Run focused current/as-of tests plus existing cash application suite, prove tenant isolation and aggregate/page consistency, sourceTS/scopedlint under leases; obtain independent named review and fix confirmed findings before root integration. No finalCI or production proof claimed by worker.

## Proposed helper ownership needed

The three existing readers repeat page/orphan/totals SQL and already approach300 lines. Prefer one narrowly owned read-only shared/unappliedCashHistory.ts query/model helper (split if needed), keeping SQL tagged and company-scoped, rather than migration/view changes or copied complex lifecycle expressions. This helper is implementation detail, not a central operation contract. Exact result metadata proposal above needs root interface coordination before implementation; tests/plan proceed independently.

## Additional bounded regression coverage

Reproduce removed reconciled supplier-payment refusal and foreign-bank account refusal using real issued context/approved operation when feasible in owned test fixtures. Generic unissued-context refusal tests do not prove these domain requirements. Do not fake a successful bank-child void for test convenience.

Status: source audit/fileplan only; DB/TS not run, all scenarios pending actual RED. Root74249 had sourceTS; export queued DB. Next: agree additive coverage/helper ownership, write source-backed lifecycle fixtures, request bounded DB lease.
