# Synthetic forensic fixture handoff

Base a107aa8b; branch feat/mcp-forensic-fixtures-20260909. No database calls were made: root serializes provisioning after CI. Implementation is unit-tested; real schema compatibility and HTTP acceptance remain unverified.

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
