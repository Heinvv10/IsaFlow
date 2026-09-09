# Durable MCP invocation foundation

Base: `6e7dd2fa`; root schema dependency `f558d120` (locally cherry-picked as `9befbcb8`). This is the persistence foundation, not registry or transport enforcement. Root owns those ingress changes.

## Public interface

- `beginMcpInvocation({tool,argsHash,idempotencyKeyHash})`: requires active authenticated control request and awaits independent durable admission; returns opaque request-bound handle.
- `completeMcpInvocation(handle,{status,reportedWrite,durationMs,reasonCode?})`: writes a receipt in the actual effect transaction. Status is `ok|rejected|error|replay`. Reason codes are a small exported allowlist; no exception messages or raw arguments.
- `getMcpInvocationStatus(ctx,attemptId)` / `listMcpInvocations(ctx,{afterId?,limit?})`: current `read:audit`, tenant scoped; bounded UUID keyset pages default50/max100. Reads never reconcile.
- `reconcileMcpInvocation(ctx,attemptId)`: explicit current `write:audit` plus read authority; verifies original PostgreSQL transaction status and receipt before appending outcome.
- `closeInvocationPool()`: lifecycle cleanup.

Private persistence captures an immutable original principal in a weakly branded identity object while its request is active. Fixed tagged SQL runs with a separate ALS/client and original person/tenant GUCs. No caller SQL callback, substitute actor, raw token, result body, argument payload, or plaintext idempotency key is accepted.

The private pool bounds max connections to2, acquisition to2s, statement/query timeouts to3s. Its COMMIT must report the actual COMMIT command. Failure destroys that connection and emits a generic store error. Root's transaction observer settles only after actual outer COMMIT/ROLLBACK. A committed receipt must survive on a separate connection: in-memory completion alone cannot certify a receipt discarded by savepoint rollback. Missing receipt, missing finalizer and in-progress/unavailable transaction status remain unknown. Reconciliation proves committed receipt or PostgreSQL aborted transaction; it never guesses rollback from absence.

## Verification

Node22.23.1, isolated worker worktree, shared identical-lock node_modules. No CI/build/deployment/provider calls.

- RED missing module: `/tmp/invocation-unit-red.log`.
- RED independent COMMIT resolving ROLLBACK and connection error disclosure: `/tmp/invocation-persistence-red.log` (2fail/1pass).
- RED missing recovery classifier: `/tmp/invocation-recovery-red.log`.
- Focused unit command: `node node_modules/vitest/vitest.mjs run tests/unit/mcp/invocation*.test.ts`; 17pass (`/tmp/invocation-unit-green.log`).
- Source lint: `node node_modules/eslint/bin/eslint.js src/lib/mcp/invocation*.ts`; pass (`/tmp/invocation-source-lint.log`). Existing ESLint project excludes test files, so a direct test-file lint attempt reported project-service configuration errors; no configuration change.
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit --pretty false`; pass (`/tmp/invocation-ts.log`).
- Real PostgreSQL: `ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1 ISAFLOW_FORENSIC_FIXTURE_URL="$OWNED_FIXTURE_URL" DATABASE_SSL=disable node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/forensic-invocations.int.test.ts`; **11pass**, 4.59s total /3.85s test time (`/tmp/invocation-pg-first.log`). URL is supplied at runtime after explicit fixture validation, never from ambient production configuration. Both pools closed and lease returned after this run.

Schema f558d120 reviewed as a named commit: original-person completion can outlive membership removal, receipt xid is bound to actual outer xid, explicit minimal append-only ACLs, tenant-scoped reads. PostgreSQL `pg_xact_status` app_user availability was independently verified by root; worker also verified committed/aborted/in-progress transaction outcomes through actual app_user queries.

The eleven PostgreSQL cases cover independently visible admission before completion; receipt visibility only after COMMIT; rollback retaining admission/outcome but no receipt; missing-observer recovery for committed and aborted transactions; missing/savepoint-discarded receipts remaining unknown; in-progress reconciliation; distinct retry/replay admissions and foreign-tenant denial; two runtime synthetic PAT grants bound to one person without token plaintext; escaped-handle and append-only DELETE denial; admission table-lock timeout before callback; and captured original-person finalization after membership removal. These prove the store and transaction observer boundary using synthetic request contexts. They do not claim MCP transport/registry ingress is wired or a new financial domain workflow has been exercised here.
