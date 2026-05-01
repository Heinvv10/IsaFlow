-- Bank categorisation rules — prevent cross-tenant references.
--
-- Background: a bank rule's gl_account_id and supplier_id were only
-- constrained to exist in their target tables, not to belong to the same
-- company as the rule itself. A Sage migration / data copy left rules on
-- company A pointing at GL accounts belonging to company B (the demo).
-- Auto-apply then produced unbalanced journal entries because cross-tenant
-- inserts on gl_journal_lines were silently dropped (RLS scoping).
--
-- Fix: enforce composite FKs (id, company_id) -> table(id, company_id) on
-- gl_account_id and supplier_id. The PK already uniquely determines
-- (id, company_id), but Postgres requires an explicit unique constraint
-- for the FK target — we add idempotent UNIQUE indexes.
--
-- client_id intentionally NOT guarded here: the `clients` table is a
-- global CRM record without a company_id column. If you need cross-tenant
-- protection for client_id you must first add company_id to `clients`
-- (a much larger schema change touching contact ownership semantics).
--
-- Idempotent: safe to re-run.

-- ── 1. Add UNIQUE (id, company_id) targets ──────────────────────────────────
-- The pkey on id already guarantees uniqueness; this index simply lets us
-- reference (id, company_id) as a composite FK target.

CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_id_company_uq
  ON gl_accounts(id, company_id);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_id_company_uq
  ON suppliers(id, company_id);

-- ── 2. Self-heal pre-existing cross-tenant references ──────────────────────
-- A handful of rules were left pointing at GL accounts / suppliers in a
-- different company (bug surfaced 2026-05-01). The rules were disabled on
-- detection but the bad foreign-key value remained, which would block the
-- composite FK below. We NULL out the bad ref so the rule row survives
-- (for audit) but is functionally inert — the matching service already
-- skips account-rules with NULL gl_account_id.

WITH bad_gl AS (
  SELECT bcr.id
    FROM bank_categorisation_rules bcr
    JOIN gl_accounts ga ON ga.id = bcr.gl_account_id
   WHERE bcr.gl_account_id IS NOT NULL
     AND bcr.company_id <> ga.company_id
)
UPDATE bank_categorisation_rules
   SET gl_account_id = NULL,
       is_active = FALSE,
       updated_at = NOW()
 WHERE id IN (SELECT id FROM bad_gl);

WITH bad_sup AS (
  SELECT bcr.id
    FROM bank_categorisation_rules bcr
    JOIN suppliers s ON s.id = bcr.supplier_id
   WHERE bcr.supplier_id IS NOT NULL
     AND bcr.company_id <> s.company_id
)
UPDATE bank_categorisation_rules
   SET supplier_id = NULL,
       is_active = FALSE,
       updated_at = NOW()
 WHERE id IN (SELECT id FROM bad_sup);

-- ── 3. Drop legacy simple FKs (idempotent) ──────────────────────────────────
ALTER TABLE bank_categorisation_rules
  DROP CONSTRAINT IF EXISTS bank_categorisation_rules_gl_account_id_fkey,
  DROP CONSTRAINT IF EXISTS bank_categorisation_rules_supplier_id_fkey,
  DROP CONSTRAINT IF EXISTS bank_categorisation_rules_gl_account_tenant_fkey,
  DROP CONSTRAINT IF EXISTS bank_categorisation_rules_supplier_tenant_fkey;

-- ── 4. Add composite tenant-aware FKs ───────────────────────────────────────
-- ON DELETE SET NULL: if the underlying GL/supplier is deleted, the rule
-- survives but is auto-disabled by the matching service (it skips
-- account-rules with NULL gl_account_id) — same behaviour as today.

ALTER TABLE bank_categorisation_rules
  ADD CONSTRAINT bank_categorisation_rules_gl_account_tenant_fkey
    FOREIGN KEY (gl_account_id, company_id)
    REFERENCES gl_accounts(id, company_id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE bank_categorisation_rules
  ADD CONSTRAINT bank_categorisation_rules_supplier_tenant_fkey
    FOREIGN KEY (supplier_id, company_id)
    REFERENCES suppliers(id, company_id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY IMMEDIATE;

COMMENT ON CONSTRAINT bank_categorisation_rules_gl_account_tenant_fkey
  ON bank_categorisation_rules IS
  'Composite tenant guard: gl_account_id must belong to the rule''s own company.';
COMMENT ON CONSTRAINT bank_categorisation_rules_supplier_tenant_fkey
  ON bank_categorisation_rules IS
  'Composite tenant guard: supplier_id must belong to the rule''s own company.';
