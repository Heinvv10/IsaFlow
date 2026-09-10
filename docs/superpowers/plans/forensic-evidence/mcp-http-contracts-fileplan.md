# Actual MCP HTTP contract expansion

Base: c4b2c9859. Owner: snapshot_capture. Isolated branch feat/mcp-http-contracts-20260910. Root owns registry and integration.

## Files and acceptance

- contractSamples.ts: required-only samples, explicit strict semantic gate samples and fail-closed patterns. Validate all 148 samples with actual production validator before database setup.
- contractCases.ts: deterministic invalid-field cases respecting compatibility coercions; stable IDs and explicit expected public refusals.
- fixtures.ts: manifest equality, 148 field matrices, 145 static-scope refusals, 32 supplemental post-scope refusals, 145 current-permission revocations, three dynamic/identity cases. Broad PAT scope remains unchanged during current-authority tests.
- client.ts: explicit expected HTTP/RPC errors, bounded bodies, loopback-only and paced requests.
- contracts.int.test.ts and acceptance CLI: bounded shards, exact executed/pending coverage; read defaults tested separately from refusal gates.

## Failing scenarios first

1. Existing all-properties sample fills optional numeric cursor with UUID and decimal strings with UUID; required beneficiary bank digit pattern also fails.
2. Missing required/wrong type/enum/date/UUID/bounds and nested unknown fields must produce precise validation refusal before any financial handler.
3. Broad token plus revoked current module permission must refuse; absent static scope and absent supplemental post scope are separate tests.
4. Identity-only tools and dynamic approval requirements require explicit owned identity/source cases; no skipped gate may become a success claim.
5. Sharded output must show unexecuted cases and cannot advertise complete aggregate coverage.

## Resource and evidence boundary

No PG, build or heavy TS without root lease. Reuse built c4b2 artifact in mcp-forensic-ci-20260910. Synthetic fixture only; never seed financial effects as successful workflow proof. Root will remove bankPrepared test-local registration fallback. Financial valid execution, final integrated CI and production verification remain separate.

## Checkpoints

- c06832584: genuine old sampler RED, four production-validator refusals: optional export/snapshot numeric cursor, optional bank amount, required beneficiary account digits. Pure test only; no database connection.
- Required-only sampler now validates all148. Deterministic mutation implementation first failed for missing module, then one expected-message correction for write idempotency gate; five light tests now pass. Matrix:1612 field refusals,145 scope,32 post,145 current-rights =1934 actual HTTP cases planned.209 documented compatibility mutations are retained as separate pure cases and never sent to successful financial handlers.
- Shards capped600; CLI checkpoints each completed call atomically with selected/executed/remaining IDs and plan hash. A shard is not complete programme coverage.
- Actual HTTP/PG and dedicated/source TS still pending root resource lease. No runtime acceptance claim yet.

Supplemental read contract source verification: c4b2 reports.ts:114–191 declares list_gl_accounts default200/max500, active_only defaulttrue and keyset cursor/total; company.ts list_companies returns exactly the one token-bound company even with a second current membership. New read fixture seeds202 owned GL accounts (201 active) plus a foreign current-member account, a balanced draft journal and fiscal period; no approved/posted state is seeded. It checks exact populations/default200, continuation, numeric-string limit3, include-inactive202, owned requirements success → reports deny → same-ref refusal → restored identical success, and zero approvals/effects with unchanged broad PAT scopes. Supplemental missing-function RED observed; real runtime proof remains pending.

Six pure tests passed after current source edits (Vitest filtered contracts.int.test.ts; actual HTTP tests excluded). Root resource queue: invoice PG/heavy, exception authority projection regression, then this worker TS/HTTP. No worker process is held while waiting. Built c4b2 artifact must be reused, not rebuilt.
