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

## Checkpoint 2026-09-09: actual historical workflow RED to GREEN

Root approved additive historyCoverage and shared helper ownership. Actual source column correction: the contra link is reversal_of_id (earlier prose abbreviated it incorrectly).

- Session62155 terminal1: all three genuine actual workflow REDs. AR approved direct confirm/apply/unapply/cancel erased prior115 balance; approved inverse failed to advance postedThrough; AP actual bank-parent inverse erased historical115 balance. Durable cash-history-initial-red.log in sibling forensic artifacts.
- Added three pure seeded scenarios; missing new helper produced collection RED (not a behavioral financial proof), then all3 GREEN in cash-history-pure-green.log.
- Shared query observes payment, owned journal, retained allocations, matching cancellation effect/event and posted contras in one SQL statement. Analyzer reports unknown legacy dates as partial coverage and omits unresolved amounts from asserted totals. Full bounded population feeds pagination, orphans, totals and origin; no page-derived total.
- First corrected PG42207 failed on incorrect new query column reversal_of; corrected to actual reversal_of_id. This is an implementation error, not additional bypass evidence.
- Corrected PG47901 terminal0: all3 actual workflow cases GREEN, pools closed; cash-history-second-green-attempt.log. DB returned to root. SourceTS46766 running at this checkpoint.
- Still pending: existing full cash/current/asOf regressions, additional tenant/missing-evidence/origin tests, removed AP domain-refusal coverage, sourceTS/lint and independent named review. Root transport must expose partial historyCoverage before report completeness can be certified. No root integration, finalCI, HTTP/UI workflow or production verification claimed.

## Verified reader checkpoint

- Root granted two existing reader unit suites. Initial run12failed/8passed exposed obsolete four-query mocks, aggregated-origin mock rows and assertions requiring current-status cancellation filtering. Replaced with complete source-shaped fixtures preserving totals, cursor, orphan, attribution, tenant bindings, draft exclusion and actual dated lifecycle requirements.14focusedunits GREEN. Separate pure RED/GREEN corrected unposted approved AP classification and null posting-agent classification (owned posted journal without stamp is not evidence of no journal).
- PG9476 terminal0:38actual tests GREEN across cashHistoryReaders(5), cashApplicationControls and cashApplicationAdversarial. Duration9.84s. New cases cover real approved AR confirm/apply/unapply/cancel cutoffs; legal AP bank-parent inverse; retained inverse watermark; missing legacy allocation date reported partial with origin/listing parity; full totals beyond a page and actual foreign tenant RLS isolation. Existing current/asOf, rollback, concurrency, replay and source-binding cases stay green. Pools closed and DB lease returned.
- SourceTS46766 terminal0 before final fixture/classification adjustment; final refresh3836 running. Source ESLint21166 terminal0 for all five changed production files. Initial combined tests lint60840 failed because these test files are excluded by the repository typed ESLint project; this was not a source lint failure. Unit and actualPG files execute successfully.
- Files stay below300lines. No migrations, shared operation contracts, registry, central material or source financial writer changes. Unknown legacy application dates are intentionally excluded, not guessed from payment date; immutable initial bank allocations without separate dated application evidence remain partial in this version. Missing original posted journal similarly remains partial. Metadata makes asserted totals incomplete explicitly; root transport mapping remains necessary.
- Remaining domain regression gap: dedicated reconciled supplier void and foreign-bank refusal tests removed by earlier unit adaptation still need actual positive-source setup. These38tests do not claim those two cases. Author cash history checkpoint requires independent named review before integration. No HTTP/UI verification, finalCI, draftPR or production verification claimed.

Final sourceTS3836 terminal0; source TS lease returned. All verification processes and fixture pools closed before commit.14focusedunits,38actualPG and five-file source lint GREEN; independent named review next.
