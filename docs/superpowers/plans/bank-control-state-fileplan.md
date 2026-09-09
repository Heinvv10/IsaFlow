# Bank control state reader

Base: 4156b37b7. Owner: snapshot_capture. Root approved response and ownership contract.

## Gap and files

The bank UI cannot recover its prepared immutable instructions or identify the active controlled original after reload. The action route only prepares and executes explicitly addressed operations.

- New bank/bankControlReadService.ts: current read:bank-tx; own bank, exact current receipt provenance, current-person prepared operation union filtered before bounded limit; strict selected intent lookup. Optional small query/provenance helpers remain in this bounded reader scope.
- New pages/api/accounting/bank-control-state.ts: authenticated GET, strict query validation, shared reader and API response helpers.
- New tests/integration/controls/bankControlRead.int.test.ts and bankControlReadFixture.ts: real PostgreSQL and local HTTP using real cookie authentication and existing shared preparation/execution.

## Frozen response

bankTransactionId, currentOriginalIntentId|null, legacyProvenanceUnavailable; prepared {items,total,hasMore}; selected|null. Operations expose exact allowlisted saved plan, intentId, operation reference, createdAt, accountingDate, amount/currency, executed, latest linked approval summary|null and approvalVisibility (visible/denied). Approval summary requires current read:approvals; own saved plan requires read:bank-tx. No binding, fingerprints, credentials or live invoice/beneficiary information.

## Failing scenarios before implementation

1. Actual authenticated GET missing endpoint/module; classify initial import refusal as missing-capability RED, not database behavior.
2. Prepared and approved operations survive refresh; selected details outside newest50 recover; other maker and bank filtered before count/limit.
3. Allocate, inverse, refund and reallocate select only matched current journal's exact original; imported/reversed has none. Conflicting controlled provenance refuses; genuinely legacy match reports unavailable.
4. Wrong tenant/bank/person and revoked current bank read refuse; removed approval read hides summary explicitly.
5. Persisted plan material is sanitized and exact, without raw source fingerprints/binding. State reads leave financial rows unchanged.

## Verification

Tests-first commit 3fb31d7ee. Initial missing-route import RED 0bcaab executed no database cases.

Implemented new shared read service plus query/provenance helpers and authenticated GET. Bank SHARE lock stabilizes lifecycle during the read. Current original requires matching owned unreversed posted journal, matched bank GL line, parent effect and audit identity, saved-plan economic line shape, bank amount/date and source association. Implicit old control-account IDs resolve only from owned journal roles; no live invoice/customer/beneficiary load. Missing bank parent effect with linked generated-journal/parent audit history refuses; a separately controlled manual journal is not automatically bank-allocation provenance.

Actual HTTP/PG run 66723 had six successes and one legacy-fixture created_by NOT NULL failure; corrected fixture produced all seven successes (68638). Added pending approval via actual cookie+CSRF control-approvals HTTP and rollback-only missing-effect regression. Run 65455 proved the missing-effect defect (resolved as legacy instead of refusal); separate pending fixture403 was a malformed synthetic CSRF token, corrected to real32-byte generated format. Fix links journal.post to same-operation bank allocation parent or bank child history.

Final 6048 terminal0: eight actual PostgreSQL scenarios, 88 local HTTP completed requests, 4.50s. Includes pending→approved, selected executed detail, inverse and reallocation, customer refund without child payment, own52 before limit50, other-maker filtering, detail beyond page, wrong bank/person/tenant, revoked bank rights, approval visibility denial, genuine legacy evidence unknown, controlled mismatch refusal, and missing-effect refusal with restoration proven after transaction rollback. Only private transaction-local replica mode was used for one own synthetic receipt deletion; no global triggers or schema changes. All fixture servers and pools closed.

Source TypeScript and four-source scoped ESLint 22961 passed before final provenance correction; final source TypeScript, scoped ESLint and diff-check 7718 terminal0 also pass. Named independent review pending. Approval status is current stored status, not a promise that stale material or revoked authority will pass execution rechecks. No production verification, built Next browser proof or full UI claim. Root owns integration and subsequent UI/MCP exposure.
