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

Pending initial RED, implementation, focused real PostgreSQL/HTTP, source TypeScript/lint, named independent review. No production verification or full UI claim.
