/**
 * Revealing one change's masked values (Hein's decision 2, 2026-10-10): owner
 * / admin only — the route checks the role, RLS binds the tenant — and every
 * reveal is recorded in audit_log (`export`, entity_type `entity_change`) in
 * the same transaction, so the values cannot be read without the record.
 * A change with nothing masked is returned without a record.
 */
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { isSensitive } from './entityChangeMasking';
import { selectEntityChanges, toView } from './entityChangeQuery';
import { ENTITY_TYPES, type EntityChangeView } from './entityChangeTypes';

export interface RevealActor {
  userId: string;
  userEmail?: string;
  ip?: string;
  userAgent?: string;
}

/** The change in full, or null when this company has no such change. */
export async function revealEntityChange(companyId: string, changeId: string, actor: RevealActor): Promise<EntityChangeView | null> {
  const [row] = await selectEntityChanges(companyId, { types: ENTITY_TYPES, changeId, limit: 1 });
  if (!row) return null;
  const revealed = row.changed.filter((key) => isSensitive(row.entity_type, key));
  if (revealed.length > 0) {
    await logAuditOrThrow({
      companyId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: 'export',
      entityType: 'entity_change',
      entityId: row.id,
      entityRef: row.entity_type,
      changes: {
        fields: [],
        metadata: { revealed: revealed.join(','), entityType: row.entity_type, entityId: row.entity_id },
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }
  return toView(row, true);
}
