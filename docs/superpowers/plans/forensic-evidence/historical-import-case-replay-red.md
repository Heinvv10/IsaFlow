# Historical import UUID case regression

Base: `fad0f57f7`. Owner: `large_scan_design`. Isolated branch: `feat/historical-import-case-red-20260910`.

Source audit identifies a possible duplicate GL-only historical posting through uppercase UUID identity in an open fiscal period. UUID-backed intent/journal associations resolve both spellings, while control effect/version IDs and journal entry numbers retain raw case. Closed-period uppercase posting has a separate incidental refusal and invoice posting has document identity protection; the regression deliberately exercises neither.

Owned tests:
- `tests/unit/services/controls/operationReferenceCase.test.ts`: all 23 UUID operation entity families normalize; year/VAT date identities remain unchanged.
- `tests/integration/controls/historicalImportCaseReplay.int.test.ts`: real independently approved GL import in an open period, lower then uppercase identity, exact journal/effect census and monetary totals; uppercase receipt retry.

2026-09-10 focused unit command: `bunx vitest run tests/unit/services/controls/operationReferenceCase.test.ts` under Node 22.23.1. Exit 1, **23 genuine identity-normalization failures / 1 pass**, 1.20 seconds. Durable log: `.worktrees/mcp-forensic-artifacts-20260909/historical-case-unit-red.log`.

PostgreSQL reproduction awaits orchestrator heavy-test lease. No financial duplication claimed as DB-proven yet. No implementation changes in this branch. Root owns canonical reference, permit and historical execution normalization.
