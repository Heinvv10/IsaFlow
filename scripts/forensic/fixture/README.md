# The integration-test fixture database

`tests/integration/**` needs a PostgreSQL database with this application's schema. This directory
holds it as a checked-in snapshot so any session can rebuild the fixture from the repository alone.

## Run the integration tests

```bash
bash scripts/forensic/fixture-up.sh          # container isaflow-forensic-33150, ~20s
bash scripts/forensic/fixture-verify.sh      # must print "MATCH: schema matches <sha>"
eval "$(bash scripts/forensic/fixture-env.sh)"
bun run test:integration                     # or one file with vitest --config vitest.integration.config.ts
bash scripts/forensic/fixture-down.sh        # removes that container BY NAME, nothing else
```

Pass a five-digit port to every script to run more than one fixture at a time
(`fixture-up.sh 33151`, `fixture-env.sh 33151`, …). Port 33150 is the default; **33149 is
deliberately avoided** — it is the address of the legacy `isaflow-forensic-pg-20260909` container
that earlier sessions' notes refer to, and of the `--apply` guard in `schema-match.ts`.

`tests/integration/controls/*` deadlock against a shared database when run in parallel. Always
`--no-file-parallelism`, or give each runner its own fixture port.

## What is here

| File | What it is |
|---|---|
| `schema.sql` | `pg_dump -s` of the fixture, ownership preserved. Generated — never hand-edit. |
| `reference-data.sql` | Rows the *migrations* insert into `permission_modules`, `feature_flags`, `asset_categories`. Generated. |
| `roles.sql` | The three cluster roles, hand-written. `pg_dumpall --roles-only` emits password hashes, which must not enter the repository. |
| `reverts/*.sql` | Undo scripts for migrations that exist on other branches but not on this one, consumed by `schema-match.ts`. |

`reference-data.sql` is not test data: `pg_dump -s` drops rows, and routes validate against these
tables — without `permission_modules` the control routes answer `400 Unknown moduleKey: audit` and
`authorityLockLiveness` fails for a reason that has nothing to do with locks. All three tables are
company-agnostic (none has a `company_id`; every `asset_categories` GL column is NULL), so no
tenant data is carried.

The `\restrict` / `\unrestrict` lines `pg_dump` emits are stripped: the token is a fresh random
nonce every time, and leaving it in makes each regeneration diff look like a change when nothing
changed.

Ownership is preserved on purpose: `migration_admin` owns 238 objects in the dump, 12 of them
`SECURITY DEFINER` functions. Dumping `--no-owner` would silently re-own those and change what
they can do — a fidelity loss that produces test failures nobody can attribute.

## Why a snapshot and not `bun run db:migrate`

**A from-scratch apply of the migration set does not reproduce this application's schema.** Measured
2026-09-14 against commit `de65b289e`: 116 of 410 migrations fail on an empty database. That is
mostly one bug cascading — `company_users.user_id` is TEXT in the live schema and no migration ever
converts it from the UUID that `236_multi_entity.sql` creates, so `348_rls_and_auth_helpers.sql`
dies building `tenant_isolation` on `user_id = auth.uid()` and ~90 later migrations die with it.
With that one repair, and re-running failures as a fixed-point loop because the file numbering is
not the apply order (`220` references `companies`, created by `236`), it drops to 11.

Of the 11, three are data backfills that no empty database can satisfy, and at least one is a
second out-of-band divergence: `253_missing_tables.sql` creates `stock_items` as a VIEW selecting
`products.sku`, but `products` has no `sku` column and the live `stock_items` is a base table.

So a migration-built fixture would model what the migrations *say*, not what the code *runs
against*. This snapshot descends from the real schema instead. The repo defect the measurement
exposes — migrations that cannot rebuild the database — is real and worth fixing, but it is a
separate job from having a fixture.

## Regenerating after new migrations land

`fixture-verify.sh` fails with `missing: …` naming the migrations the snapshot lacks. Then:

```bash
bash scripts/forensic/fixture-up.sh 33151
eval "$(bash scripts/forensic/fixture-env.sh 33151)"
for f in scripts/migrations/sql/<the missing ones>; do
  docker exec -i isaflow-forensic-33151 psql -U postgres -d isaflow_schema_fixture -q -v ON_ERROR_STOP=1 < "$f"
done
bash scripts/forensic/fixture-verify.sh 33151 HEAD --apply   # reverts anything ahead; must print MATCH
docker exec isaflow-forensic-33151 pg_dump -U postgres -s isaflow_schema_fixture \
  | grep -v '^\\restrict \|^\\unrestrict ' > scripts/forensic/fixture/schema.sql
bash scripts/forensic/fixture-down.sh 33151
```

Re-apply any migration that only sets function `SET` clauses or grants — `838_control_authority_
lock_timeout.sql` is the one that exists today. `schema-match.ts` compares function *bodies*, not
`proconfig`, so it reports MATCH while such a setting is missing. That is not hypothetical: the
first cut of this snapshot lost `lock_timeout=5s` on `control_approval_authorities` because a
`CREATE OR REPLACE` during the revert step reset it, `MATCH` was reported anyway, and
`authorityLockLiveness.int.test.ts` is what caught it.

Commit the regenerated `schema.sql` with the migrations that caused it to change. A migration that
fails to apply forward here is telling you it was written against a state that no longer exists —
fix the migration, do not hand-edit the dump.

## What verification does and does not cover

`schema-match.ts` compares tables, `ADD COLUMN`s, triggers and function bodies for objects last
touched at or after the floor (default 600), plus the `-- detect:` query in each revert file.
**Privilege-only changes, RLS-policy-only changes and function `SET` clauses (`proconfig`) are not
compared** except through those detect queries. `MATCH` means the objects agree, not that every
grant, policy and setting does. Treat a green integration run as the stronger signal of the two,
and when a control test fails in a way that smells structural, check the fixture before the code.
