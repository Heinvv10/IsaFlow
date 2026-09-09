# MCP registry invocation enforcement

Every registry call now obtains durable admission before tool resolution or effects. The bounded admission envelope retains hashes, not arguments or raw idempotency keys. Transactional completion records reported status; the existing transaction observer determines committed, rolled-back or unknown outcomes from PostgreSQL evidence.

A write handler returning `isError` previously could commit mutations performed before that refusal. The registry now raises an internal refusal inside its write savepoint, rolls back those changes, refunds metering, and returns the refusal without consuming the successful-result key. Thrown errors and failed completion evidence retain the real transaction failure boundary. Successful retries recheck current authority before replay.

## Evidence

- Initial admission tests failed before wiring; the returned-refusal regression additionally reproduced a posted journal remaining posted when the guard was removed. Guard restored.
- Recovery focused run: 416 unit tests passed, 3 skipped across 13 selected files. Legacy handler suites explicitly isolate admission; dedicated lifecycle tests and PostgreSQL tests exercise it directly. Skips are not acceptance evidence.
- Recovery PostgreSQL run: five real registry/shared-GL cases passed alongside six release-schema cases. Cases cover same-person second-token replay with separate admissions; thrown and returned-refusal rollback; outer rollback retaining truthful reported-write status; revoked current membership preventing replay.
- Source type-check and scoped source ESLint passed after recovery. `git diff --check` passed for this change.
- Durable local logs: sibling `mcp-forensic-artifacts-20260909/recovery-registry-unit.log`, `recovery-release-registry-pg.log`, `recovery-controls-typecheck.log`, `recovery-controls-lint.log`.

These tests use synthetic authenticated transaction contexts and real local PostgreSQL. Actual MCP HTTP, full registered-tool contracts/authorization, full CI and independent named-commit review remain required. No production or provider behavior is certified.
