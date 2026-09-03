/**
 * Company Relationship Service
 *
 * Create/withdraw the direct parent-child links in `company_relationships` that
 * consolidationService reads. A row here is a cross-tenant READ GRANT: it makes
 * the child's whole general ledger visible in the parent's consolidated trial
 * balance, so both writes are attributable (created_by / deleted_by, migration
 * 531) and removal is a soft delete that preserves that attribution.
 *
 * Split out of consolidationService.ts to keep both files under the 300-line cap.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

/**
 * Adds or updates a parent-child company relationship.
 * Validates that child != parent (IDOR guard).
 */
export async function createCompanyRelationship(
  companyId: string,
  childCompanyId: string,
  ownershipPercent: number,
  userId: string,
  relationshipType: string = 'subsidiary',
): Promise<void> {
  if (companyId === childCompanyId) throw new Error('A company cannot be its own subsidiary');
  if (ownershipPercent < 0 || ownershipPercent > 100) throw new Error('ownershipPercent must be 0–100');

  try {
    // The UNIQUE(parent, child) constraint survives a soft delete, so re-linking
    // a previously removed subsidiary arrives here as a conflict. Clearing
    // deleted_at/deleted_by revives the row and re-attributes the new grant;
    // leaving them set would silently make the link a no-op for every reader.
    await sql`
      INSERT INTO company_relationships
        (parent_company_id, child_company_id, relationship_type, ownership_percent, created_by)
      VALUES
        (${companyId}::UUID, ${childCompanyId}::UUID, ${relationshipType}, ${ownershipPercent}, ${userId}::UUID)
      ON CONFLICT (parent_company_id, child_company_id)
      DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        ownership_percent = EXCLUDED.ownership_percent,
        created_by        = EXCLUDED.created_by,
        created_at        = CASE
          WHEN company_relationships.deleted_at IS NOT NULL THEN NOW()
          ELSE company_relationships.created_at
        END,
        deleted_at        = NULL,
        deleted_by        = NULL
    `;
    log.info('Company relationship created', { companyId, childCompanyId, ownershipPercent, userId }, 'consolidation');
  } catch (err) {
    log.error('createCompanyRelationship failed', { companyId, childCompanyId, error: err }, 'consolidation');
    throw err;
  }
}

/**
 * Withdraws a parent-child company relationship.
 *
 * SOFT delete: the row is the audit record of a cross-tenant read grant, so who
 * created it must survive the revocation (see migration 531). Every read of
 * company_relationships therefore filters `deleted_at IS NULL`.
 *
 * Authorisation is the `parent_company_id = ${companyId}` predicate. `companyId`
 * is the caller's authenticated company, so a caller can only withdraw grants
 * their own company made. Membership of the CHILD is deliberately not required:
 * removal only revokes access, and demanding child access to revoke would strand
 * a mistaken link forever.
 *
 * Returns false when no active relationship matched (already removed, or never
 * belonged to this parent) so the caller can 404 rather than report a phantom
 * success.
 */
export async function deleteCompanyRelationship(
  companyId: string,
  childCompanyId: string,
  userId: string,
): Promise<boolean> {
  if (companyId === childCompanyId) throw new Error('A company cannot be its own subsidiary');

  try {
    const rows = (await sql`
      UPDATE company_relationships
      SET deleted_at = NOW(),
          deleted_by = ${userId}::UUID
      WHERE parent_company_id = ${companyId}::UUID
        AND child_company_id  = ${childCompanyId}::UUID
        AND deleted_at IS NULL
      RETURNING id
    `) as Row[];

    const removed = rows.length > 0;
    log.info('Company relationship removal', { companyId, childCompanyId, userId, removed }, 'consolidation');
    return removed;
  } catch (err) {
    log.error('deleteCompanyRelationship failed', { companyId, childCompanyId, error: err }, 'consolidation');
    throw err;
  }
}
