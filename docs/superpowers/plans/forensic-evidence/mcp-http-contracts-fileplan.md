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
