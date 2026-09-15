# The integration-test fixture database

`tests/integration/**` needs a PostgreSQL database with this application's schema. This directory
holds it as a checked-in snapshot so any session can rebuild the fixture from the repository alone.

## Run the integration tests

```bash
bash scripts/forensic/fixture-up.sh          # container isaflow-forensic-33150, ~20s
bash scripts/forensic/fixture-verify.sh      # must print "MATCH" and the 838 check must say OK
eval "$(bash scripts/forensic/fixture-env.sh)"
bun run test:integration                     # serial by default; see vitest.integration.config.ts
bash scripts/forensic/fixture-down.sh        # removes that container BY NAME, nothing else
```

Pass a five-digit port to every script to run more than one fixture at a time
(`fixture-up.sh 33151`, `fixture-env.sh 33151`, …). Port 33150 is the default; **33149 is
deliberately avoided** — it is the address of the legacy `isaflow-forensic-pg-20260909` container
that earlier sessions' notes refer to, and of the `--apply` guard in `schema-match.ts`.

`tests/integration/controls/*` take real row and table locks on one database and deadlock each
other in parallel, so the vitest config sets `fileParallelism: false`. For speed, shard across
separate fixtures — they contend on nothing:

```bash
for i in 1 2 3 4; do bash scripts/forensic/fixture-up.sh 3315$i; done
# then per shard, with that shard's env:
vitest run --config vitest.integration.config.ts tests/integration/controls --shard=$i/4
```

## What is here

| File | What it is |
|---|---|
| `schema.sql` | `pg_dump -s` of the fixture, ownership preserved. **Generated — never hand-edit.** Its header states its provenance and the commit it was verified against. |
| `reference-data.sql` | Rows the *migrations* insert into `permission_modules`, `feature_flags`, `asset_categories` (generated), plus ONE hand-added row: the reserved gateway principal from migration 841. |
| `roles.sql` | The three cluster roles, hand-written. `pg_dumpall --roles-only` emits password hashes, which must not enter the repository. |
| `reverts/*.sql` | Undo scripts for migrations that exist on other branches but not on this one, consumed by `schema-match.ts`. |

Ownership is preserved on purpose: `migration_admin` owns 238 objects in the dump, 12 of them
`SECURITY DEFINER`. Dumping `--no-owner` would silently re-own those and change what they can do.

`reference-data.sql` is not test data: `pg_dump -s` drops rows, and routes validate against these
tables — without `permission_modules` the control routes answer `400 Unknown moduleKey: audit` and
`authorityLockLiveness` fails for a reason that has nothing to do with locks. All three tables are
company-agnostic (none has a `company_id`; every `asset_categories` GL column is NULL).

The one hand-added row is migration 841's reserved unattended principal, the identity a Paystack
webhook settlement is attributed to. It is hand-added rather than dumped because `users` also holds
people and must never be dumped wholesale into this repository. Keep it in step with 841 by hand; a
fresh fixture must contain exactly one user, and that is it.

The `\restrict` / `\unrestrict` lines `pg_dump` emits are stripped: the token is a fresh random
nonce every time, and leaving it in makes each regeneration diff look like a change.

## Why a snapshot and not `bun run db:migrate`

**A from-scratch apply of the migration set does not reproduce this application's schema**, and it
is not close. Measured 2026-09-14: 116 of 411 migrations fail on an empty database.

Most of that is one bug cascading. `company_users.user_id` is TEXT in the live schema and no
migration converts it from the UUID that `236_multi_entity.sql` creates, so
`348_rls_and_auth_helpers.sql` dies building `tenant_isolation` on `user_id = auth.uid()` and ~90
later migrations die with it. Apply that one repair, and re-run failures as a fixed-point loop
because the file numbering is not the apply order (`220` references `companies`, created by `236`),
and it drops to 12. Those 12:

| Migration | Why it fails from scratch |
|---|---|
| `251_demo_seed_data`, `479_subledger_recon_brightsphere`, `606_backfill_system_account_roles` | Data backfills; no empty database can satisfy them. |
| `253_missing_tables` | Creates `stock_items` as a VIEW over `products.sku`. `products` has no `sku`. |
| `255_fix_missing_schema`, `440_app_settings_view`, `436_sent_mirror_connections`, `672_capture_posting_claim_fence`, `816_bank_statement_attestation_intents` | Downstream of `253` failing. |
| `284_bank_rules_columns` | `RENAME COLUMN match_value TO match_pattern` unguarded, after `256` already created `match_pattern`. |
| `311_missing_indexes` | Indexes a column that does not exist at that point in the order. |
| ~~`841_gateway_receipt_principal`~~ | FIXED in `976457568`. It named `users.password_hash`, dropped by `349_users_profile_shadow.sql` at the GoTrue cutover, so it failed at parse and could never apply anywhere. Found by this fixture within minutes of the fixture existing; now verified to apply in full and to be idempotent. |

So a migration-built fixture would model what the migrations *say*, not what the code *runs
against*, and would produce exactly the unattributable failures that make a bad fixture worse than
none. This snapshot descends from the live schema instead.

### The divergences found so far

