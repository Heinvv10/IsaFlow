/**
 * Payroll Run Service
 * Payroll run creation, calculation, finalization, and reversal.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  calculateMonthlyPAYE,
  calculateUIF,
  calculateSDL,
  calculateAgeFromIdNumber,
} from './taxTables';
import type { PayrollRun, PayrollRunWithPayslips, Payslip, CustomDeduction } from './types';
import { mapPayrollRun, mapPayslip } from './payrollMappers';
import { resolvePayrollGLAccounts, buildPayrollJournalLines } from './payrollGLHelper';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/journalEntryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function listPayrollRuns(companyId: string): Promise<PayrollRun[]> {
  try {
    const rows = (await sql`
      SELECT * FROM payroll_runs
      WHERE company_id = ${companyId}::UUID
      ORDER BY period_end DESC, created_at DESC
      LIMIT 100
    `) as Row[];
    return rows.map(mapPayrollRun);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist')) return [];
    log.error('listPayrollRuns failed', { error: err }, 'payroll');
    throw err;
  }
}

export async function getPayrollRun(
  companyId: string,
  runId: string
): Promise<PayrollRunWithPayslips | null> {
  try {
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];
    if (runRows.length === 0) return null;

    const slipRows = (await sql`
      SELECT ps.*, e.employee_number, e.first_name, e.last_name,
        e.id_number, e.tax_number, e.department, e.position
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.payroll_run_id = ${runId}
      ORDER BY e.employee_number
    `) as Row[];

    return {
      ...mapPayrollRun(runRows[0]!),
      payslips: slipRows.map((r: Row) => ({
        ...mapPayslip(r),
        employee_number: String(r.employee_number),
        first_name: String(r.first_name),
        last_name: String(r.last_name),
        id_number: r.id_number ? String(r.id_number) : undefined,
        tax_number: r.tax_number ? String(r.tax_number) : undefined,
        department: r.department ? String(r.department) : undefined,
        position: r.position ? String(r.position) : undefined,
      })),
    };
  } catch (err) {
    log.error('getPayrollRun failed', { runId, error: err }, 'payroll');
    throw err;
  }
}

export async function createPayrollRun(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  userId: string
): Promise<PayrollRunWithPayslips> {
  try {
    const empRows = (await sql`
      SELECT e.*,
        ps.basic_salary, ps.travel_allowance, ps.housing_allowance,
        ps.cell_allowance, ps.other_allowances, ps.medical_aid_contribution,
        ps.retirement_fund_contribution_pct, ps.custom_deductions
      FROM employees e
      JOIN LATERAL (
        SELECT * FROM pay_structures p
        WHERE p.employee_id = e.id
          AND p.effective_from <= ${periodEnd}::DATE
          AND (p.effective_to IS NULL OR p.effective_to >= ${periodStart}::DATE)
        ORDER BY p.effective_from DESC LIMIT 1
      ) ps ON TRUE
      WHERE e.company_id = ${companyId}::UUID AND e.status = 'active'
        AND e.start_date <= ${periodEnd}::DATE
        AND (e.termination_date IS NULL OR e.termination_date >= ${periodStart}::DATE)
      ORDER BY e.employee_number
    `) as Row[];

    if (empRows.length === 0) throw new Error('No active employees found for this period');

    const runRows = (await sql`
      INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by)
      VALUES (${companyId}::UUID, ${periodStart}, ${periodEnd}, 'draft', ${userId}::UUID)
      RETURNING *
    `) as Row[];

    const runId = String(runRows[0]!.id);
    let totalGross = 0, totalPaye = 0, totalUifEmployee = 0, totalUifEmployer = 0, totalNet = 0;
    const payslips: Payslip[] = [];

    for (const emp of empRows) {
      const basic = Number(emp.basic_salary) || 0;
      const travel = Number(emp.travel_allowance) || 0;
      const housing = Number(emp.housing_allowance) || 0;
      const cell = Number(emp.cell_allowance) || 0;
      const other = Number(emp.other_allowances) || 0;
      const medical = Number(emp.medical_aid_contribution) || 0;
      const retirePct = Number(emp.retirement_fund_contribution_pct) || 0;
      const customDeds: CustomDeduction[] = Array.isArray(emp.custom_deductions)
        ? emp.custom_deductions
        : (typeof emp.custom_deductions === 'string' ? JSON.parse(emp.custom_deductions) : []);

      const grossPay = basic + travel + housing + cell + other;
      const retireFund = Math.round(basic * (retirePct / 100) * 100) / 100;
      const age = calculateAgeFromIdNumber(String(emp.id_number || ''), new Date(periodEnd));
      const paye = calculateMonthlyPAYE(grossPay - retireFund, age);
      const uif = calculateUIF(grossPay);
      const customTotal = customDeds.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const totalDeds = paye + uif.employee + medical + retireFund + customTotal;
      const netPay = Math.round((grossPay - totalDeds) * 100) / 100;

      const ytd = (await sql`
        SELECT COALESCE(SUM(gross_pay),0) AS ytd_gross, COALESCE(SUM(paye),0) AS ytd_paye,
          COALESCE(SUM(uif_employee),0) AS ytd_uif
        FROM payslips ps JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE ps.employee_id = ${emp.id} AND pr.status IN ('draft','completed')
          AND pr.period_start >= DATE_TRUNC('year', ${periodStart}::DATE + INTERVAL '2 months') - INTERVAL '2 months'
      `) as Row[];

      const slipRows = (await sql`
        INSERT INTO payslips (
          payroll_run_id, employee_id, basic_salary, travel_allowance, housing_allowance,
          cell_allowance, other_allowances, gross_pay, paye, uif_employee, uif_employer,
          sdl, medical_aid, retirement_fund, other_deductions, total_deductions, net_pay,
          ytd_gross, ytd_paye, ytd_uif
        ) VALUES (
          ${runId}::UUID, ${emp.id}::UUID, ${basic}, ${travel}, ${housing}, ${cell}, ${other},
          ${grossPay}, ${paye}, ${uif.employee}, ${uif.employer}, ${0}, ${medical},
          ${retireFund}, ${customTotal}, ${totalDeds}, ${netPay},
          ${Number(ytd[0]?.ytd_gross || 0) + grossPay},
          ${Number(ytd[0]?.ytd_paye || 0) + paye},
          ${Number(ytd[0]?.ytd_uif || 0) + uif.employee}
        ) RETURNING *
      `) as Row[];

      totalGross += grossPay; totalPaye += paye;
      totalUifEmployee += uif.employee; totalUifEmployer += uif.employer; totalNet += netPay;

      payslips.push({
        ...mapPayslip(slipRows[0]!),
        employee_number: String(emp.employee_number), first_name: String(emp.first_name),
        last_name: String(emp.last_name),
        id_number: emp.id_number ? String(emp.id_number) : undefined,
        tax_number: emp.tax_number ? String(emp.tax_number) : undefined,
        department: emp.department ? String(emp.department) : undefined,
        position: emp.position ? String(emp.position) : undefined,
      });
    }

    const totalSdl = calculateSDL(totalGross);
    for (const slip of payslips) {
      const sdlShare = totalGross > 0 ? Math.round((slip.gross_pay / totalGross) * totalSdl * 100) / 100 : 0;
      await sql`UPDATE payslips SET sdl = ${sdlShare} WHERE id = ${slip.id}::UUID`;
      slip.sdl = sdlShare;
    }

    const totalCompanyCost = Math.round((totalGross + totalUifEmployer + totalSdl) * 100) / 100;
    await sql`
      UPDATE payroll_runs SET total_gross=${totalGross}, total_paye=${totalPaye},
        total_uif_employee=${totalUifEmployee}, total_uif_employer=${totalUifEmployer},
        total_sdl=${totalSdl}, total_net=${totalNet}, total_company_cost=${totalCompanyCost}
      WHERE id = ${runId}::UUID
    `;

    log.info('Payroll run created', { runId, employees: empRows.length, totalGross, totalNet }, 'payroll');
    return {
      ...mapPayrollRun({ ...runRows[0]!, total_gross: totalGross, total_paye: totalPaye,
        total_uif_employee: totalUifEmployee, total_uif_employer: totalUifEmployer,
        total_sdl: totalSdl, total_net: totalNet, total_company_cost: totalCompanyCost }),
      payslips,
    };
  } catch (err) {
    log.error('createPayrollRun failed', { error: err }, 'payroll');
    throw err;
  }
}

export async function completePayrollRun(
  companyId: string,
  runId: string,
  userId: string
): Promise<PayrollRun> {
  try {
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];
    if (runRows.length === 0) throw new Error('Payroll run not found');
    if (String(runRows[0]!.status) !== 'draft') throw new Error('Can only complete draft payroll runs');

    const run = runRows[0]!;
    const accounts = await resolvePayrollGLAccounts();
    const lines = buildPayrollJournalLines(accounts, {
      totalGross: Number(run.total_gross),
      totalPaye: Number(run.total_paye),
      totalUifEmployee: Number(run.total_uif_employee),
      totalUifEmployer: Number(run.total_uif_employer),
      totalSdl: Number(run.total_sdl),
    });

    const journalEntry = await createJournalEntry(companyId, {
      entryDate: String(run.period_end),
      description: `Payroll for period ${run.period_start} to ${run.period_end}`,
      source: 'manual',
      lines,
    }, userId);

    await postJournalEntry(companyId, journalEntry.id, userId);

    const updatedRows = (await sql`
      UPDATE payroll_runs SET status='completed', journal_entry_id=${journalEntry.id}::UUID
      WHERE id = ${runId} RETURNING *
    `) as Row[];

    log.info('Payroll run completed', { runId, journalEntryId: journalEntry.id }, 'payroll');
    return mapPayrollRun(updatedRows[0]!);
  } catch (err) {
    log.error('completePayrollRun failed', { runId, error: err }, 'payroll');
    throw err;
  }
}

export async function reversePayrollRun(
  companyId: string,
  runId: string,
  userId: string
): Promise<PayrollRun> {
  try {
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];
    if (runRows.length === 0) throw new Error('Payroll run not found');
    if (String(runRows[0]!.status) !== 'completed') throw new Error('Can only reverse completed payroll runs');

    if (runRows[0]!.journal_entry_id) {
      const { reverseJournalEntry } = await import('@/modules/accounting/services/journalEntryService');
      await reverseJournalEntry(companyId, String(runRows[0]!.journal_entry_id), userId);
    }

    const updatedRows = (await sql`
      UPDATE payroll_runs SET status='reversed' WHERE id = ${runId} RETURNING *
    `) as Row[];

    log.info('Payroll run reversed', { runId }, 'payroll');
    return mapPayrollRun(updatedRows[0]!);
  } catch (err) {
    log.error('reversePayrollRun failed', { runId, error: err }, 'payroll');
    throw err;
  }
}
