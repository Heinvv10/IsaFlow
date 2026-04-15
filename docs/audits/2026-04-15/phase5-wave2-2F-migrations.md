# Phase 5 — Wave 2 Stream 2F: Migration Integrity

**Date:** 2026-04-15
**Auditor:** Wave 2 Stream 2F (automated)
**Scope:** `scripts/migrations/sql/` vs `schema_migrations` table (Neon production DB)

---

## Summary

| Metric | Value |
|--------|-------|
| Disk files | 121 |
| DB records | 122 |
| In DB only (not on disk) | **1** — `245_inventory.sql` |
| On disk only (not in DB) | 0 |
| Missing IF NOT EXISTS guards | **0** |
| Duplicate-prefix groups investigated | 9 (prefixes 245, 246, 250, 251, 255, 265, 266, 292, 300) |
| Identical duplicate pairs | 0 (all pairs have distinct content) |
| Both members of duplicate in DB | 8 of 9 groups (all pairs both applied) |

---

## Disk / DB Diff

### Raw diff (disk sorted vs DB sorted)

```
In DB not on disk:
  245_inventory.sql

On disk not in DB:
  (none)
```

### Interpretation

One DB record — `245_inventory.sql` (version `245`, applied `2026-03-28 09:16:31 UTC`, **checksum NULL**) — has no corresponding file on disk.

- The NULL checksum strongly suggests this record was created by an older version of the migration runner that did not yet compute checksums, or was inserted manually/by a now-deleted file.
- The schema changes it recorded (inventory tables) appear to have been superseded or absorbed by `244b_inventory.sql`, which exists on disk, has a valid checksum, and was applied moments earlier at `2026-03-28 09:16:30 UTC`.
- Prefix `245` on disk is occupied by `245_company_settings.sql` (a different migration). The DB contains **both** `245_inventory.sql` and `245_company_settings.sql` under the same version key `245`, creating a version-key collision at the DB level.

**Severity: P0** — A DB record for a schema-defining migration (`245_inventory.sql`) has no backing file on disk. The migration runner cannot verify its checksum or re-apply it. If the runner enforces checksum integrity on every boot it will fail or skip this record unpredictably.

---

## IF NOT EXISTS Gaps

No CREATE TABLE or CREATE INDEX statements were found without `IF NOT EXISTS` guards across all 121 migration files.

| # | File | Missing-guard CREATEs | Severity |
|---|------|-----------------------|----------|
| — | — | — | — |

All migrations are fully idempotent with respect to object creation.

---

## Duplicate-Prefix Investigation

Nine prefix groups carry two files each. All pairs have **distinct content** (none are content-identical clones). The migration system identifies records by full filename, so both files in each pair are tracked independently in the DB.

| Prefix | File A | File B | Identical? | Both in DB? | Severity | Notes |
|--------|--------|--------|------------|-------------|----------|-------|
| 245 | `245_company_settings.sql` | *(disk only — see P0 above)* | N/A | One missing (`245_inventory.sql`) | **P0** | `245_inventory.sql` in DB with NULL checksum, no disk file; version key `245` collision |
| 246 | `246_customer_supplier_fields.sql` | `246_purchase_orders.sql` | No | Yes | P1 | Both applied; completely different schemas (customer fields vs PO/GRN tables). Ordering ambiguous if runner sorts by prefix only. |
| 250 | `250_leave_management.sql` | `250_vlm_extraction.sql` | No | Yes | P1 | Both applied; distinct tables (leave types vs procurement documents). |
| 251 | `251_demo_seed_data.sql` | `251_projects.sql` | No | Yes | P1 | Both applied; distinct purposes (seed data vs projects schema). |
| 255 | `255_fix_missing_schema.sql` | `255_migration_wizard.sql` | No | Yes | P1 | Both applied; distinct schemas (schema patches vs wizard UI tables). |
| 265 | `265_admin_platform_announcements.sql` | `265_vat_period_alignment.sql` | No | Yes | P1 | Both applied; distinct schemas (announcements table vs VAT period columns). |
| 266 | `266_account_lockout.sql` | `266_admin_platform_company_user_ext.sql` | No | Yes | P1 | Both applied; distinct schemas (user lockout columns vs billing/plan extension). |
| 292 | `292_composite_indexes_batch2.sql` | `292_product_categories_company_id.sql` | No | Yes | P1 | Both applied at different times (Apr 12 and Apr 14). The `292_product_categories_company_id.sql` was a later hotfix with the same prefix. Ordering risk if runner re-processes. |
| 300 | `300_portal_invoice_token.sql` | `300_webhooks.sql` | No | Yes | P1 | Both applied; distinct schemas (invoice token column vs webhook tables). |

