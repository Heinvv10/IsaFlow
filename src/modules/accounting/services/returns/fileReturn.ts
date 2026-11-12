/**
 * Mark a finalised return filed (wave 5 L1b). Everything is judged before the first write; then ONE savepoint
 * holds the submission row, the VAT gate (VAT201 only) and its override record, markSubmitted, the version's move to
 * filed and the audit row, so a refusal leaves no submission, no override row and no version change even though
 * withAuth commits a 4xx. Owner/admin only; a version that has drifted from the ledger or payroll is refused (amend it
 * first). The submission is the company's open draft for the period or a new one; its form_data is ALWAYS the version's
 * figures plus returnVersionId/versionNo (a draft the page saved is kept under `pageDraft`), so the filed submission and the
 * filed version agree. A send to SARS that may have reached it is refused (409 SEND_UNCERTAIN, periodSendUncertain: a correlation id on the
 * draft, or an intent with no result among its events). After it is marked submitted the next filing of the period (an
 * amended version) gets a new row.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { markSubmitted, saveDraftSubmission, type SARSSubmission } from '@/modules/accounting/services/reports/sarsComplianceService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import { periodSendUncertain } from '@/modules/accounting/services/reports/sarsEfilingRepo';
import { driftOf } from './returnDrift';
import { assertMayActOnReturns, visibleText } from './returnGuards';
import { getVersionForUpdate, isLockActive, markVersionFiled } from './returnVersionWrites';
import { ReturnRefusal, STALE_RETURN_REFUSAL, type ReturnActor, type ReturnForm, type ReturnVersion } from './returnVersionTypes';

export interface FiledReturn {
  version: ReturnVersion;
  submission: SARSSubmission;
}

export interface FileOptions {
  /** VAT201: owner/admin override of blocking VAT exceptions, with a reason. */
  overrideReason?: string;
  /** EVERY legacy submission of the period this filing corrects (see LEGACY_SUBMISSION_EXISTS), with the reason. */
  correctsLegacySubmissionIds?: string[];
  reason?: string;
}

interface LegacySubmission { id: string; status: string; reference: string | null }

/** Submissions of the period filed the legacy way (no version names them), newest first, row-locked. */
async function legacySubmissions(companyId: string, v: ReturnVersion): Promise<LegacySubmission[]> {
  const rows = (await sql`
    SELECT s.id, s.status, s.submission_reference FROM sars_submissions s
    WHERE s.company_id = ${companyId}::UUID AND s.form_type = ${v.formType} AND s.status IN ('submitted', 'accepted')
      AND s.period_start <= ${v.periodEnd}::DATE AND s.period_end >= ${v.periodStart}::DATE
      AND NOT EXISTS (SELECT 1 FROM tax_return_versions t WHERE t.sars_submission_id = s.id)
    ORDER BY s.submitted_at DESC NULLS LAST, s.id DESC
    FOR UPDATE OF s
  `) as DbRow[];
  return rows.map((r) => ({ id: String(r.id), status: String(r.status), reference: r.submission_reference == null ? null : String(r.submission_reference) }));
}

