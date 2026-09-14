# Migration Files

## Naming Convention

`NNN_description.sql` — 3-digit zero-padded numeric prefix, snake_case description.

To insert a migration **between** two existing numbers, use a letter suffix:
`244b_add_missing_index.sql`

## Identity Rule

`apply-migrations.ts` tracks migrations by **full filename** (`schema_migrations.name` has a UNIQUE constraint).
Never rename a migration file after it has been applied to any environment — the runner would treat the renamed file as new and attempt re-application.

### Exception: the 676–716 block, renumbered 2026-09-14

The rule stands. One block was renumbered anyway, and this records why so the next person who finds it does not conclude the rule is dead.

The MCP forensic-controls programme carried 41 migrations spread over 626–692. `origin/master` tops out at 675, and six of those prefixes (626, 627, 644, 645, 662, 675) were **a different file on each side**. Because the runner applies in prefix order, merging master would have interleaved the two sets and run an ordering nobody had tested against master's schema. The 41 were moved into a contiguous 676–716 block, relative order unchanged.

**The one condition that made it sound: these files had never reached production.** Confirmed against `isaflow_dev` too — none of the 41 old names appear in its `schema_migrations`, and none of the programme's `control_*` tables or functions exist there. The only database that had them was the programme's synthetic fixture.

The renaming is safe *because* of what the Identity Rule warns about, not in spite of it: a database holding an old name sees each renamed file as new and re-applies it in full. That is only acceptable when every file is idempotent, so it was measured — all 41 applied **twice** to a copy of the fixture that already carried them, 41/41 in both passes, with no schema object changed by the second. Schema equivalence between the two orderings was separately proven on two disposable databases across tables, columns, types, defaults, nullability, constraints, indexes, triggers, functions (`prosecdef`/`proowner`/`proconfig`/`prosrc`), grants, RLS enabled+forced, and policies.

Full old→new mapping: `docs/superpowers/plans/2026-09-09-mcp-forensic-progress.md`, entry dated 2026-09-14.

**Do not treat this as a precedent.** Renaming is defensible only when the files have reached no environment you do not control, every one is idempotent, and you have proven both.

## Prefix Uniqueness

Each new migration must use the **next unused** numeric prefix. Find it with:

```bash
ls scripts/migrations/sql/ | sort | tail -5
```

Never reuse an existing prefix.

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

Warns on any new duplicate prefixes (exits 0 — informational only).
