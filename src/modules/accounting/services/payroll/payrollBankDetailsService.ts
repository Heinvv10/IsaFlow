/**
 * An employee's bank details (wave 3 K1, migration 952): one active row per
 * employee; a change deactivates that row and inserts the next, so every
 * account the company ever held for them stays on file. The database records
 * who did it (888's capture, entity type payroll_bank_detail).
 *
 * Who: anyone in withPayrollDetailAccess's roles makes the FIRST entry (Hein's
 * decision 14), but a manager only for an employee never in an approved run
 * (Hein's ruling on D1, 2026-11-02: FIRST_ENTRY_REQUIRES_ADMIN); a change to
 * existing details is owner / admin only. Both are decided here under the
 * employee row lock; a manager's call first takes the company payroll-approval
 * lock, which makes the first-entry verdict and payroll approval one order (an
 * owner / admin is never refused by that rule, so takes no approval lock). The
 * employee lock makes bank-detail writes for one employee one order. The
 * details sent again unchanged write nothing, and that is
 * decided after the role, so a manager's PUT cannot test a guessed number.
 * /api/payroll/duplicates cannot either: it gives a manager no bank-account
 * groups (owner / admin only; masked in Login-as and token sessions).
 * The account number (last four), branch code (last two) and holder (first
 * letter) are masked for everyone but owner / admin; the bank name is not.
 * Sessions: the route refuses Login-as and tokens; MCP has no bank-details tool.
 *
 * Every refusal is raised before the first write (a 4xx commits the request).
 * Account numbers are never logged.
 */