Places where the live schema holds something no migration produces. This is a **lower bound** —
the from-scratch comparison ran against an incomplete schema (12 migrations never applied), so
anything downstream of those is not comparable.

| Divergence | Note |
|---|---|
| `company_users.user_id` UUID → TEXT | Load-bearing: every `tenant_isolation` RLS policy depends on it. |
| `admin_audit_log.admin_user_id` uuid → varchar | Same class. |
| `admin_audit_log.target_id` uuid → varchar | Same class. |
| `system_announcements.created_by` uuid → varchar | Same class. |
| `exchange_rates.{from_currency,to_currency,source}` text → varchar | Cosmetic in PostgreSQL. |
| `stock_items` VIEW → BASE TABLE | Structural; see `253` above. |

The first four are one decision, not four accidents: `users.id` is `character varying`, and the
migrations declare `uuid` for the columns that hold user ids. The live schema was corrected by
hand; the migrations were not.

Excluded after checking, because they are artefacts of the fixed-point retry loop rather than real
divergences: `app_settings` (TABLE from scratch, VIEW live) and `dunning_communications` (present
from scratch, absent live) — both are tables `253` creates, and re-running `253` late reverses a
later migration that replaced or dropped them.

**This is a disaster-recovery finding, not a fixture problem.** Fixing it is separate work.

## Regenerating after new migrations land

`fixture-verify.sh` fails with `missing: …` naming what the snapshot lacks. Then:

```bash
bash scripts/forensic/fixture-up.sh 33151              # a FRESH fixture, see the warning below
eval "$(bash scripts/forensic/fixture-env.sh 33151)"
for f in scripts/migrations/sql/<the missing ones>; do
  docker exec -i isaflow-forensic-33151 psql -U postgres -d isaflow_schema_fixture \
    -q -v ON_ERROR_STOP=1 < "$f"
done
bash scripts/forensic/fixture-verify.sh 33151 HEAD --apply   # reverts anything ahead
bash scripts/forensic/fixture-dump.sh 33151 HEAD             # verifies again, then writes schema.sql
bash scripts/forensic/fixture-down.sh 33151
```

**Dump only from a fixture that has never run a test.** The guard exists because a
`synthetic_comparison_source_suppress()` trigger function, carrying two hardcoded UUIDs in its
body, was created by the controls suite and made it into a dump taken from a used fixture.

`fixture-dump.sh` detects "used" by three independent signals, any one of which refuses the dump:

1. any row in `companies` — every tenant-scoped suite provisions one, since
   `provisionForensicFixture` always does;
2. any row in `users` other than the single reserved gateway principal above;
3. any relation OR function in `public` named `synthetic*` — the convention the suites use for
   objects they create, and the one that actually leaked.

Three rather than one because a suite can use the fixture in a way this script did not anticipate.
If you find a fourth way, add a fourth signal here rather than relying on the content checks at the
end of the dump to catch it. Each of the three is verified to refuse by adding the thing and
watching the dump be rejected.

A migration that fails to apply forward here is telling you it was written against a state that no
longer exists. Fix the migration; never hand-edit the dump.

### `CREATE OR REPLACE FUNCTION` silently resets `proconfig`

**Anyone who reverts or re-applies a function in this schema loses its `SET` clauses unless they
re-assert them.** This has cost the same setting three times: in the revert step that built the
first cut of this snapshot; in the legacy fixture, where the Sage branch re-created
`control_approval_authorities` after the bound was set; and originally — which is why
`838_control_authority_lock_timeout.sql` exists at all and does nothing but re-issue
`ALTER FUNCTION … SET lock_timeout`.

So after regenerating, **re-apply every settings-only migration** — `838` is the only one today.
`fixture-verify.sh` asserts 838's invariant directly and fails if any `control-authority` lock
holder has lost `lock_timeout=5s`; a second settings-only migration needs its own check added
there, because nothing else in the pipeline can see it.

## What verification does and does not cover

`schema-match.ts` compares tables, `ADD COLUMN`s, triggers and function bodies for objects last
touched at or after the floor (default 600), plus the `-- detect:` query in each revert file.

**Not compared: grants, RLS policies, `CHECK` constraints, and function `SET` clauses
(`proconfig`).** `MATCH` means the objects agree, not that every grant, policy and setting does.
A verifier that says MATCH while a security-relevant attribute has drifted is a real hazard, and
the `proconfig` case above is a worked example — `schema-match` reported MATCH with `lock_timeout`
missing, and an integration test, not the verifier, is what caught it.

Extending `schema-match` to compare `proconfig` properly is not cheap: `838` sets it from a
`DO` block using `format()`, so there is no static `ALTER FUNCTION` statement to parse. The
targeted assertion in `fixture-verify.sh` is the affordable substitute. `prosecdef` and function
ownership were checked by hand and do **not** drift through the revert step —
`CREATE OR REPLACE FUNCTION` preserves the owner of an existing function — so they need no guard
today; a revert that ever does `DROP FUNCTION` followed by `CREATE` would change that.

Treat a green integration run as the stronger signal of the two, and when a control test fails in
a way that smells structural, check the fixture before the code.