### P1 Analysis

All 8 P1 pairs are already applied in the DB (both members present with valid checksums). The immediate operational risk is low — the schema changes are in production. However:

1. If the migration runner sorts by prefix number to determine run order, it may apply the two files in inconsistent order across environments (sort order of equal-prefix files is filesystem-dependent).
2. If a new environment is provisioned from scratch, the runner must handle both files with the same numeric prefix. File-system sort order (alphabetical within the same prefix) determines which runs first — this is implicit and not documented.
3. Any future migration tool upgrade that enforces unique numeric prefixes will require a rename/renumber operation on all 8 pairs.

---

## Findings Summary

| # | File / Record | Issue | Severity |
|---|---------------|-------|----------|
| 1 | `245_inventory.sql` (DB record only) | In DB with NULL checksum, no corresponding disk file; version `245` collision with `245_company_settings.sql` | **P0** |
| 2 | `246_customer_supplier_fields.sql` + `246_purchase_orders.sql` | Duplicate prefix 246; both in DB; different schemas; ordering ambiguous | P1 |
| 3 | `250_leave_management.sql` + `250_vlm_extraction.sql` | Duplicate prefix 250; both in DB; different schemas | P1 |
| 4 | `251_demo_seed_data.sql` + `251_projects.sql` | Duplicate prefix 251; both in DB; different schemas | P1 |
| 5 | `255_fix_missing_schema.sql` + `255_migration_wizard.sql` | Duplicate prefix 255; both in DB; different schemas | P1 |
| 6 | `265_admin_platform_announcements.sql` + `265_vat_period_alignment.sql` | Duplicate prefix 265; both in DB; different schemas | P1 |
| 7 | `266_account_lockout.sql` + `266_admin_platform_company_user_ext.sql` | Duplicate prefix 266; both in DB; different schemas | P1 |
| 8 | `292_composite_indexes_batch2.sql` + `292_product_categories_company_id.sql` | Duplicate prefix 292; both in DB (applied different dates); ordering risk on fresh install | P1 |
| 9 | `300_portal_invoice_token.sql` + `300_webhooks.sql` | Duplicate prefix 300; both in DB; different schemas | P1 |

---

## Recommended Remediations

### P0 — `245_inventory.sql` ghost record

**Option A (preferred):** Reconstruct the SQL file from git history (`git log --all --full-history -- scripts/migrations/sql/245_inventory.sql`) and restore it to disk. Update the DB record checksum to match.

**Option B:** If the migration was superseded by `244b_inventory.sql`, DELETE the orphaned DB record after verifying no schema objects depend on it uniquely.

In either case the version key collision (`245` pointing to two DB records) must be resolved by renumbering one of the two `245_*` files.

### P1 — Duplicate-prefix pairs (8 groups)

Renumber one file in each pair to the next available prefix. Suggested assignments (verify availability first):

| Current | Rename to |
|---------|-----------|
| `246_purchase_orders.sql` | `246b_purchase_orders.sql` or `247b_...` |
| `250_vlm_extraction.sql` | `250b_vlm_extraction.sql` |
| `251_projects.sql` | `251b_projects.sql` |
| `255_migration_wizard.sql` | `255b_migration_wizard.sql` |
| `265_vat_period_alignment.sql` | `265b_vat_period_alignment.sql` |
| `266_admin_platform_company_user_ext.sql` | `266b_admin_platform_company_user_ext.sql` |
| `292_product_categories_company_id.sql` | `292b_product_categories_company_id.sql` |
| `300_webhooks.sql` | `300b_webhooks.sql` |

After renaming on disk, update the `schema_migrations` DB records to match the new filename (`name` column). The checksum remains the same — only the name changes.