import { z } from 'zod';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { maskInitial, maskLastTwo, maskValue } from '@/modules/accounting/services/core/entityChanges/entityChangeMasking';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { ROW_LOCK_BUDGET_MS, RowLockTimeoutError, withRowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { payrollApprovalLockScope } from './payrollRunLock';

export const ACCOUNT_TYPES = ['cheque', 'savings', 'transmission'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** What these names hold, and no control character or formula lead-in: bank files and exports read them. Blank passes (the holder is optional). */
const SAFE_NAME = /^(?:[\p{L}\p{N}][\p{L}\p{M}\p{N} .,'’&()/-]*)?$/u;
const safeNameMessage = (label: string) => `${label} may hold letters, digits, spaces and . , ' ’ & ( ) / - only`;

const InputSchema = z.object({
  bankName: z.string('Bank name is required').trim().min(1, 'Bank name is required').max(100, 'Bank name is at most 100 characters')
    .regex(SAFE_NAME, safeNameMessage('Bank name')),
  branchCode: z.string('Branch code is required').trim().regex(/^[0-9]{6}$/, 'Branch code must be 6 digits'),
  accountNumber: z.string('Account number is required').transform((v) => v.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^[0-9]{6,16}$/, 'Account number must be 6 to 16 digits')),
  accountType: z.enum(ACCOUNT_TYPES, 'Account type must be cheque, savings or transmission'),
  accountHolder: z.string('Account holder must be text').trim().max(100, 'Account holder is at most 100 characters')
    .regex(SAFE_NAME, safeNameMessage('Account holder')).nullish().transform((v) => v || null),
});

export type BankDetailsInput = z.output<typeof InputSchema>;

export type BankDetailsRefusalCode = 'INVALID' | 'EMPLOYEE_NOT_FOUND' | 'CHANGE_REQUIRES_ADMIN' | 'FIRST_ENTRY_REQUIRES_ADMIN';

const STATUS: Record<BankDetailsRefusalCode, 403 | 404 | 422> = {
  INVALID: 422, EMPLOYEE_NOT_FOUND: 404, CHANGE_REQUIRES_ADMIN: 403, FIRST_ENTRY_REQUIRES_ADMIN: 403,
};

/** A refusal, raised before anything is written. */
export class PayrollBankDetailsRefusal extends Error {
  readonly status: 403 | 404 | 422;
  constructor(readonly code: BankDetailsRefusalCode, message: string, readonly fieldErrors?: Record<string, string[]>) {
    super(message);
    this.name = 'PayrollBankDetailsRefusal';
    this.status = STATUS[code];
  }
}

export interface EmployeeBankDetails {
  id: string;
  employeeId: string;
  bankName: string;
  /** In full for owner / admin, else `…1234`. */
  accountNumber: string;
  /** True for anyone but owner / admin: number, branch code and holder are then masked. */
  masked: boolean;
  accountType: AccountType;
  /** In full for owner / admin, else `…55` (last two digits). */
  branchCode: string;
  /** In full for owner / admin, else its first letter and `…`. */
  accountHolder: string | null;
  effectiveFrom: string;
}

/** The request body, checked: throws PayrollBankDetailsRefusal (INVALID). Reads nothing. */
export function parseBankDetailsInput(raw: unknown): BankDetailsInput {
  const parsed = InputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const { fieldErrors } = parsed.error.flatten();
  throw new PayrollBankDetailsRefusal('INVALID', 'Validation failed', fieldErrors as Record<string, string[]>);
}

interface BankRow {
  id: string;
  employee_id: string;
  bank_name: string;
  account_number: string;
  account_type: AccountType;
  branch_code: string;
  account_holder: string | null;
  effective_from: string;
}

function toView(row: BankRow, role: string | undefined): EmployeeBankDetails {
  const full = isHistoryAdmin(role);
  return {
    id: row.id,
    employeeId: row.employee_id,
    bankName: row.bank_name,
    accountNumber: full ? row.account_number : String(maskValue(row.account_number)),
    masked: !full,
    accountType: row.account_type,
    // Branch code to its last two, holder to its first letter: two employees on one account do not show it (as the history).
    branchCode: full ? row.branch_code : String(maskLastTwo(row.branch_code)),
    accountHolder: full ? row.account_holder : (maskInitial(row.account_holder) as string | null),
    effectiveFrom: row.effective_from,
  };
}

const sameDetails = (row: BankRow, input: BankDetailsInput) => row.bank_name === input.bankName
  && row.account_number === input.accountNumber && row.account_type === input.accountType
  && row.branch_code === input.branchCode && row.account_holder === input.accountHolder;

/**
 * Whether the employee has been paid through one of this company's runs that is or ever was approved, posted or paid,
 * in any period. Ever approved: status approved or paid, approved_at (kept by a run moved off 'approved' by an older
 * path or by hand; the app clears it only with a reopen), a reopen (reopened_at, 925's approval_history), or a linked
 * journal (journal_entry_id, payrollJournalPostingService). Paid through it: a line on it now, or for a reopened run,
 * whose lines may since have changed, in its taxed set (approved_taxed_employees) or employed in its period at all, so
 * an employee taken off it with nothing taxable, or under an unknown (NULL) set, still counts. Fails closed: an
 * employee employed then but never on the run counts too. Not seen: a journal posted, reversed and unlinked on a run
 * never approved.
 */
async function paidThroughApprovedRun(companyId: string, employeeId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM payroll_run_headers h
    JOIN payroll_employees e ON e.company_id = h.company_id AND e.id = ${employeeId}::uuid
    WHERE h.company_id = ${companyId}::uuid
      AND (h.status IN ('approved', 'paid') OR h.approved_at IS NOT NULL OR h.journal_entry_id IS NOT NULL
           OR h.reopened_at IS NOT NULL OR NOT isempty(COALESCE(h.approval_history, '{}')))
      AND (EXISTS (SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id AND l.employee_id = e.id)
           OR ((h.reopened_at IS NOT NULL OR NOT isempty(COALESCE(h.approval_history, '{}')))
               AND (e.id = ANY (COALESCE(h.approved_taxed_employees, '{}'))
                    OR e.start_date < pg_catalog.make_date(h.period_year, h.period_month, 1) + interval '1 month')))
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Whether this company has the employee: a route's 404, without loading their personal details. */
export async function employeeExists(companyId: string, employeeId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
  `;
  return rows.length > 0;
}

/** The employee's active details, masked for `role`; null when they have none. */
export async function getEmployeeBankDetails(
  companyId: string, employeeId: string, role: string | undefined,
): Promise<EmployeeBankDetails | null> {
  const rows = (await sql`
    SELECT id, employee_id, bank_name, account_number, account_type, branch_code, account_holder,
           effective_from::text AS effective_from
    FROM payroll_bank_details
    WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid AND is_active
  `) as BankRow[];
  return rows[0] ? toView(rows[0], role) : null;
}

/**
 * Enter or change the employee's details, from `parseBankDetailsInput`'s output.
 * Details identical to the active row come back as they are, with no new row.
 * Lock order: for a caller who is not owner / admin, the company payroll-approval lock (first entry's only
 * reader is the ever-approved rule, which they alone meet); then the employee row, then this table; nothing after it.
 * Both waits share ONE 5 s deadline, each re-armed to what remains, so the request waits ~5 s in all.
 */
export async function setEmployeeBankDetails(
  companyId: string, employeeId: string, input: BankDetailsInput, role: string | undefined,
): Promise<EmployeeBankDetails> {
  const deadline = Date.now() + ROW_LOCK_BUDGET_MS;
  if (!isHistoryAdmin(role)) {
    // Approval, calculation and reopen all take this before their run header. Taking it before reading the
    // ever-approved predicate stops an approval committing between that read and the insert; taking it before the
    // employee row keeps the same order as those three (the approval lock, then rows), so no cycle.
    await withRowLockBudget(() => sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${payrollApprovalLockScope(companyId)}, 0))
    `, () => new RowLockTimeoutError('Payroll for this company'), { deadline });
  }
  const row = await withRowLockBudget(async () => {
    const employee = await sql`
      SELECT id FROM payroll_employees
      WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
      FOR UPDATE
    `;
    if (!employee[0]) throw new PayrollBankDetailsRefusal('EMPLOYEE_NOT_FOUND', 'Employee not found');

    // Any row at all, active or not: an entry that has been retired is still a change. The active one first.
    const [existing] = (await sql`
      SELECT id, employee_id, bank_name, account_number, account_type, branch_code, account_holder, is_active,
             effective_from::text AS effective_from
      FROM payroll_bank_details
      WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid
      ORDER BY is_active DESC
      LIMIT 1
    `) as (BankRow & { is_active: boolean })[];
    if (existing && !isHistoryAdmin(role)) {
      throw new PayrollBankDetailsRefusal('CHANGE_REQUIRES_ADMIN', 'Only an owner or admin can change existing bank details.');
    }
    // A manager's first entry, decided after the change rule: a manager who may read the details learns nothing new.
    if (!existing && !isHistoryAdmin(role) && (await paidThroughApprovedRun(companyId, employeeId))) {
      throw new PayrollBankDetailsRefusal('FIRST_ENTRY_REQUIRES_ADMIN',
        'Only an owner or admin can enter bank details for an employee who has been paid through an approved run.');
    }
    if (existing?.is_active && sameDetails(existing, input)) return existing;

    await sql`
      UPDATE payroll_bank_details SET is_active = false
      WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid AND is_active
    `;
    const inserted = await sql`
      INSERT INTO payroll_bank_details
        (company_id, employee_id, bank_name, account_number, account_type, branch_code, account_holder, effective_from)
      VALUES (${companyId}::uuid, ${employeeId}::uuid, ${input.bankName}, ${input.accountNumber}, ${input.accountType},
              ${input.branchCode}, ${input.accountHolder}, ${todayInSast()}::date)
      RETURNING id, employee_id, bank_name, account_number, account_type, branch_code, account_holder,
                effective_from::text AS effective_from
    `;
    return inserted[0] as unknown as BankRow;
  }, () => new RowLockTimeoutError('This employee'), { deadline });
  log.info('setEmployeeBankDetails', { companyId, employeeId, bankDetailId: row.id });
  return toView(row, role);
}
