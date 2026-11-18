/**
 * The assignment-side rules of a defined-benefit fund (wave 6 DBF, migration 999s; #1571 adversarial round), apart from
 * the run's valuation (definedBenefitFund.ts):
 * - a component created as a defined-benefit fund (payroll_components.fund_type) is assigned only with its fund member
 *   category factor, on every write path (assign, batch post, package apply, the run grid: refuseAssignmentWrite);
 * - an employee has at most one live factor row per fund kind (3817 or 3825): two would each be valued on the same RFI
 *   (DbFactorConflict, answered 409);
 * - the employee's 4001 / 4003 deduction that is the compulsory contribution to the fund is marked
 *   (db_fund_member_contribution), so C in para 12D(3) excludes voluntary contributions, buy-back and other funds. The
 *   mark is a tax valuation input: refused to a Login-as session, audited (the approval gate then refuses a run
 *   calculated before it), only on a 4001 / 4003 deduction of the employee named, and one live marked row per code (409).
 */
import { withTransaction, type DbRow, type TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { lockCompanyPayrollForComponentChange } from './payrollComponentPaidMonths';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { DEFINED_BENEFIT_CODES } from './definedBenefitFund';

/** A second live factor row of the same fund kind for the employee: the route answers 409. */
export class DbFactorConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbFactorConflict';
  }
}

/** A defined_benefit component written without a factor (any path), refused before the insert. */
export async function refuseDbComponentWithoutFactor(tx: TxSql, companyId: string, componentId: string, hasFactor: boolean): Promise<void> {
  if (hasFactor) return;
  const row = ((await tx`
    SELECT fund_type FROM payroll_components WHERE id = ${componentId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (row?.fund_type === 'defined_benefit') {
    throw new EmployeeComponentRefused('This component is a defined-benefit fund: assign it on the employee\'s Defined-benefit fund '
      + 'contributions card, with the fund member category factor on the fund\'s certificate (para 12D(3)-(4)).');
  }
}

/** Another live factor row of the same SARS code overlapping [from, to] for the employee, refused (DbFactorConflict). */
export async function refuseSecondDbFactorRow(
  tx: TxSql, companyId: string, a: { employeeId: string; componentId: string; from: string; to: string | null },
): Promise<void> {
  const rows = (await tx`
    SELECT pc.name, c.effective_from, c.effective_to
      FROM payroll_employee_components c
      JOIN payroll_components pc ON pc.id = c.component_id AND pc.company_id = ${companyId}::uuid
      JOIN payroll_components me ON me.id = ${a.componentId}::uuid AND me.company_id = ${companyId}::uuid
     WHERE c.employee_id = ${a.employeeId}::uuid AND c.db_member_category_factor IS NOT NULL
       AND btrim(pc.sars_source_code) = btrim(me.sars_source_code)
     ORDER BY c.id FOR UPDATE OF c
  `) as DbRow[];
  for (const r of rows) {
    const from = fmtDate(r.effective_from);
    const to = r.effective_to ? fmtDate(r.effective_to) : null;
    if ((to === null || to >= from) && from <= (a.to ?? '9999-12-31') && (to === null || to >= a.from)) {
      throw new DbFactorConflict(`${String(r.name)} already carries a defined-benefit factor for this employee (${from} to ${to ?? 'open-ended'}): `
        + 'one factor per fund kind, or the same income is valued twice. End that one first.');
    }
  }
}

/**
 * Another live row of the same code, already marked, overlapping this one for the employee (#1571 breaker L2): two marked
 * rows would put a voluntary contribution into C and understate X. Refused (DbFactorConflict, 409), as one factor per kind is.
 */
async function refuseSecondTick(tx: TxSql, companyId: string, employeeId: string, assignmentId: string, code: string): Promise<void> {
  const rows = (await tx`
    SELECT pc.name, o.effective_from, o.effective_to
      FROM payroll_employee_components me
      JOIN payroll_employee_components o ON o.employee_id = me.employee_id AND o.id <> me.id AND o.db_fund_member_contribution
      JOIN payroll_components pc ON pc.id = o.component_id AND pc.company_id = ${companyId}::uuid AND btrim(pc.sars_source_code) = ${code}
     WHERE me.id = ${assignmentId}::uuid AND me.employee_id = ${employeeId}::uuid
       AND (o.effective_to IS NULL OR o.effective_to >= o.effective_from)
       AND o.effective_from <= COALESCE(me.effective_to, 'infinity'::date) AND COALESCE(o.effective_to, 'infinity'::date) >= me.effective_from
     ORDER BY o.id FOR UPDATE OF o
  `) as DbRow[];
  if (rows[0]) {
    throw new DbFactorConflict(`${String(rows[0].name)} is already marked as this employee's compulsory ${code} contribution to the fund `
      + `(${fmtDate(rows[0].effective_from)} to ${rows[0].effective_to ? fmtDate(rows[0].effective_to) : 'open-ended'}): only one row is C. `
      + 'A second is likely a voluntary contribution (AVC); untick the other first if this one is the compulsory contribution.');
  }
}

/**
 * Mark (or unmark) the employee's 4001 / 4003 deduction assignment as the compulsory contribution to the defined-benefit
 * fund. Returns false when the assignment is not that employee's in the company (the URL's employee, so one employee's page
 * cannot mark another's row). Refused to a Login-as session, before any read or write.
 */
export async function setDbFundMemberContribution(
  companyId: string, employeeId: string, assignmentId: string, marked: unknown, actor: ComponentChangeActor,
): Promise<boolean> {
  await assertNotImpersonating();
  if (typeof marked !== 'boolean') throw new EmployeeComponentRefused('dbFundMemberContribution must be true or false.');
  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const row = ((await tx`
      SELECT c.id, c.effective_from, c.effective_to, c.is_recurring, pc.component_type, btrim(pc.sars_source_code) AS code
        FROM payroll_employee_components c
        JOIN payroll_employees e ON e.id = c.employee_id AND e.company_id = ${companyId}::uuid
        JOIN payroll_components pc ON pc.id = c.component_id AND pc.company_id = ${companyId}::uuid
       WHERE c.id = ${assignmentId}::uuid AND c.employee_id = ${employeeId}::uuid FOR UPDATE OF c
    `) as DbRow[])[0];
    if (!row) return false;
    if (row.component_type !== 'deduction' || !Object.values(DEFINED_BENEFIT_CODES).includes(String(row.code))) {
      throw new EmployeeComponentRefused('Only the employee\'s pension (4001) or provident (4003) fund contribution can be marked as the '
        + 'contribution to a defined-benefit fund.');
    }
    if (marked) await refuseSecondTick(tx, companyId, employeeId, assignmentId, String(row.code));
    await tx`UPDATE payroll_employee_components SET db_fund_member_contribution = ${marked} WHERE id = ${assignmentId}::uuid`;
    const window = { from: fmtDate(row.effective_from), to: row.effective_to ? fmtDate(row.effective_to) : null, recurring: row.is_recurring !== false };
    await auditComponentChange(tx, companyId, assignmentId, window, window, 'db_fund_contribution_mark', actor);
    return true;
  });
}
