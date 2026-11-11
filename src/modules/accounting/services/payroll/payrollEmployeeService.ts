import { sql, withTransaction } from '@/lib/neon';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollEmployee } from './payrollTypes';
import { recordEmployeeChange } from './payrollEmployeeHistoryService';
import { EmployeeTermsRefused, judgeTerms, movedTerms, termsFromRow, TERM_KEYS, type EmployeeTerms } from './payrollEmployeeTerms';

type Row = DbRow;

export function mapPayrollEmployeeRow(r: Row): PayrollEmployee {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeNumber: String(r.employee_number),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    idNumber: r.id_number ? String(r.id_number) : undefined,
    taxNumber: r.tax_number ? String(r.tax_number) : undefined,
    employmentType: String(r.employment_type) as PayrollEmployee['employmentType'],
    startDate: new Date(String(r.start_date)),
    endDate: r.end_date ? new Date(String(r.end_date)) : undefined,
    dateOfBirth: r.date_of_birth ? new Date(String(r.date_of_birth)) : undefined,
    uifExcluded: Boolean(r.uif_excluded),
    medicalAidMainMember: Boolean(r.medical_aid_main_member),
    medicalAidDependantsCount: Number(r.medical_aid_dependants_count) || 0,
    s18aReceiptHeld: r.s18a_receipt_held === true,
    costCentreId: r.cost_centre_id == null ? null : String(r.cost_centre_id),
    payScaleId: r.pay_scale_id == null ? null : String(r.pay_scale_id),
    occupationalLevelId: r.occupational_level_id == null ? null : String(r.occupational_level_id),
    paymentMethod: r.payment_method === 'cash' ? 'cash' : 'eft',
    ...termsFromRow(r),
  };
}

/**
 * Active employees; with `includeTerminated`, leavers too (the tax-directive
 * form: severance, retirement and death directives are for people who left).
 * 'inactive' employees are never listed.
 */
export async function listPayrollEmployees(
  companyId: string,
  opts: { includeTerminated?: boolean } = {},
): Promise<PayrollEmployee[]> {
  const statuses = opts.includeTerminated ? ['active', 'terminated'] : ['active'];
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND status = ANY(${statuses}::text[])
    ORDER BY last_name, first_name
  `) as Row[];
  return rows.map(mapPayrollEmployeeRow);
}

/**
 * The employees a run for (year, month) pays: every employee whose end_date
 * falls in the month, whatever their status (updatePayrollEmployee terminates
 * on an end date of today or earlier, and the final pay is still due); an
 * active or terminated employee whose end_date is after the month (a run
 * recalculated after they left); and active employees with no end_date.
 * Nobody who starts after the month. Audit 2026-10-18 P4.
 */
export async function listPayrollRunEmployees(
  companyId: string,
  period: { year: number; month: number },
): Promise<PayrollEmployee[]> {
  const rows = (await sql`
    WITH p AS (SELECT make_date(${period.year}::int, ${period.month}::int, 1) AS start)
    SELECT e.* FROM payroll_employees e, p
    WHERE e.company_id = ${companyId}::uuid
      AND e.start_date < p.start + INTERVAL '1 month'
      AND (
        (e.end_date >= p.start AND e.end_date < p.start + INTERVAL '1 month')
        OR (e.end_date >= p.start + INTERVAL '1 month' AND e.status IN ('active', 'terminated'))
        OR (e.end_date IS NULL AND e.status = 'active')
      )
    ORDER BY e.last_name, e.first_name
  `) as Row[];
  return rows.map(mapPayrollEmployeeRow);
}

export async function getPayrollEmployee(
  id: string,
  companyId: string,
): Promise<PayrollEmployee | null> {
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 && rows[0] ? mapPayrollEmployeeRow(rows[0]) : null;
}

/** The record a tax directive is filed under: name, tax number and status, or null when not this company's employee. */
export async function getDirectivePayee(
  companyId: string,
  id: string,
): Promise<{ id: string; name: string; taxNumber: string | null; status: string } | null> {
  const rows = (await sql`
    SELECT id, first_name, last_name, tax_number, status FROM payroll_employees
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), name: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim(),
    taxNumber: r.tax_number ? String(r.tax_number).trim() : null, status: String(r.status),
  };
}

