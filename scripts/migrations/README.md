# Migration Files

## Naming Convention

`NNN_description.sql` — 3-digit zero-padded numeric prefix, snake_case description.

To insert a migration **between** two existing numbers, use a letter suffix:
`244b_add_missing_index.sql`

## Identity Rule

`apply-migrations.ts` tracks migrations by **full filename** (`schema_migrations.name` has a UNIQUE constraint).
Never rename a migration file after it has been applied to any environment — the runner would treat the renamed file as new and attempt re-application.

## Prefix Uniqueness

Each new migration must use the **next unused** numeric prefix. Prefixes are
ordered numerically and may exceed 999 (`1000_` follows `999_`; a plain `sort`
puts it before `100_`). Find the newest with:

```bash
ls scripts/migrations/sql/ | LC_ALL=C sort -t_ -k1,1n | tail -5
```

Never reuse an existing prefix.

Parallel PRs often pick the same "next" prefix. Don't coordinate by hand: the
merge queue checks every queued PR's new migrations against `master` and the
other PRs in its batch. On a clash it ejects the PR with the exact rename to make
(`git mv` to the next free integer prefix, `1000_`, `1001_` …, SQL unchanged,
references updated), and the PR goes back in the queue after the rename. Write
every migration idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF
EXISTS` before `CREATE POLICY`/`TRIGGER`) so a rename never matters. The gate's
fixer never edits migrations; the queue lead or the PR's owner does the rename.

## Historical Duplicate Prefixes

Seven prefix pairs exist from parallel feature development. They are tracked correctly by filename and must not be renamed. No new duplicates should be added.

| Prefix | Files |
|--------|-------|
| 341 | `341_payroll_sars_codes.sql`, `341_portal_contacts.sql` |
| 342 | `342_payroll_medical_aid_deps.sql`, `342_portal_magic_links.sql` |
| 343 | `343_afs_signum_columns.sql`, `343_payroll_eti.sql` |
| 344 | `344_afs_section_comments_author_type.sql`, `344_payroll_audit_log.sql` |
| 434 | `434_analytics_utm.sql`, `434_customer_dunning_overrides.sql` |
| 436 | `436_bureaus.sql`, `436_sent_mirror_connections.sql` |
| 437 | `437_payg_flow_wallet.sql`, `437_payroll_recurring_components.sql` |

## Idempotency

- `CREATE TABLE` / `CREATE INDEX` must use `IF NOT EXISTS`
- `INSERT` seeds should use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`

## Running Migrations

```bash
bun scripts/apply-migrations.ts           # apply pending
bun scripts/apply-migrations.ts --dry-run # preview only
```

Uses an advisory lock — concurrent runs are safe.

## Audit

```bash
bun scripts/audit-migration-naming.ts
```

Fails (exit 1) when a migration's version prefix clashes with another migration or with a prod-tracked file that left the repo. It runs in CI (`migration-naming` step) so the clash shows on the PR, not at deploy. Rule and frozen historic list: `scripts/ci/migrationPrefixRule.ts`.
