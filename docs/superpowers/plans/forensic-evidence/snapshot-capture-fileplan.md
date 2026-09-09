# Snapshot capture implementation plan

Owner snapshot_capture; exact base 76757e6eb. Root owns runner, authority, storage, evidence retention, seal and migrations.

Capture returns AuditSnapshotData inside a real authenticated REPEATABLE READ transaction. It validates and detaches request descriptors before await, checks each requested source permission, reads actual DB capture time, then traverses explicit owned source relations by UUID keyset in pages of 1000. Total retained records cannot exceed 100000 or 100MiB and elapsed work cannot exceed 60 seconds. Counts are actual complete captured populations, never a first-page estimate. Accounting cutoff limits headers and their owned children, with later accounting periods explicitly excluded. Current values at capture are preserved; this does not reconstruct the historical database state at cutoff.

Owned files: auditSnapshotCapture.ts orchestrates; auditSnapshotCaptureQueries.ts enumerates sources and journal/bank queries; auditSnapshotInvoiceQueries.ts contains AR/AP parents and children; auditSnapshotPayrollQueries.ts contains payroll header/line projections; auditSnapshotCheckCapture.ts captures all actual detector pages and validates stable summary/source versions. New unit and PostgreSQL fixture files only. No migration or existing detector edits without root coordination.

Sensitive boundary: no arbitrary to_jsonb(row), names, tax identifiers, bank details, descriptions, freeform notes, or payroll component JSON. Payroll output contains opaque owned employee IDs and monetary calculation columns only and requires read:payroll. Foreign parent references must be masked or excluded with explicit missing coverage. Source version numbers come from control_entity_versions where recorded, otherwise null and declared historical version gap. Fingerprints of retained material remain reproducible through the root seal. Evidence bytes require a separate root-owned authorized retention pass before publication; an empty evidence list must declare retained_evidence_not_attached and cannot mean verified.

Tests first: missing public capture capability; READ COMMITTED rejected; owned two-tenant fixtures; 501 headers and 1002 lines crosses a page boundary with exact totals; an actual concurrent update between header and line scans cannot mix versions; later backdated header/line insert changes new capture and leaves old sealed bytes unchanged; invalid/accessor input rejected without effects; current permission revocation refuses; all requested source families on real schema; requested checks contain every page with exact finding count and source versions; global resource overflow refuses a partial snapshot. Test commands use vitest.integration.config.ts against only root synthetic fixture.env under a root DB lease. Focused units can run independently. Independent named review required before integration.

Known dependencies: reviewed payroll checker not present at this base; root supplies it. Existing synchronous detectors explicitly report async_scan_required above their own 10000-row bound; snapshot must preserve unknown and cannot call that complete forensic checking. Follow-up requires shared detector full-population support, not a duplicate private accounting algorithm. Payment detector's protected beneficiary branch requires write:bank-tx; readonly jobs preserve beneficiary_comparison_authority unknown without broadening authority.

## Implementation checkpoint

Own branch feat/mcp-forensic-snapshot-capture-20260909; plan/tests4b3a32b5d. Reviewed payroll dependencies f61cbe524/c6942fb15/3af294653/d2233595b cherry-picked as cc3561565/930f7cf34/9072ed41b/824d6a5c4. Root already integrated those; do not cherry them twice.

Actual source projections now cover15 populations: journal_entry/journal_line; customer_invoice/customer_invoice_line/customer_payment/customer_payment_allocation; supplier_invoice/supplier_invoice_line/supplier_payment/supplier_payment_allocation; bank_transaction/bank_statement_import/bank_statement_attestation_intent; payroll_run/payroll_run_line. AP allocation truth is payment_allocations, not the abandoned supplier_payment_allocations table. Child tables without company_id use explicit owned parent joins. Foreign period/account/party/document references are masked and reported. Prepared statement facts retain execution_effect_id separately; an intent is not an independently completed review.

Counts and date exclusions are complete; source monetary sums are separated by currency using coverage entries population_total:source:field:currency:exactsum. Unrecorded payment currency is UNSPECIFIED and missing, never silently labelled ZAR. Historical allocation sums include retained reversals and are explicitly not current balances. All actual requested detector pages are retained and stable source summaries checked; individual detector source limits above10000 remain explicit unknown and require later shared full-population detector expansion.

Every query group receives remaining transaction-local statement_timeout capped by the caller's stricter timeout, restored on success. Caller must roll back on failure; root runner also owns overall in-flight cancellation. Source records are cumulatively bounded100MiB and global100000; final canonical snapshot including checks also bounded100MiB. Payroll component material is temporarily read only below64KiB/row and discarded after an app-side domain-separated HMAC under the independent snapshot key; raw names/bank/tax/component payloads are not retained.

Evidence bytes remain root attachment work. The returned missingSources includes retained_evidence_not_attached. Root must traverse both captured and procurement evidence stores by retained parent identity, including documents for passing checks, before sealing/publishing. No production behavior claimed.

## Commands and findings

