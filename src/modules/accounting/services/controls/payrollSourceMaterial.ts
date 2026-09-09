import { assertControlTx } from './context';
import type { ControlTx } from './contracts';
export type PayrollRow = Record<string, unknown>;
/** Shared mutation fence precedes every payroll source lock, including empty populations. */
export async function lockPayrollSources(ctx: ControlTx, runId: string) {
  assertControlTx(ctx);
  const companyId = ctx.principal.companyId;
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${companyId}`},0))`;
  const [company] = await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${companyId}::uuid FOR SHARE` as PayrollRow[];
  const [header] = await ctx.sql`SELECT * FROM payroll_run_headers WHERE company_id=${companyId}::uuid AND id=${runId}::uuid FOR UPDATE` as PayrollRow[];
  if (!company || !header) throw new Error('Payroll run unavailable');
  const lines = await ctx.sql`SELECT l.* FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id=l.run_id
    WHERE h.company_id=${companyId}::uuid AND h.id=${runId}::uuid ORDER BY l.employee_id,l.id LIMIT 10001 FOR SHARE OF l` as PayrollRow[];
  const employees = await ctx.sql`SELECT * FROM payroll_employees WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  if (lines.length>10000 || employees.length>10000) throw new Error('Payroll source population exceeds the supported bound');
  if (lines.some(l=>!employees.some(e=>e.id === l.employee_id))) throw new Error('Payroll employee is missing or foreign');
  const components = await ctx.sql`SELECT * FROM payroll_components WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const assignments = await ctx.sql`SELECT a.* FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id
    WHERE e.company_id=${companyId}::uuid ORDER BY a.employee_id,a.id LIMIT 10001 FOR SHARE OF a` as PayrollRow[];
  if (assignments.some(a=>!components.some(c=>c.id === a.component_id))) throw new Error('Payroll component is missing or foreign');
  const allocations = await ctx.sql`SELECT * FROM payroll_employee_cost_allocations WHERE company_id=${companyId}::uuid ORDER BY employee_id,id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const mappings = await ctx.sql`SELECT * FROM cost_centre_gl_mappings WHERE company_id=${companyId}::uuid ORDER BY cost_centre_id,id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const centres = await ctx.sql`SELECT * FROM cost_centres WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  if (allocations.some(a=>!employees.some(e=>e.id===a.employee_id) || !centres.some(c=>c.id===a.cost_centre_id))
    || mappings.some(m=>!centres.some(c=>c.id===m.cost_centre_id))) throw new Error('Payroll costing source is missing or foreign');
  const accounts = await ctx.sql`SELECT id,account_code,account_type,account_subtype,is_active FROM gl_accounts
    WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const loans = await ctx.sql`SELECT * FROM payroll_loans WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const loanSchedules = await ctx.sql`SELECT s.* FROM payroll_loan_schedule s JOIN payroll_loans l ON l.id=s.loan_id
    WHERE l.company_id=${companyId}::uuid ORDER BY s.loan_id,s.id LIMIT 10001 FOR SHARE OF s` as PayrollRow[];
  const loanPayments = await ctx.sql`SELECT p.* FROM payroll_loan_payments p JOIN payroll_loans l ON l.id=p.loan_id
    WHERE l.company_id=${companyId}::uuid ORDER BY p.loan_id,p.id LIMIT 10001 FOR SHARE OF p` as PayrollRow[];
  const leaveTypes = await ctx.sql`SELECT * FROM payroll_leave_types WHERE company_id=${companyId}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as PayrollRow[];
  const leaveBalances = await ctx.sql`SELECT b.* FROM payroll_leave_balances b JOIN payroll_employees e ON e.id=b.employee_id
    WHERE e.company_id=${companyId}::uuid ORDER BY b.employee_id,b.id LIMIT 10001 FOR SHARE OF b` as PayrollRow[];
  const bankDetails = await ctx.sql`SELECT b.* FROM payroll_bank_details b JOIN payroll_employees e ON e.id=b.employee_id
    WHERE e.company_id=${companyId}::uuid ORDER BY b.employee_id,b.id LIMIT 10001 FOR SHARE OF b` as PayrollRow[];
  const sources = { company, header, lines, employees, components, assignments, allocations, mappings, centres, accounts,
    loans, loanSchedules, loanPayments, leaveTypes, leaveBalances, bankDetails };
  if (Object.values(sources).some(value=>Array.isArray(value) && value.length>10000)) throw new Error('Payroll source population exceeds the supported bound');
  return sources;
}
