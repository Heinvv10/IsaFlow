/**
 * An employee's bank details (wave 3 K1, migration 952): one active row per
 * employee; a change deactivates that row and inserts the next, so every
 * account the company ever held for them stays on file. The database records
 * who did it (888's capture, entity type payroll_bank_detail).
 *
 * Who: anyone in withPayrollDetailAccess's roles makes the FIRST entry (Hein's
 * decision 14); a change to existing details is owner / admin only, and that is
 * decided here under the employee row lock, so two people cannot both find "no
 * details yet". The details sent again unchanged write nothing, and that is
 * decided after the role, so a manager cannot use it to test a guessed number.
 * The account number is masked for everyone but owner / admin.
 * Sessions: the route refuses Login-as and tokens; MCP has no bank-details tool.
 *
 * Every refusal is raised before the first write (a 4xx commits the request).
 * Account numbers are never logged.
 */
import { z } from 'zod';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { maskValue } from '@/modules/accounting/services/core/entityChanges/entityChangeMasking';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { underFlowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';

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

export type BankDetailsRefusalCode = 'INVALID' | 'EMPLOYEE_NOT_FOUND' | 'CHANGE_REQUIRES_ADMIN';

const STATUS: Record<BankDetailsRefusalCode, 403 | 404 | 422> = { INVALID: 422, EMPLOYEE_NOT_FOUND: 404, CHANGE_REQUIRES_ADMIN: 403 };

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
  masked: boolean;
  accountType: AccountType;
  branchCode: string;
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
    branchCode: row.branch_code,
    accountHolder: row.account_holder,
    effectiveFrom: row.effective_from,
  };
}

const sameDetails = (row: BankRow, input: BankDetailsInput) => row.bank_name === input.bankName
  && row.account_number === input.accountNumber && row.account_type === input.accountType
  && row.branch_code === input.branchCode && row.account_holder === input.accountHolder;

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
 * Lock order: the employee row, then this table; nothing after it.
 */
export async function setEmployeeBankDetails(
  companyId: string, employeeId: string, input: BankDetailsInput, role: string | undefined,
): Promise<EmployeeBankDetails> {
  const row = await underFlowLockBudget('This employee', async () => {
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
  });
  log.info('setEmployeeBankDetails', { companyId, employeeId, bankDetailId: row.id });
  return toView(row, role);
}
