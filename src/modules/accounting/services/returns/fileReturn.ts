/**
 * Mark a finalised return filed (wave 5 L1b). Everything is judged before the first write; then ONE savepoint
 * holds the submission row, the VAT gate (VAT201 only) and its override record, markSubmitted and the version's move
 * to filed, so a refusal leaves no submission, no override row and no version change even though withAuth commits a 4xx.
 * The submission is the company's open draft for the period (replaced with the version's recorded figures) or a new
 * one; after it is marked submitted the next filing of the period (an amended version) gets a new row.
 */
import { withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { markSubmitted, saveDraftSubmission, type SARSSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { getVersionForUpdate, isLockActive, markVersionFiled } from './returnVersionWrites';
import { ReturnRefusal, type ReturnActor, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

export interface FiledReturn {
  version: ReturnVersion;
  submission: SARSSubmission;
}

export async function markReturnFiled(
  companyId: string, form: ReturnForm, versionId: string, reference: string, actor: ReturnActor, overrideReason?: string,
): Promise<FiledReturn> {
  await assertNotImpersonating(); // R-032: a filing is refused to a Login-as session
  const ref = reference.trim();
  if (!ref) throw new ReturnRefusal(400, 'A filing reference is required.');
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== form) throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status !== 'finalised') {
    throw new ReturnRefusal(409, v.status === 'filed'
      ? `Version ${v.versionNo} is already filed (${v.filedReference ?? 'no reference'}). Amend it to file a correction.`
      : `Version ${v.versionNo} was superseded by an amend. File the current version.`);
  }
  if (v.formType === 'VAT201' && !(v.vatPeriodLockId && await isLockActive(companyId, v.vatPeriodLockId))) {
    throw new ReturnRefusal(409,
      'The VAT period lock of this version was removed outside the return lifecycle. Amend the return, then finalise again.');
  }
  return withSavepoint('file_return', async () => {
    const draft = await saveDraftSubmission(
      companyId, v.formType, v.periodStart, v.periodEnd,
      { returnVersionId: v.id, versionNo: v.versionNo, figures: v.figures }, actor.userId,
    );
    if (v.formType === 'VAT201') {
      await assertVatGateClear(
        companyId, v.periodStart, v.periodEnd, 'sars_submission', draft.id,
        { userId: actor.userId, role: actor.role }, overrideReason,
      );
    }
    const submission = await markSubmitted(companyId, draft.id, ref);
    const version = await markVersionFiled(companyId, v.id, submission.id, ref, actor.userId);
    return { version, submission };
  });
}
