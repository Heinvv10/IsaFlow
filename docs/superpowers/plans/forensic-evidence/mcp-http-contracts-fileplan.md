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

## Actual built HTTP checkpoint

- Product remains exact c4b2c9859d15e295447ad1691d5d7d1c47b76d05, `.worktrees/mcp-forensic-ci-20260910`, BUILD_ID `gA68wVUXyzUBNPeonyd_6`. No rebuild. Owned Next session63989/PID1000732 listens only127.0.0.1:33219. Server database URLs validated against local33149 fixture; temporary preload refuses non-loopback network. Private environment contains only synthetic local credentials.
- Dedicated and source TS passed in86942; that chain failed only lint's project-service exclusion of tests/scripts. Dedicated typed lint60523 then passed using the same rules and explicit test project, without disabling rules.
- Named source b1fc91cc3 independently reviewed by root; correction bf7b3aa63 clarifies selected-shard test title and adds revoked-membership identity checks.
- Actual50013 terminal0: first500 of1934 planned calls passed, each matched a committed rejected/no-reported-write invocation receipt. Evidence `/tmp/isaflow-mcp-http-c4b2-shard0.json`. Original unannotated checkpoint preserved alongside as `.json.original`.
- Actual70486 terminal0: supplemental built HTTP reads passed; `/tmp/isaflow-mcp-http-c4b2-reads.json`. Both scope-null tools stayed bound to A despite a second B membership, then returned403 after A membership removal. Actual approval requirements loaded10 from a balanced unposted draft, refused after reports permission denial, and returned identical material after permission restoration. Broad PAT scopes stayed unchanged; zero approvals/effects and draft status remained. GL default200 of201 active accounts, complete continuation,202 including inactive, numeric-string limit3; exact owned IDs excluded foreign current-member account. Unknown method returned expected correlated -32601; malformed synthetic token returned401.
- Aggregate mixed-build acceptance was genuinely RED, then fixed to bind exact commit+BUILD_ID with external local process/cwd/artifact verification. It does not claim server-signed attestation. Existing500-call proof received explicitly labelled post-run provenance after rechecking unchanged server identity; no financial/gate rerun was claimed for metadata alone.
- Aggregate accepting a still-running checkpoint was separately RED; only passed shards can contribute to aggregate completion. CLI initializes fresh incomplete output before HTTP work. Partial evidence remains available without a successful aggregate claim.
- PG released after70486; Next remains idle for remaining shards. Final metadata65629 terminal0: dedicated TS, full-rule typed scoped lint and six pure tests passed. Remaining1434 calls, later152-tool integrated verification, financial workflow programme acceptance, final CI and PR delivery remain outstanding.