- snapshot-capture-pg-red.log: missing actual module, collection failure; no assertion execution, not a financial breach reproduction.
- snapshot-capture-first-pg.log: two fixture parameter type errors; corrected, snapshot-capture-second-pg.log3PG GREEN.
- snapshot-capture-expanded-red.log: genuine dual-membership foreign period ID exposure; owned period/reversal joins fixed; expanded-green7PG GREEN.
- snapshot-deadline-red.log/green.log: async deadline guard previously not awaited; corrected before query groups.
- snapshot-capture-populations-pg.log:8/10 assertions passed; bank fixture lacked required source_document_id and oversized fixture DELETE caused timeout. Own synthetic cleanup PID3915 cancelled after exact identity verification; only100001 draftmanual rows in own company72864fdd-8261-4b89-83bf-d9bdcdc64d0a with exact creation time2026-09-09T15:51:32.294911Z deleted using transaction-local trigger suppression. No source children existed. PID disappeared. Oversized test now inserts in a transaction and rolls back, verifying no retained rows.
- snapshot-capture-material-red.log:10/13PG GREEN plus three genuine missing/correctness cases (currency grouping, attestation source missing, bigint version serialization). Fixed; material-green13PG GREEN in3.57s.
- snapshot-capture-sensitive-red.log: missing payroll component fingerprint and test expecting a different accessor error message. Added protected fingerprint; unsupported accessor rejected with zero getter calls. sensitive-green16PG GREEN.
- snapshot-capture-final-pg.log:16PG GREEN (74356 terminal0, pools closed), includes actual sealed comparison for backdated additions and concurrent header/line changes;501headers/1002lines;100001-row refusal with rollback;101actual findings across pages; populated15family paths, exact totals, tenant and revoked permission checks.
- snapshot-capture-final-units.log:18units GREEN across capture, check collector, seal and comparison. Scoped lint68926 GREEN. Source type-check90527 GREEN before last component changes; final type-check still required.
- Final source review found two additional test scenarios pending: match shared payroll COALESCE(run_date,period_end) cutoff; nonempty AP detector's PostgreSQL observation timestamp must be seal-compatible. These remain unverified until recorded RED/fix/GREEN below.

Independent named review remains required before root integration. Snapshot storage, retained evidence, cold worker bootstrap, HTTP adapters and full programme acceptance remain root/dependent work.

## Verified capture handoff

Final boundary tests both failed for the intended reasons in snapshot-capture-boundary-red.log: an explicit payroll run_date at/before cutoff was wrongly omitted; a nonempty invoice detector's pg timestamp text was rejected by the canonical seal datetime schema. Capture now matches the reviewed payroll COALESCE(run_date,period_end) source cutoff, and normalizes retained check observation timestamps to ISO. No separate payroll accounting rule was introduced.

- snapshot-capture-verified-pg.log:18 real PostgreSQL tests GREEN,67906 terminal0,6.80s,poolsclosed.
- snapshot-capture-verified-units.log:18 focused units GREEN across capture/check collector/seal/comparison.
- snapshot-capture-verified-ts.log:full source type-check98320 terminal0.
- snapshot-capture-verified-lint.log:five new source files scoped lint95131 terminal0.
- git diff --check GREEN; no migration, registry, root context/lease or seal edits.

This is actual bounded source/check capture ready for independent named review. Full asynchronous detector expansion beyond existing10000-source limits, retained evidence attachment across both stores, root job execution/publication, transport acceptance and final integrated CI remain required programme work; these checks do not claim those capabilities or production verification.

## Independent review corrections to25936b479

Root review confirmed two retention gaps. First, changing an owned gl_accounts classification/code under the same account ID left journal/invoice source records identical when no checks were requested. Second, allocation records retained immutable intent IDs and actual reversed_at time but omitted application and reversal accounting dates, preventing reconstruction of the application state at a reporting cutoff.

Three real PostgreSQL regressions failed as intended in snapshot-capture-review-red.log (68359 terminal1): sealed before/after comparison had no changes for a real account reclassification; each of AR and AP omitted the required accounting dates. The corrections retain owned account code/type/subtype/normal-balance/active/VAT classification fields wherever an account is projected, and obtain application_accounting_date/reversal_accounting_date through tenant/payment/kind/original-intent-bound joins. No account names, freeform descriptions or bank credentials are added. Legacy missing application accounting dates remain explicit unknown; actual event time is not substituted for an accounting date. Existing640 triggers already enforce controlled intent ownership; no foreign-intent disclosure claim is made.

The source-family contract remains15 populations and the root capture/retention interfaces are unchanged. Tests use a payment date2026-08-31, application accounting date2026-09-01, actual reversal timestamp2026-09-09 and reversal accounting date2026-09-15, proving the dates remain distinct at the9September cutoff. The classification comparison retains the original seal unchanged and identifies journal, customer invoice and supplier invoice lines despite identical account IDs.

- snapshot-capture-review-green.log:full21 real PostgreSQL tests GREEN,29106 terminal0,3.12s,poolsclosed.
- snapshot-capture-review-units.log:18 focused units GREEN.
- Final correction source type-check and lint recorded below before commit; root must independently review the named correction before integration.
- snapshot-capture-review-ts.log:source type-check94492 terminal0.
- snapshot-capture-review-lint.log:both changed source files scoped lint77832 terminal0.
- git diff --check GREEN. All worker DB/TS processes terminal; no production changes.