export async function markReturnFiled(
  companyId: string, form: ReturnForm, versionId: string, reference: string, actor: ReturnActor, opts: FileOptions = {},
): Promise<FiledReturn> {
  const { overrideReason } = opts;
  await assertNotImpersonating(); // R-032: a filing is refused to a Login-as session
  assertMayActOnReturns(actor.role, 'file');
  const ref = visibleText(reference, 'A filing reference');
  const v = await getVersionForUpdate(companyId, versionId);
  if (!v || v.formType !== form) throw new ReturnRefusal(404, 'Return version not found.');
  if (v.status !== 'finalised') {
    throw new ReturnRefusal(409, v.status === 'filed'
      ? `Version ${v.versionNo} is already filed (${v.filedReference ?? 'no reference'}). Amend it to file a correction.`
      : `Version ${v.versionNo} was superseded by an amend. File the current version.`,
    v.status === 'filed' ? STALE_RETURN_REFUSAL.ALREADY_FILED : STALE_RETURN_REFUSAL.VERSION_SUPERSEDED);
  }
  if (v.formType === 'VAT201' && !(v.vatPeriodLockId && await isLockActive(companyId, v.vatPeriodLockId))) {
    throw new ReturnRefusal(409,
      'The VAT period lock of this version was removed outside the return lifecycle. Amend the return, then finalise again.');
  }
  // EMP201: the drift check and the commit must see ONE payroll state, so take the approval lock first (as an approval
  // and a reopen do): an approval or reopen in flight finishes before the drift is read, a later one waits for this commit.
  if (v.formType === 'EMP201') await lockCompanyPayrollApprovals(null, companyId);
  // A send to SARS that may have reached it (a correlation id on the draft, or an intent with no result): never filed over.
  const doubt = await periodSendUncertain(companyId, v.formType, v.periodStart, v.periodEnd);
  if (doubt) {
    throw new ReturnRefusal(409, 'A send to SARS for this period may have reached it'
      + `${doubt.correlationId ? ` (correlation id ${doubt.correlationId})` : ''}: poll or reconcile it before filing.`, 'SEND_UNCERTAIN');
  }
  const drift = await driftOf(companyId, v);
  if (drift.drifted) {
    const what = [...drift.fields.map((f) => f.name), ...drift.changed, ...(drift.unfinalRuns > 0 ? ['unfinalRuns'] : [])];
    throw new ReturnRefusal(409,
      `Version ${v.versionNo} no longer matches the ledger or payroll (${what.join(', ')}). Amend it and finalise again before filing.`);
  }
  const legacy = await legacySubmissions(companyId, v);
  let correction: string | null = null;
  if (legacy.length > 0) {
    const named = legacy.map((l) => `${l.id} (${l.status}, reference ${l.reference ?? 'none'})`).join('; ');
    const given = new Set(opts.correctsLegacySubmissionIds ?? []);
    if (given.size !== legacy.length || !legacy.every((l) => given.has(l.id))) {
      throw new ReturnRefusal(409,
        `This period was already filed outside the return lifecycle: ${named}. Filing this version supersedes all of `
        + 'them: confirm and give the reason.', 'LEGACY_SUBMISSION_EXISTS', { legacySubmissionIds: legacy.map((l) => l.id) });
    }
    correction = visibleText(opts.reason ?? '', 'A reason for correcting the legacy filing');
  }
  return withSavepoint('file_return', async () => {
    const draft = await saveDraftSubmission(
      companyId, v.formType, v.periodStart, v.periodEnd,
      { ...v.figures, returnVersionId: v.id, versionNo: v.versionNo }, actor.userId, { keepExistingAs: 'pageDraft' },
    );
    if (v.formType === 'VAT201') {
      await assertVatGateClear(
        companyId, v.periodStart, v.periodEnd, 'sars_submission', draft.id,
        { userId: actor.userId, role: actor.role }, overrideReason,
      );
    }
    // The lifecycle flag the sars_submissions trigger wants for a period that has a version (971).
    await sql`SELECT set_config('app.return_lifecycle', 'on', true)`;
    if (correction) {
      for (const l of legacy) {
        await sql`UPDATE sars_submissions SET status = 'superseded', updated_at = NOW(),
            notes = COALESCE(notes || E'\n', '') || ${`Superseded by return version ${v.versionNo} (${v.id}): ${correction}`}
          WHERE id = ${l.id}::UUID AND company_id = ${companyId}::UUID`;
      }
    }
    const submission = await markSubmitted(companyId, draft.id, ref, { lifecycle: true });
    await sql`SELECT set_config('app.return_lifecycle', 'off', true)`;
    const version = await markVersionFiled(companyId, v.id, submission.id, ref, actor.userId);
    await logAuditOrThrow({
      companyId, userId: actor.userId, action: 'update', entityType: 'tax_return_version', entityId: v.id,
      entityRef: `${v.formType} ${v.periodStart} to ${v.periodEnd} v${v.versionNo}`,
      changes: {
        fields: [{ field: 'status', old: 'finalised', new: 'filed', label: 'Status' }],
        metadata: {
          reference: ref, submissionId: submission.id, ...(overrideReason ? { vatGateOverridden: 'yes' } : {}),
          ...(correction ? { supersededLegacySubmissions: legacy.map((l) => l.id).join(','), correctionReason: correction } : {}),
        },
      },
    });
    return { version, submission };
  });
}
