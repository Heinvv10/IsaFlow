/**
 * Mark a finalised return filed (wave 5 L1b). Everything is judged before the first write; then ONE savepoint
 * holds the submission row, the VAT gate (VAT201 only) and its override record, markSubmitted, the version's move to
 * filed and the audit row, so a refusal leaves no submission, no override row and no version change even though
 * withAuth commits a 4xx. Owner/admin only; a version that has drifted from the ledger or payroll is refused (amend it
 * first). The submission is the company's open draft for the period or a new one; its form_data is ALWAYS the version's
 * figures plus returnVersionId/versionNo (a draft the page saved is kept under `pageDraft`), so the filed submission and the
 * filed version agree. A draft with an in-flight ISV submit (efiling_correlation_id) is refused. After it is marked submitted the next filing of the period (an amended
 * version) gets a new row.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { markSubmitted, saveDraftSubmission, type SARSSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { driftOf } from './returnDrift';
import { assertMayActOnReturns, visibleText } from './returnGuards';
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
  assertMayActOnReturns(actor.role, 'file');
  const ref = visibleText(reference, 'A filing reference');
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
  const drift = await driftOf(companyId, v);
  if (drift.drifted) {
    const what = [...drift.fields.map((f) => f.name), ...drift.changed, ...(drift.unfinalRuns > 0 ? ['unfinalRuns'] : [])];
    throw new ReturnRefusal(409,
      `Version ${v.versionNo} no longer matches the ledger or payroll (${what.join(', ')}). Amend it and finalise again before filing.`);
  }
  return withSavepoint('file_return', async () => {
    const draft = await saveDraftSubmission(
      companyId, v.formType, v.periodStart, v.periodEnd,
      { ...v.figures, returnVersionId: v.id, versionNo: v.versionNo }, actor.userId, { keepExistingAs: 'pageDraft' },
    );
    const inFlight = (await sql`SELECT efiling_correlation_id FROM sars_submissions WHERE id = ${draft.id}::UUID`) as DbRow[];
    if (inFlight[0]?.efiling_correlation_id != null) {
      throw new ReturnRefusal(409, 'The open draft for this period has an eFiling submission in flight. Let it finish or clear it first.');
    }
    if (v.formType === 'VAT201') {
      await assertVatGateClear(
        companyId, v.periodStart, v.periodEnd, 'sars_submission', draft.id,
        { userId: actor.userId, role: actor.role }, overrideReason,
      );
    }
    const submission = await markSubmitted(companyId, draft.id, ref, { lifecycle: true });
    const version = await markVersionFiled(companyId, v.id, submission.id, ref, actor.userId);
    await logAuditOrThrow({
      companyId, userId: actor.userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
      entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
      changes: {
        fields: [{ field: 'status', old: 'finalised', new: 'filed', label: 'Status' }],
        metadata: { reference: ref, submissionId: submission.id, ...(overrideReason ? { vatGateOverridden: 'yes' } : {}) },
      },
    });
    return { version, submission };
  });
}
