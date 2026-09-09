# Bank settlement metadata correction

Base: `5972786f8`. Owner: invoice_evidence. Isolated branch: feat/mcp-bank-settlement-metadata-20260909.

## Contract and owned files
- `bankAllocationChildEffect.ts`: relative invoice application must derive settlement metadata using the existing shared `recomputeInvoiceStatus` rule before recording protected after-state.
- `bankAllocationReversalEffect.ts`: inverse must clear metadata for reopened balances, retain allocation history, preserve atomicity and approvals.
- New `bankSettlementMetadata.int.test.ts`: real approved AR/AP postings, full/partial settlement, retry timestamps, inverse clearing, rollback and retained history.
- Existing `ar/invoiceStatusRecompute.ts` defines paid_at as balance settlement time, preserving an existing date; AP matched flag/date uses the same threshold. No new date semantics or operations.

## Tests first
Six actual PostgreSQL scenarios authored before source changes. Four expected RED: full settlement dates missing and inverse dates/flags stale for AR/AP. Partial and rollback controls must continue passing. No principal/helper mocks; existing PDF snapshot side effect suppressed as in canonical bank lifecycle fixture.

## Pending
Run RED; implement; run focused and existing bank PG; source typecheck/lint; independent named-commit review. No production verification.
