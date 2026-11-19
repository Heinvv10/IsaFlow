/**
 * Generate an approved pay run's salary bank file (wave 6 BF): the ACB file of payrollAcbFile.ts, in memory, plus one
 * payroll_bank_files row and one audit_log `export` row (the file carries every employee's full account number).
 *
 * Every refusal is judged before the first write (spec rule 12), in this order: the platform switch
 * payroll_salary_bank_file (rule 20; off = FEATURE_DISABLED); the run (this company's, status 'approved': a 'paid' run
 * was paid already, BANK_HAS_PAID); the run-kind guard; the run's files (payrollBankFileJudge: paid, already made, or
 * an earlier file nobody has settled); the action date; the paying account; every employee (bank details unchanged
 * since approval, valid, net not below zero; nil net is left out and named); the lines against the approved totals;
 * the writer's own field rules. The one write after that is the insert, then the audit row.
 *
 * LOCKS. The run's advisory lock (payroll_bank_file:<run>) and the header FOR SHARE are taken inside
 * withBoundedLockWait's savepoint. A transaction-level lock survives the savepoint's RELEASE, so both hold to the end
 * of the REQUEST transaction: a second generate waits, then reads this one's committed row (FILE_EXISTS), and a reopen
 * waits for the header. If the request ever ran without an outer transaction, the lock would end with the savepoint;
 * the partial unique index still allows one live file, and its 23505 is answered as FILE_EXISTS.
 *
 * Audit cycle: each generate writes one `export` row (sha256, employees); each confirm or void one `update` row
 * (payrollBankFileConfirm), so a generate / void / generate cycle leaves a row per step.
 *
 * Nothing posts to the ledger: the payroll journal already credits the bank (or the net-pay clearing account) at
 * approval (payrollJournalBank.ts), and nothing here writes the run header.
 */
import { createHash } from 'crypto';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { withBoundedLockWait } from './payrollRunLock';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { ACB_LAYOUT, AcbFileInputError, buildAcbPaymentFile, type AcbFile } from './payrollAcbFile';
import { PayrollBankFileRefusal, SALARY_BANK_FILE_FLAG } from './payrollBankFileStatus';
import { judgeApprovedTotals, judgeExistingFiles, payingAccount, readPayments, type RunPayments } from './payrollBankFileJudge';

export interface BankFileActor {
  userId: string;
  userEmail?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
}

export interface GeneratedBankFile {
  id: string;
  filename: string;
  content: string;
  sha256: string;
  lineCount: number;
  totalCents: number;
  actionDate: string;
  warnings: string[];
}

/** The run's header, share-locked (a reopen waits for this request), and this request alone on the run's files. */
async function lockRun(companyId: string, runId: string): Promise<DbRow | null> {
  return withBoundedLockWait(runId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_bank_file:${runId}`}, 0))`;
    return ((await tx`
      SELECT id, period_year, period_month, status, COALESCE(approved_at, approval_grandfathered_at) AS final_at,
             pay_frequency, run_kind, off_cycle_reason, run_date, period_end
        FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       FOR SHARE
    `) as DbRow[])[0] ?? null;
  });
}

function judgeActionDate(actionDate: string): void {
  const real = /^\d{4}-\d{2}-\d{2}$/.test(actionDate) && !Number.isNaN(Date.parse(`${actionDate}T00:00:00Z`))
    && new Date(`${actionDate}T00:00:00Z`).toISOString().slice(0, 10) === actionDate;
  if (!real) throw new PayrollBankFileRefusal('INVALID_ACTION_DATE', 'The action date must be a real date (YYYY-MM-DD).');
  if (actionDate < todayInSast()) throw new PayrollBankFileRefusal('INVALID_ACTION_DATE', 'The action date cannot be in the past.');
}

