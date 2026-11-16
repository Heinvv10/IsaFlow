/**
 * Generate a final pay run's salary bank file (wave 6 BF): the ACB file of payrollAcbFile.ts, in memory, plus one
 * payroll_bank_files row and one audit_log `export` row (the file carries every employee's full account number).
 *
 * Every refusal is judged before the first write (spec rule 12), in this order: the platform switch
 * payroll_salary_bank_file (rule 20; off = FEATURE_DISABLED), the run (this company's, final), the run-kind guard
 * (this release pays monthly regular runs only), the run's files (a confirmed one = the bank has paid; a current
 * generated one = already made), the action date, the paying account (the company's bank role holder, as the payroll
 * journal credits), and every employee on the run (active bank details that pass validateBankAccount, a positive net).
 * Only then: a stale generated file (its approval ended at a reopen) is voided, and the new file recorded.
 *
 * Nothing posts to the ledger: the payroll journal already credits the bank (or the net-pay clearing account) at
 * approval (payrollJournalBank.ts), and nothing here writes the run header.
 */
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { validateBankAccount } from '@/modules/accounting/services/ap/eftService';
import { resolveBankRoleHolder } from '@/modules/accounting/services/gl/bankRoleHolder';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { withBoundedLockWait } from './payrollRunLock';
import { assertRunKindSupported } from './payrollRunKindGuard';
import { ACB_LAYOUT, AcbFileInputError, buildAcbPaymentFile, type AcbAccountType, type AcbPayment } from './payrollAcbFile';
import { PayrollBankFileRefusal, SALARY_BANK_FILE_FLAG } from './payrollBankFileStatus';

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

const ACB_TYPES: ReadonlySet<string> = new Set<AcbAccountType>(['cheque', 'savings', 'transmission']);

/** The run's header, share-locked (a reopen waits for this request), and this request alone on the run's files. */
async function lockRun(companyId: string, runId: string): Promise<DbRow | null> {
  return withBoundedLockWait(runId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_bank_file:${runId}`}, 0))`;
    return ((await tx`
      SELECT id, period_year, period_month, status, COALESCE(approved_at, approval_grandfathered_at) AS final_at
        FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       FOR SHARE
    `) as DbRow[])[0] ?? null;
  });
}

/**
 * Judge the run's existing files; returns the ids of stale generated files to void. Compared in SQL: run_approved_at
 * keeps the header's microseconds, which a JavaScript Date would drop.
 */
async function judgeExistingFiles(companyId: string, runId: string): Promise<string[]> {
  const live = (await sql`
    SELECT f.id, f.status, f.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at) AS current
      FROM payroll_bank_files f JOIN payroll_run_headers h ON h.id = f.run_id AND h.company_id = f.company_id
     WHERE f.company_id = ${companyId}::uuid AND f.run_id = ${runId}::uuid AND f.status IN ('generated', 'confirmed')
  `) as DbRow[];
  if (live.some((f) => f.status === 'confirmed')) {
    throw new PayrollBankFileRefusal('BANK_HAS_PAID',
      'The bank has paid this run: its salary bank file was confirmed. A second file would pay everyone again; pay any difference separately.');
  }
  if (live.some((f) => f.current === true)) {
    throw new PayrollBankFileRefusal('FILE_EXISTS', 'A salary bank file was already generated for this run. Void it before generating another.');
  }
  return live.map((f) => String(f.id));
}

