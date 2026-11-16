/**
 * Confirm or void a salary bank file (wave 6 BF). Both write only payroll_bank_files (and one audit_log row), never
 * the run header: confirm records the bank's acceptance ("payment confirmed"), and the run stays `approved` and
 * reopenable (spec 0a.17). Every refusal is judged before the write (rule 12).
 *   confirm  a generated file whose approval is still the run's (not stale). A stale file pays an approval that a
 *            reopen ended: it is voided, never confirmed.
 *   void     a generated file, stale or not. A confirmed file is final: the bank has paid it.
 * Not behind the platform switch: neither moves money, and a file generated before the switch went off must still be
 * closable.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { withBoundedLockWait } from './payrollRunLock';
import { PayrollBankFileRefusal, type BankFileStatus } from './payrollBankFileStatus';
import type { BankFileActor } from './payrollBankFileService';

export type BankFileAction = 'confirm' | 'void';

export async function settleBankFile(opts: {
  companyId: string; runId: string; fileId: string; action: BankFileAction; actor: BankFileActor;
}): Promise<{ id: string; status: BankFileStatus }> {
  const { companyId, runId, fileId, action, actor } = opts;
  const file = await withBoundedLockWait(runId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_bank_file:${runId}`}, 0))`;
    return ((await tx`
      SELECT f.id, f.status,
             (h.status IN ('approved', 'paid') AND f.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at)) AS current
        FROM payroll_bank_files f
        JOIN payroll_run_headers h ON h.id = f.run_id AND h.company_id = f.company_id
       WHERE f.id = ${fileId}::uuid AND f.run_id = ${runId}::uuid AND f.company_id = ${companyId}::uuid
       FOR UPDATE OF f
    `) as DbRow[])[0] ?? null;
  });
  if (!file) throw new PayrollBankFileRefusal('NOT_FOUND', 'Bank file not found');
  if (file.status !== 'generated') {
    throw new PayrollBankFileRefusal('NOT_GENERATED', `This bank file is already ${String(file.status)}; only a generated file can be ${action === 'confirm' ? 'confirmed' : 'voided'}.`);
  }
  if (action === 'confirm' && file.current !== true) {
    throw new PayrollBankFileRefusal('STALE',
      'The run was reopened after this file was made, so it pays figures that are no longer approved. Void it and generate a new one.');
  }

  const status: BankFileStatus = action === 'confirm' ? 'confirmed' : 'voided';
  if (action === 'confirm') {
    await sql`UPDATE payroll_bank_files SET status = 'confirmed', confirmed_by = ${actor.userId}, confirmed_at = now()
               WHERE id = ${fileId}::uuid AND company_id = ${companyId}::uuid AND status = 'generated'`;
  } else {
    await sql`UPDATE payroll_bank_files SET status = 'voided', voided_by = ${actor.userId}, voided_at = now()
               WHERE id = ${fileId}::uuid AND company_id = ${companyId}::uuid AND status = 'generated'`;
  }
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_bank_file', entityId: fileId,
    changes: { fields: [{ field: 'status', old: 'generated', new: status, label: 'Status' }], metadata: { runId } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info(`Salary bank file ${status}`, { companyId, runId, fileId }, 'payroll-bank-file');
  return { id: fileId, status };
}
