/**
 * Confirm or void a salary bank file (wave 6 BF). Both write only payroll_bank_files (and one audit_log row), never
 * the run header: confirm records the bank's acceptance ("payment confirmed"), and the run stays `approved` and
 * reopenable (spec 0a.17). Every refusal is judged before the write (rule 12).
 *   confirm  a generated file, current or stale. A stale file (its approval ended at a reopen) may still have been
 *            uploaded and paid: confirming records that, and then no new file can be made (BANK_HAS_PAID). The table
 *            refuses a confirm for an approval the run never had (999h).
 *   void     a generated file, with the person's attestation that it was NOT sent to the bank (void_not_sent; 400
 *            NOT_SENT_REQUIRED without it). A voided file is dead: it must never be uploaded. A confirmed file is final.
 * Separation of duties: the person who generated a file may confirm it. Deliberate: confirm moves no money, it records
 * what the bank already did; the money control is the run's approval (R-035) and the upload at the bank.
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
  companyId: string; runId: string; fileId: string; action: BankFileAction; actor: BankFileActor; notSentToBank?: boolean;
}): Promise<{ id: string; status: BankFileStatus }> {
  const { companyId, runId, fileId, action, actor } = opts;
  if (action === 'void' && opts.notSentToBank !== true) {
    throw new PayrollBankFileRefusal('NOT_SENT_REQUIRED', 'Void a bank file only by confirming it was not sent to the bank.');
  }
  const file = await withBoundedLockWait(runId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_bank_file:${runId}`}, 0))`;
    return ((await tx`
      SELECT f.id, f.status
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

  const status: BankFileStatus = action === 'confirm' ? 'confirmed' : 'voided';
  if (action === 'confirm') {
    await sql`UPDATE payroll_bank_files SET status = 'confirmed', confirmed_by = ${actor.userId}, confirmed_at = now()
               WHERE id = ${fileId}::uuid AND company_id = ${companyId}::uuid AND status = 'generated'`;
  } else {
    await sql`UPDATE payroll_bank_files SET status = 'voided', voided_by = ${actor.userId}, voided_at = now(), void_not_sent = true
               WHERE id = ${fileId}::uuid AND company_id = ${companyId}::uuid AND status = 'generated'`;
  }
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_bank_file', entityId: fileId,
    changes: { fields: [{ field: 'status', old: 'generated', new: status, label: 'Status' }], metadata: { runId, ...(action === 'void' ? { notSentToBank: 'attested' } : {}) } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info(`Salary bank file ${status}`, { companyId, runId, fileId }, 'payroll-bank-file');
  return { id: fileId, status };
}