async function payingAccount(companyId: string): Promise<{ branchCode: string; accountNumber: string }> {
  const holder = await resolveBankRoleHolder(companyId);
  if (!holder.account) throw new PayrollBankFileRefusal('NO_PAYING_ACCOUNT', holder.refusal.detail);
  const row = ((await sql`
    SELECT account_code, account_name, bank_account_number, bank_branch_code FROM gl_accounts
     WHERE id = ${holder.account.id}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  const accountNumber = String(row?.bank_account_number ?? '').replace(/[\s-]/g, '');
  const branchCode = String(row?.bank_branch_code ?? '').replace(/[\s-]/g, '');
  const valid = validateBankAccount(accountNumber, branchCode);
  if (!valid.valid) {
    throw new PayrollBankFileRefusal('NO_PAYING_ACCOUNT',
      `The paying bank account ${holder.account.code} ${holder.account.name}: ${valid.error}. Set its account number and branch code on Bank Accounts.`);
  }
  return { branchCode, accountNumber };
}

async function payments(companyId: string, runId: string): Promise<{ payments: AcbPayment[]; employeeIds: string[] }> {
  const rows = (await sql`
    SELECT l.employee_id, e.employee_number, e.first_name, e.last_name, round(l.net_pay * 100)::bigint::text AS net_cents,
           d.account_number, d.branch_code, d.account_type, d.account_holder,
           COALESCE(NULLIF(c.trading_name, ''), c.name) AS company_name
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
      JOIN companies c ON c.id = h.company_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
      LEFT JOIN payroll_bank_details d ON d.employee_id = e.id AND d.company_id = h.company_id AND d.is_active
     WHERE l.run_id = ${runId}::uuid
     ORDER BY e.employee_number, l.employee_id
  `) as DbRow[];
  if (rows.length === 0) throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE', 'This run has no employees to pay.');
  const problems: string[] = [];
  for (const r of rows) {
    const who = String(r.employee_number);
    if (r.account_number == null) { problems.push(`${who}: no active bank details`); continue; }
    const valid = validateBankAccount(String(r.account_number), String(r.branch_code ?? ''));
    if (!valid.valid) problems.push(`${who}: ${valid.error}`);
    if (!ACB_TYPES.has(String(r.account_type))) problems.push(`${who}: account type '${String(r.account_type)}' cannot be paid by bank file`);
    if (!(Number(r.net_cents) > 0)) problems.push(`${who}: net pay is not above zero`);
  }
  if (problems.length > 0) {
    throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE',
      `Employees on this run cannot be paid by bank file: ${problems.join('; ')}.`, problems);
  }
  return {
    employeeIds: rows.map((r) => String(r.employee_id)),
    payments: rows.map((r) => ({
      branchCode: String(r.branch_code), accountNumber: String(r.account_number), accountType: r.account_type as AcbAccountType,
      amountCents: Number(r.net_cents), reference: String(r.company_name),
      accountName: String(r.account_holder || `${String(r.first_name)} ${String(r.last_name)}`),
    })),
  };
}

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
  if (!['approved', 'paid'].includes(String(run.status)) || run.final_at == null) {
    throw new PayrollBankFileRefusal('NOT_FINAL', 'Only an approved pay run can be paid by bank file.');
  }
  await assertRunKindSupported(companyId, runId, 'bank_file');
  const staleIds = await judgeExistingFiles(companyId, runId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(actionDate) || Number.isNaN(Date.parse(`${actionDate}T00:00:00Z`))
    || new Date(`${actionDate}T00:00:00Z`).toISOString().slice(0, 10) !== actionDate) {
    throw new PayrollBankFileRefusal('INVALID_ACTION_DATE', 'The action date must be a date (YYYY-MM-DD).');
  }
  if (actionDate < todayInSast()) throw new PayrollBankFileRefusal('INVALID_ACTION_DATE', 'The action date cannot be in the past.');
  const from = await payingAccount(companyId);
  const pay = await payments(companyId, runId);

  let file;
  try {
    file = buildAcbPaymentFile({ from, actionDate, payments: pay.payments });
  } catch (err) {
    if (err instanceof AcbFileInputError) throw new PayrollBankFileRefusal('EMPLOYEES_NOT_PAYABLE', err.message, [err.message]);
    throw err;
  }
  const sha256 = createHash('sha256').update(file.content, 'latin1').digest('hex');

  // Writes, all judged above.
  if (staleIds.length > 0) {
    await sql`
      UPDATE payroll_bank_files SET status = 'voided', voided_by = ${actor.userId}, voided_at = now()
       WHERE company_id = ${companyId}::uuid AND id = ANY(${staleIds}::uuid[]) AND status = 'generated'
    `;
  }
  const id = String(((await sql`
    INSERT INTO payroll_bank_files (company_id, run_id, format, layout, sha256, line_count, total_cents, action_date, run_approved_at, created_by)
    SELECT ${companyId}::uuid, h.id, 'acb', ${ACB_LAYOUT}, ${sha256}, ${file.lineCount}, ${file.totalCents},
           ${actionDate}::date, COALESCE(h.approved_at, h.approval_grandfathered_at), ${actor.userId}
      FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    RETURNING id
  `) as DbRow[])[0]!.id);
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'export', entityType: 'payroll_bank_file', entityId: id,
    changes: { fields: [], metadata: { revealed: 'account_number', runId, sha256, voided: staleIds.join(','), employeeIds: pay.employeeIds.join(',') } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info('Salary bank file generated', { companyId, runId, fileId: id, lines: file.lineCount, voided: staleIds.length }, 'payroll-bank-file');

  const period = `${String(run.period_year)}-${String(run.period_month).padStart(2, '0')}`;
  return {
    id, filename: `salaries-${period}-${actionDate}.acb.txt`, content: file.content, sha256,
    lineCount: file.lineCount, totalCents: file.totalCents, actionDate, warnings: file.warnings,
  };
}
