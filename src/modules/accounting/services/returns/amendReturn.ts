/**
 * Amend a finalised or filed return (wave 5 L1b): the version becomes superseded with who, when and why, and a VAT201's
 * lock (that version's own, by id) is released so the period accepts postings again. The next finalise creates version
 * N+1 linked to it; its filing is a new submission. Owner/admin only, a reason is mandatory, Login-as is refused
 * (decision 4). The refusals land before the first write; the supersede and the unlock share one savepoint.
 */
import { withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { takeVatLockExclusive } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { unlockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { assertMayActOnReturns, visibleText } from './returnGuards';
import { getVersionForUpdate, isLockActive, markVersionSuperseded, peekForm } from './returnVersionWrites';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnActor, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

export async function amendReturn(
  companyId: string, form: ReturnForm, versionId: string, reason: string, actor: ReturnActor,
): Promise<ReturnVersion> {
  await assertNotImpersonating(); // R-032
  assertMayActOnReturns(actor.role, 'amend');
  const why = visibleText(reason, 'A reason to amend a return');
  // The VAT key before the row lock, as a lock or an unlock takes them: no post lands mid-amend.
  if (form === 'VAT201' && await peekForm(companyId, versionId) === 'VAT201') await takeVatLockExclusive(companyId);
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== form) throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status === 'superseded') throw new ReturnRefusal(409, `Version ${v.versionNo} was already amended.`, STALE_RETURN_REFUSAL.ALREADY_AMENDED);
  const lockId = v.formType === 'VAT201' && v.vatPeriodLockId && await isLockActive(companyId, v.vatPeriodLockId)
    ? v.vatPeriodLockId : null;
  return withSavepoint('amend_return', async () => {
    const superseded = await markVersionSuperseded(companyId, v.id, actor.userId, why);
    if (lockId) await unlockVatPeriod(companyId, lockId, actor.userId, `Amend of ${v.formType} version ${v.versionNo}: ${why}`);
    await logAuditOrThrow({
      companyId, userId: actor.userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
      entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
      changes: {
        fields: [{ field: 'status', old: v.status, new: 'superseded', label: 'Status' }],
        metadata: { reason: why, unlockedLock: lockId ?? 'none' },
      },
    });
    return superseded;
  });
}
