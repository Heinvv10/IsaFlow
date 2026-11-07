/**
 * Payslip history and the payslip download record (wave 4 PS).
 *
 * `listEmployeePayslips`: the employee's runs, newest first (period, final or DRAFT by
 * the same R-035 test the PDF uses, the stored net). Company-scoped: an employee of
 * another company is null (404 at the route).
 *
 * `auditPayslipDownload`: one `audit_log` `export` row per download, in the request
 * transaction (the default `sql`), so the PDF cannot leave without its record. It names
 * the actor, the session, the run, the employees and whether the session is a Login-as
 * (then also the platform admin behind it, `impersonatorUserId`); never a figure.
 *
 * Cost: `isPayRunFinal` is the R-035 guard, one run at a time (it judges each run's own
 * plan; there is no batch form). The history is capped at PAYSLIP_HISTORY_LIMIT runs and
 * the year to date reads at most the 12 runs of one tax year, so a call is bounded.
 */
import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { isPayRunFinal } from './payslipFinal';

export interface EmployeePayslipEntry {
  runId: string;
  periodMonth: number;
  periodYear: number;
  final: boolean;
  netPay: number;
}

/** The newest runs shown; older slips stay on their runs. */
export const PAYSLIP_HISTORY_LIMIT = 24;

export async function listEmployeePayslips(companyId: string, employeeId: string): Promise<EmployeePayslipEntry[] | null> {
  const employee = await sql`
    SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid`;
  if (employee.length === 0) return null;
  const rows = (await sql`
    SELECT prh.id::text AS run_id, prh.period_month, prh.period_year, prl.net_pay
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
     WHERE prh.company_id = ${companyId}::uuid
       AND prl.employee_id = ${employeeId}::uuid
       AND prh.status <> 'cancelled'
     ORDER BY prh.period_year DESC, prh.period_month DESC, prh.created_at DESC
     LIMIT ${PAYSLIP_HISTORY_LIMIT}
  `) as Array<{ run_id: string; period_month: number; period_year: number; net_pay: string | number }>;
  const entries: EmployeePayslipEntry[] = [];
  for (const r of rows) {
    entries.push({
      runId: r.run_id, periodMonth: Number(r.period_month), periodYear: Number(r.period_year),
      final: await isPayRunFinal(companyId, r.run_id), netPay: Number(r.net_pay),
    });
  }
  return entries;
}

export interface PayslipDownload {
  companyId: string;
  runId: string;
  employeeIds: string[];
  final: boolean;
  impersonated: boolean;
  disposition: 'inline' | 'attachment';
  actor: { userId: string; userEmail?: string; ip?: string; userAgent?: string; sessionId: string | null };
  /** The platform admin behind a Login-as session; null in a person's own session. */
  impersonatorUserId: string | null;
}

export async function auditPayslipDownload(d: PayslipDownload): Promise<void> {
  await logAuditOrThrow({
    companyId: d.companyId,
    userId: d.actor.userId,
    userEmail: d.actor.userEmail,
    action: 'export',
    entityType: 'payroll_payslips',
    entityId: d.runId,
    changes: {
      fields: [],
      metadata: {
        runId: d.runId,
        employeeIds: d.employeeIds.join(','),
        employees: String(d.employeeIds.length),
        final: String(d.final),
        impersonated: String(d.impersonated),
        disposition: d.disposition,
        ...(d.impersonatorUserId ? { impersonatorUserId: d.impersonatorUserId } : {}),
      },
    },
    ip: d.actor.ip,
    userAgent: d.actor.userAgent,
    sessionId: d.actor.sessionId ?? undefined,
  });
}