/** The writer's field rules, mapped to whose field it was: the paying account, or the named employee. */
function build(from: Awaited<ReturnType<typeof payingAccount>>, actionDate: string, pay: RunPayments): AcbFile {
  try {
    return buildAcbPaymentFile({ from, actionDate, payments: pay.payments });
  } catch (err) {
    if (!(err instanceof AcbFileInputError)) throw err;
    if (err.owner.kind === 'from') {
      throw new PayrollBankFileRefusal('NO_PAYING_ACCOUNT', `The paying bank account: ${err.message}. Fix it on Bank Accounts.`);
    }
    const who = err.owner.kind === 'payment' ? `${pay.who[err.owner.index]}: ` : '';
    throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE', `${who}${err.message}`, [`${who}${err.message}`]);
  }
}

const isLiveFileClash = (err: unknown): boolean => (err as { code?: string; constraint?: string } | null)?.code === '23505'
  && (err as { constraint?: string }).constraint === 'payroll_bank_files_one_live_per_run';

export async function generateSalaryBankFile(opts: {
  companyId: string; runId: string; actionDate: string; actor: BankFileActor;
}): Promise<GeneratedBankFile> {
  const { companyId, runId, actionDate, actor } = opts;
  if (!(await hasFeature(companyId, SALARY_BANK_FILE_FLAG))) {
    throw new PayrollBankFileRefusal('FEATURE_DISABLED',
      'Salary bank files are not switched on yet: they stay off until a bank has accepted a test file.');
  }
  const run = await lockRun(companyId, runId);
  if (!run) throw new PayrollBankFileRefusal('NOT_FOUND', 'Payroll run not found');
  if (String(run.status) === 'paid') {
    throw new PayrollBankFileRefusal('BANK_HAS_PAID', 'This run is marked paid: its payments were issued. A bank file would pay everyone again.');
  }
  if (String(run.status) !== 'approved' || run.final_at == null) {
    throw new PayrollBankFileRefusal('NOT_FINAL', 'Only an approved pay run can be paid by bank file.');
  }
  await assertRunKindSupported(companyId, runId, 'bank_file');
  await judgeExistingFiles(companyId, runId);
  judgeActionDate(actionDate);
  const from = await payingAccount(companyId);
  const pay = await readPayments(companyId, runId);
  await judgeApprovedTotals(companyId, runId, run, pay.linesCents);
  const file = build(from, actionDate, pay);
  const sha256 = createHash('sha256').update(file.content, 'latin1').digest('hex');

  // The writes, all judged above. created_by is restamped by the table's trigger from the session user (999h).
  let id: string;
  try {
    id = await withSavepoint('payroll_bank_file_insert', async () => String(((await sql`
      INSERT INTO payroll_bank_files (company_id, run_id, format, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
      SELECT ${companyId}::uuid, h.id, 'acb', ${ACB_LAYOUT}, ${sha256}, ${file.lineCount}, ${file.totalCents},
             ${actionDate}::date, COALESCE(h.approved_at, h.approval_grandfathered_at), ${actor.userId}
        FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      RETURNING id
    `) as DbRow[])[0]!.id));
  } catch (err) {
    if (isLiveFileClash(err)) throw new PayrollBankFileRefusal('FILE_EXISTS', 'A salary bank file was just generated for this run by another request.');
    throw err;
  }
  // What the file pays each employee (999h payroll_bank_file_items; footed against the file at COMMIT).
  await sql`
    INSERT INTO payroll_bank_file_items (company_id, file_id, employee_id, amount_cents)
    SELECT ${companyId}::uuid, ${id}::uuid, t.employee_id, t.amount_cents
      FROM unnest(${pay.employeeIds}::uuid[], ${pay.payments.map((p) => String(p.amountCents))}::bigint[]) AS t(employee_id, amount_cents)
  `;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'export', entityType: 'payroll_bank_file', entityId: id,
    changes: { fields: [], metadata: { revealed: 'account_number', runId, sha256, employeeIds: pay.employeeIds.join(',') } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info('Salary bank file generated', { companyId, runId, fileId: id, lines: file.lineCount }, 'payroll-bank-file');

  const period = `${String(run.period_year)}-${String(run.period_month).padStart(2, '0')}`;
  return {
    id, filename: `salaries-${period}-${actionDate}.acb.txt`, content: file.content, sha256,
    lineCount: file.lineCount, totalCents: file.totalCents, actionDate, warnings: [...pay.warnings, ...file.warnings],
  };
}
