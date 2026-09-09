# Synthetic forensic fixture handoff

Base a107aa8b; branch feat/mcp-forensic-fixtures-20260909. Initial implementation was unit-only. Subsequent root-leased real PostgreSQL proof passed as recorded below; HTTP acceptance remains unverified.

Owned interfaces in `tests/integration/forensic-fixture.ts`:

- `validateFixtureTarget(config)` validates explicit opt-in, dedicated URL, localhost/127.0.0.1, exact database isaflow_schema_fixture, no query/fragment and port33149. Another generated five-digit port requires matching `generatedPort` and `fixtureLabel=isaflow-forensic-<port>`; labels are caller declarations, not Docker label verification.
- `createFixtureIdentity()` generates independent run/company/person IDs and synthetic PAT credentials. A has U1/U2, B has U3; U1 has two different PATs for the same person. Email domain forensic.invalid. No shared static token or real identity is used.
- `provisionForensicFixture(config)` validates before opening a pool, probes current_database before writes, inserts two companies/three users/three memberships/four PAT hashes in one transaction, rolls back insertion failure, closes client and pool. Users have global viewer role and local admin membership; PAT scopes use the current canonical vocabulary and expire in one day. A caller can downgrade memberships/grants for adversarial scenarios. It returns the synthetic fixture including in-memory raw PATs for local HTTP tests. No token plaintext is stored in DB or printed.

`scripts/forensic/fixture-bootstrap.ts` exports `fixtureConfigFromEnv` and `bootstrapFixture`. Environment names: ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1, ISAFLOW_FORENSIC_FIXTURE_URL, optional ISAFLOW_FORENSIC_FIXTURE_PORT and ISAFLOW_FORENSIC_FIXTURE_LABEL. Application DATABASE_URL is never a fallback. CLI prints only synthetic ids/count; programmatic callers receive tokens. Configure local application auth DB independently and enable MCP feature flags through root-owned fixture setup before HTTP acceptance; bootstrap does not alter flags or grants globally. Repeated provisioning makes fresh isolated rows; cleanup of financial cases is deliberately left to disposable-database lifecycle rather than cascading deletion helpers.

Target is the root-owned port33149 schema-only fixture with upgrades616-618; this module does not claim historical migration replay. Pool bound max1/connect3s/statement5s, SSL disabled only for explicitly selected local fixture. Endpoint validation cannot establish the ultimate target of an operator's local port forwarding; root owns the disposable container provenance.

## Verification

TDD red: wrote fixtureSafety.test.ts first; Vitest failed import because fixture module did not exist (`/tmp/forensic-fixture-red.log`). Green after implementation: 13 tests pass (`/tmp/forensic-fixture-green.log`), covering port/host/database/protocol/parameter override refusal, opt-in, distinct tokens/persons, generated-port labels and absence of ambient DATABASE_URL fallback.

Commands (each from the isolated worktree; Node22.23.1 on PATH):

```
node node_modules/vitest/vitest.mjs run tests/unit/forensic/fixtureSafety.test.ts
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --skipLibCheck --esModuleInterop --target es2022 --module commonjs --moduleResolution node --ignoreDeprecations 6.0 tests/integration/forensic-fixture.ts scripts/forensic/fixture-bootstrap.ts tests/unit/forensic/fixtureSafety.test.ts
```

Focused TypeScript compile passed. Direct ESLint on these three files failed project-service discovery because repo tsconfig excludes their locations; no ESLint/config/hook changes made. Initial focused tsc command required the installed TypeScript6 --ignoreConfig flag and was rerun successfully. Full CI and DB proof remain root integration checks, not waived. Existing integration node_modules symlink reused after identical bun.lock comparison. All owned code files are below300 lines.

Initial commit secret-scan hook rejected literal synthetic password URLs in negative tests. Removed password components entirely from those URLs; no hook bypass used.

## Real PostgreSQL proof (subsequent root-granted DB lease)

`tests/integration/forensic-fixture.int.test.ts` passed3 tests against the root-owned PG16 container isaflow-forensic-pg-20260909, local33149/isaflow_schema_fixture. Root independently verified Docker purpose=isaflow-forensic-synthetic before granting the lease. No baseline schema repairs were needed.

Verified two company rows, three user rows, three memberships, four PAT hashes; real application validatePat accepts every token and both U1 tokens map to U1 with distinct patIds. SET LOCAL ROLE app_user plus JWT/company GUCs exposes only owned company/membership rows in each direction. A disposable trigger rejects synthetic PAT insertion after company/user/membership inserts: provisionForensicFixture throws and all four table counts remain unchanged. Trigger/function removed in finally. No sessions with application_name=isaflow-forensic-fixture remain; test and application PAT pools are explicitly closed.

Command from worker worktree with Node22.23.1 on PATH, ISAFLOW_FORENSIC_FIXTURE_OPT_IN=1, dedicated ISAFLOW_FORENSIC_FIXTURE_URL targeting postgres@127.0.0.1:33149/isaflow_schema_fixture, and disposable PGPASSWORD supplied at runtime (no credentials committed):

```
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/forensic-fixture.int.test.ts
```

First run3/3passed250ms; after adding explicit users-table count assertion final run3/3passed274ms (128ms test time). Latest raw local log /tmp/forensic-fixture-db.log. Successful random synthetic fixture identities are retained in this disposable database for root inspection; the two runs created two independent sets (4companies/6users/8PATs total added). Failed provisioning added zero rows. No production or external endpoints called, no messages sent, no migrations/build/full CI executed. This proves existing fixture compatibility, not historical migration replay or MCP HTTP acceptance.
