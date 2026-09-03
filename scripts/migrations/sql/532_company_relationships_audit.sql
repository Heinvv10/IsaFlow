-- ============================================================================
-- 532: company_relationships audit trail + soft delete
--
-- A row in company_relationships is a cross-tenant READ GRANT: consolidation's
-- trial-balance and intercompany-balances endpoints aggregate the child's whole
-- general ledger into the parent's view. Until now the table recorded neither
-- who created that grant nor any way to withdraw it — `createCompanyRelationship`
-- accepted a userId and discarded it, and there was no delete path at all, so
-- undoing a mistaken link required raw SQL.
--
-- This migration makes the grant attributable in both directions:
--   created_by / created_at  — who attached the subsidiary, and when
--   deleted_at / deleted_by  — who withdrew it, and when
--
-- Removal is a SOFT delete precisely because the row IS the audit record. A hard
-- DELETE would erase the evidence of who granted the cross-tenant read in the
-- first place, which is the thing an auditor most needs to see after the fact.
-- Consequence: `deleted_at IS NULL` is load-bearing on every read of this table
-- (consolidationService.getGroupCompanies and getChildCompanyIds) — a read that
-- omits it keeps the revoked GL access alive.
--
-- All columns are nullable so the existing rows remain valid; `created_by` is
-- NULL for relationships created before this migration, which correctly reads as
-- "attribution unknown" rather than inventing an actor.
-- ============================================================================

BEGIN;

-- No FK to users(id): that column is VARCHAR(255), not UUID, so a UUID foreign
-- key would fail outright. This matches intercompany_eliminations.created_by and
-- company_groups.created_by, both bare UUID actor columns.
ALTER TABLE company_relationships
  ADD COLUMN IF NOT EXISTS created_by UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

COMMENT ON COLUMN company_relationships.created_by IS
  'User who attached this subsidiary. NULL for rows predating migration 532.';
COMMENT ON COLUMN company_relationships.deleted_at IS
  'Soft-delete marker. Every read of this table MUST filter deleted_at IS NULL — '
  'a live row grants the parent read access to the child''s general ledger.';
COMMENT ON COLUMN company_relationships.deleted_by IS
  'User who withdrew this subsidiary link.';

-- Both consolidated read paths filter on parent + deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_company_relationships_parent_active
  ON company_relationships (parent_company_id)
  WHERE deleted_at IS NULL;

COMMIT;
