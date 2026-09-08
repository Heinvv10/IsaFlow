# Execution baseline evidence

Baseline SHA: `5661d6f0f5f2212705151e95455a3f681ddf840e`. No application changes were present for these runs.

## CI and runtime

- `baseline-ci.log`: full `bun run ci`, pinned Node 20.12.0, exit **1**. All checks including production build passed except unit/component startup. Rolldown invokes `node:util.styleText` with an array; Node 20.12.0 rejects the format argument. DATABASE_URL unset, integration tests explicitly skipped.
- Node 22.23.1: the same Rolldown import and array-format call succeed. This meets the repository's `>=20.12.0` requirement but differs from `.nvmrc`. Runtime files have not been changed.
- `baseline-unit-node22.log`: `bun run test:unit`, Node 22.23.1, exit **0**. 776 files passed / 36 skipped; 9258 tests passed / 234 skipped. Skips remain visible and do not satisfy required workflow acceptance.
- `baseline-ci-node22.log`: full CI repeat under Node 22.23.1, exit **0**. All executed checks including production build passed; integration tests remain explicitly skipped because DATABASE_URL is unset. This is baseline code CI, not workflow acceptance.

## Disposable database

Container: `isaflow-remediation-pg-20260908` (`postgres:16-alpine`), label `isaflow.purpose=audit-remediation-disposable`, bound only to `127.0.0.1:33134`. Database `isaflow_remediation`; local throwaway password `remediation-local-only`. No production database used.

1. `disposable-migrations.log`: first committed runner invocation failed because its default SSL option requires TLS.
2. `disposable-migrations-no-ssl.log`: adding `?sslmode=disable` to the disposable URL allowed replay. Migration 220 failed with PostgreSQL 42P01, `relation "companies" does not exist`.
3. `git show 5661d6f0:scripts/migrations/sql/236_multi_entity.sql` is the only committed SQL definition of `companies`. Applied that exact file as an environment prerequisite; output in `disposable-prerequisite-236.log`.
4. `disposable-migrations-after-236.log`: replay still fails at migration 220 with 42883, `operator does not exist: uuid = character varying`. Migration 000 creates `users.id VARCHAR(255)`; migration 236 creates `company_users.user_id UUID`; migration 220's final membership INSERT compares these without conversion.

This is an incomplete fresh migration replay, not a representative full schema. Two-company fixtures, roles, RLS, GoTrue and provider workflow acceptance remain OPEN. No migrations were skipped or backfilled as applied. No speculative schema replacement was added.
