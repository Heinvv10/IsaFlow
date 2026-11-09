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
import { getVersionForUpdate, isLockActive, markVersionSuperseded, peekForm } from './returnVersionWrites';
import { ReturnRefusal, type ReturnActor, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

const AMEND_ROLES: readonly string[] = ['owner', 'admin', 'super_admin'];

export async function amendReturn(
  companyId: string, form: ReturnForm, versionId: string, reason: string, actor: ReturnActor,
): Promise<ReturnVersion> {
  await assertNotImpersonating(); // R-032
  if (!AMEND_ROLES.includes(actor.role)) throw new ReturnRefusal(403, 'Only an owner or admin can amend a return.');
  const why = reason.trim();
  if (!why) throw new ReturnRefusal(400, 'A reason is required to amend a return.');
  // The VAT key before the row lock, as a lock or an unlock takes them: no post lands mid-amend.
  if (form === 'VAT201' && await peekForm(companyId, versionId) === 'VAT201') await takeVatLockExclusive(companyId);
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== form) throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status === 'superseded') throw new ReturnRefusal(409, `Version ${v.versionNo} was already amended.`);
  const lockId = v.formType === 'VAT201' && v.vatPeriodLockId && await isLockActive(companyId, v.vatPeriodLockId)
    ? v.vatPeriodLockId : null;
  return withSavepoint('amend_return', async () => {
    const superseded = await markVersionSuperseded(companyId, v.id, actor.userId, why);
    if (lockId) await unlockVatPeriod(companyId, lockId, actor.userId, `Amend of ${v.formType} version ${v.versionNo}: ${why}`);
    return superseded;
  });
}