/** A new employee; without terms it is an employee on a monthly basis, as the column defaults say. */
type NewPayrollEmployee = Omit<PayrollEmployee, 'id' | 'companyId' | 'taxStatus' | 'payBasis'> & Partial<Pick<PayrollEmployee, 'taxStatus' | 'payBasis'>>;

export async function createPayrollEmployee(
  companyId: string,
  data: NewPayrollEmployee,
): Promise<PayrollEmployee> {
  log.info('Creating payroll employee', { companyId, employeeNumber: data.employeeNumber }, 'payrollEmployeeService');
  const rows = (await sql`
    INSERT INTO payroll_employees (
      company_id, employee_number, first_name, last_name,
      id_number, tax_number, employment_type, start_date, end_date,
      date_of_birth, uif_excluded, medical_aid_main_member, medical_aid_dependants_count, s18a_receipt_held,
      tax_status, pay_basis, hours_per_week, hours_per_day, hourly_rate, daily_rate, occupation
    ) VALUES (
      ${companyId}::uuid, ${data.employeeNumber}, ${data.firstName}, ${data.lastName},
      ${data.idNumber ?? null}, ${data.taxNumber ?? null},
      ${data.employmentType}, ${fmtDate(data.startDate)},
      ${data.endDate ? fmtDate(data.endDate) : null},
      ${data.dateOfBirth ? fmtDate(data.dateOfBirth) : null},
      ${data.uifExcluded}, ${data.medicalAidMainMember}, ${data.medicalAidDependantsCount}, ${data.s18aReceiptHeld},
      ${data.taxStatus ?? 'employee'}, ${data.payBasis ?? 'monthly'}, ${data.hoursPerWeek ?? null}, ${data.hoursPerDay ?? null},
      ${data.hourlyRate ?? null}, ${data.dailyRate ?? null}, ${data.occupation ?? null}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('INSERT returned no row');
  return mapPayrollEmployeeRow(rows[0]);
}

export async function updatePayrollEmployee(
  id: string,
  companyId: string,
  data: Partial<Omit<PayrollEmployee, 'id' | 'companyId'>>,
  userId?: string,
): Promise<PayrollEmployee | null> {
  log.info('Updating payroll employee', { id, companyId }, 'payrollEmployeeService');

  const toIso = (v: unknown): string | null => (v ? fmtDate(v) : null);
  const dobIso = toIso(data.dateOfBirth);
  const endIso = toIso(data.endDate);
  // Only mark as terminated if the end date is today or in the past.
  // A future end_date means "scheduled to leave" — don't terminate yet.
  const todayIso = new Date().toISOString().split('T')[0]!;
  const status = endIso && endIso <= todayIso ? 'terminated' : null;

  // An end date moves who a run pays and the termination base, the s18A tick moves PAYE and SDL, and the tax status,
  // pay basis, hours and rates feed the figures from TS-b on: each waits for the company's payroll-approval lock, as every
  // change the approval gate re-checks (payrollRunRecalcGate). Whether a tick MOVED is decided on the row locked below,
  // never on an earlier read. Other fields need the row lock only.
  // Terms: a key present (null clears the optional ones) is written; the tax status and pay basis feed the figures
  // from TS-b on, so any touch of the terms waits for the same lock.
  const has = (k: keyof EmployeeTerms) => data[k] !== undefined;
  const needsCompanyLock = endIso !== null || data.s18aReceiptHeld !== undefined || data.employmentType !== undefined
    || (['taxStatus', 'payBasis', 'hoursPerWeek', 'hoursPerDay', 'hourlyRate', 'dailyRate'] as const).some(has);
  const write = (db: typeof sql, now: Row) => db`
    UPDATE payroll_employees SET
      first_name                   = COALESCE(${data.firstName ?? null}, first_name),
      last_name                    = COALESCE(${data.lastName ?? null}, last_name),
      tax_number                   = COALESCE(${data.taxNumber ?? null}, tax_number),
      id_number                    = COALESCE(${data.idNumber ?? null}, id_number),
      employment_type              = COALESCE(${data.employmentType ?? null}, employment_type),
      date_of_birth                = COALESCE(${dobIso}, date_of_birth),
      end_date                     = COALESCE(${endIso}, end_date),
      status                       = COALESCE(${status}, status),
      uif_excluded                 = COALESCE(${data.uifExcluded ?? null}, uif_excluded),
      medical_aid_main_member      = COALESCE(${data.medicalAidMainMember ?? null}, medical_aid_main_member),
      medical_aid_dependants_count = COALESCE(${data.medicalAidDependantsCount ?? null}, medical_aid_dependants_count),
      s18a_receipt_held            = COALESCE(${data.s18aReceiptHeld !== undefined && data.s18aReceiptHeld !== now.s18a_receipt_held ? data.s18aReceiptHeld ?? null : null}, s18a_receipt_held),
      tax_status                   = CASE WHEN ${has('taxStatus')} THEN ${data.taxStatus ?? null} ELSE tax_status END,
      pay_basis                    = CASE WHEN ${has('payBasis')} THEN ${data.payBasis ?? null} ELSE pay_basis END,
      hours_per_week               = CASE WHEN ${has('hoursPerWeek')} THEN ${data.hoursPerWeek ?? null}::numeric ELSE hours_per_week END,
      hours_per_day                = CASE WHEN ${has('hoursPerDay')} THEN ${data.hoursPerDay ?? null}::numeric ELSE hours_per_day END,
      hourly_rate                  = CASE WHEN ${has('hourlyRate')} THEN ${data.hourlyRate ?? null}::numeric ELSE hourly_rate END,
      daily_rate                   = CASE WHEN ${has('dailyRate')} THEN ${data.dailyRate ?? null}::numeric ELSE daily_rate END,
      occupation                   = CASE WHEN ${has('occupation')} THEN ${data.occupation ?? null} ELSE occupation END,
      updated_at                   = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `;
  // Under the row lock: re-read the row as it stands now, judge the terms against it again (an owner's concurrent
  // change may have made a pair unreachable that looked fine before), write, and log only the terms this patch carried,
  // through the same transaction, so another admin's change is never logged a second time under this one's name.
  let locked: Row | undefined;
  const writeLocked = async (db: typeof sql): Promise<Row[]> => {
    locked = ((await db`
      SELECT * FROM payroll_employees WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `) as Row[])[0];
    if (!locked) return [];
    const carried = TERM_KEYS.filter(has);
    if (carried.length > 0) {
      judgeTerms({ ...termsFromRow(locked), ...Object.fromEntries(carried.map((k) => [k, data[k]])) } as EmployeeTerms, (m) => new EmployeeTermsRefused(m));
    }
    const written = (await write(db, locked)) as Row[];
    if (userId && written[0]) {
      for (const m of movedTerms(termsFromRow(locked), termsFromRow(written[0]), carried)) {
        await recordEmployeeChange({ companyId, employeeId: id, fieldName: m.field, oldValue: m.oldValue, newValue: m.newValue, userId }, db);
      }
    }
    return written;
  };
  // Always one transaction, so the row lock is a lock: the company lock first where the change needs it.
  const rows = (await withTransaction(async (tx) => {
    if (needsCompanyLock) await lockCompanyPayrollForComponentChange(tx, companyId);
    return writeLocked(tx as typeof sql);
  })) as Row[];

  const updated = rows.length > 0 && rows[0] ? mapPayrollEmployeeRow(rows[0]) : null;

  if (userId && locked && updated && data.employmentType !== undefined) {
    await recordEmployeeChange({
      companyId,
      employeeId: id,
      fieldName: 'employment_type',
      oldValue: locked.employment_type == null ? null : String(locked.employment_type),
      newValue: updated.employmentType,
      userId,
    });
  }

  return updated;
}

export async function listTaxNumbersForCompany(
  companyId: string,
  excludeId?: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT tax_number FROM payroll_employees
    WHERE company_id = ${companyId}::uuid
      AND tax_number IS NOT NULL
      AND status = 'active'
      AND (${excludeId ?? null}::uuid IS NULL OR id != ${excludeId ?? null}::uuid)
  `) as Row[];
  return rows.map(r => String(r.tax_number));
}
