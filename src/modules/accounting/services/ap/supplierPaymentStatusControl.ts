import { withSavepoint } from '@/lib/neon';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { requireApControl } from './apControlBoundary';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';

/** Draft approval changes workflow status only; financial processing has its separate operation gate. */
export async function recordPaymentStatusApproval<T>(companyId: string, id: string, userId: string, effect: () => Promise<T>): Promise<T> {
  const ctx = requireApControl(companyId, userId);
  await assertEffectivePermission(ctx, 'write:invoices');
  return withSavepoint('ap_payment_status_approval', async () => {
    const [before] = await ctx.sql`SELECT *,payment_date::text AS accounting_date FROM supplier_payments
      WHERE company_id=${companyId}::uuid AND id=${id}::uuid FOR UPDATE` as Record<string, unknown>[];
    if (!before) throw new Error('Supplier payment not found');
    const tracked = await readControlEntityVersion(ctx, { entityType: 'supplier_payment', entityId: id });
    let version = tracked?.version ?? 0;
    if (!tracked) {
      await recordCommittedChange(ctx, { entityType: 'supplier_payment', entityId: id, previousVersion: null,
        newVersion: 1, action: 'baseline_observed', accountingDate: String(before.accounting_date),
        before: null, after: before, bindingHash: null, protectedEvidenceRef: null });
      version = 1;
    }
    const result = await effect();
    const [after] = await ctx.sql`SELECT * FROM supplier_payments WHERE company_id=${companyId}::uuid AND id=${id}::uuid` as Record<string, unknown>[];
    if (!after) throw new Error('Supplier payment changed concurrently');
    await recordCommittedChange(ctx, { entityType: 'supplier_payment', entityId: id, previousVersion: version,
      newVersion: version + 1, action: 'status_approved', accountingDate: String(before.accounting_date),
      before, after, bindingHash: null, protectedEvidenceRef: null });
    return result;
  });
}
