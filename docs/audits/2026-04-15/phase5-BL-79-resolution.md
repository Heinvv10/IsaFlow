# BL-79: Ghost Migration Resolution — `245_inventory.sql`

**Date:** 2026-04-15  
**Resolved by:** Claude (sonnet-4-6) via investigation + DB DELETE  
**Path taken:** Path 2 — Delete orphan DB record

---

## Problem

The `schema_migrations` table contained a row:

| name | version | applied_at | checksum |
|------|---------|-----------|---------|
| `245_inventory.sql` | `245` | 2026-03-28 09:16:31 UTC | NULL |

No file named `245_inventory.sql` existed on disk. Version `245` was also used by `245_company_settings.sql`, creating a collision.

---

## Investigation (Phase A)

### Git history

Two commits on 2026-03-28 tell the full story:

1. **`7af829f`** — `feat: add inventory & products module` — Created `245_inventory.sql` containing the products, warehouses, stock_levels, and stock_movements schema.

2. **`86ec966`** — `fix: critical security and data isolation fixes` — Renamed `scripts/migrations/sql/245_inventory.sql` → `scripts/migrations/sql/244b_inventory.sql` on disk to fix the duplicate version-245 prefix. Commit message explicitly says: _"Fix duplicate 245_ prefix (rename inventory to 244b)"_.

   Git confirms: `R100 scripts/migrations/sql/245_inventory.sql → scripts/migrations/sql/244b_inventory.sql`

### DB state before fix

The migration runner had run the file **before** the rename (tracking it as `245_inventory.sql` with NULL checksum — the old runner did not compute checksums). After the rename, the runner re-encountered the file under its new name `244b_inventory.sql` and tracked it correctly with a SHA-256 checksum.

Result: two DB rows for the same schema, one ghost (`245_inventory.sql`) and one correct (`244b_inventory.sql`).

### Schema presence

The inventory schema (tables: `products`, `product_categories`, `warehouses`, `stock_levels`, `stock_movements`) **is live in the database**, applied via `244b_inventory.sql`. No data loss risk.

---

## Resolution

Deleted the ghost orphan row:

```sql
DELETE FROM schema_migrations WHERE name = '245_inventory.sql' AND checksum IS NULL;
```

---

## Final State

| name | version | applied_at | checksum |
|------|---------|-----------|---------|
| `244b_inventory.sql` | `244b` | 2026-03-28 09:16:31 UTC | e5d63ae8... |
| `245_company_settings.sql` | `245` | 2026-03-28 09:16:32 UTC | 1bba44f1... |

Files on disk for `244*` / `245*`:
- `scripts/migrations/sql/244_fixed_assets.sql`
- `scripts/migrations/sql/244b_inventory.sql`
- `scripts/migrations/sql/245_company_settings.sql`

No version collision remains. Every DB row corresponds to a file on disk.
