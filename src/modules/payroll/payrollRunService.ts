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
  calculateMedicalCredits,
} from './taxTables';
import type {
  PayrollRun,
  PayrollRunWithPayslips,
  Payslip,
  CustomDeduction,
} from './types';
import { mapPayrollRun, mapPayslip } from './payrollMappers';
import { buildSarsBreakdown, computeEti } from './payrollRunHelpers';

export { completePayrollRun, reversePayrollRun } from './payrollRunActions';

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
        ps.cell_allowance, ps.other_allowances, ps.annual_bonus, ps.commission,
        ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
        ps.custom_deductions,
        ps.basic_salary_code, ps.travel_allowance_code, ps.housing_allowance_code,
        ps.cell_allowance_code, ps.other_allowances_code,
        ps.annual_bonus_code, ps.commission_code
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

    // Batch-fetch YTD totals for all employees (avoids N+1)
    const empIds = empRows.map(e => String(e.id));
    const ytdRows = (await sql`
      SELECT ps.employee_id,
        COALESCE(SUM(ps.gross_pay),0) AS ytd_gross,
        COALESCE(SUM(ps.paye),0) AS ytd_paye,
        COALESCE(SUM(ps.uif_employee),0) AS ytd_uif
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE ps.employee_id = ANY(${empIds}::UUID[])
        AND pr.company_id = ${companyId}::UUID
        AND pr.status IN ('draft','completed')
        AND pr.period_start >= DATE_TRUNC('year', ${periodStart}::DATE + INTERVAL '2 months') - INTERVAL '2 months'
      GROUP BY ps.employee_id
    `) as Row[];
    const ytdMap = new Map<string, { gross: number; paye: number; uif: number }>();
    for (const r of ytdRows) {
      ytdMap.set(String(r.employee_id), {
        gross: Number(r.ytd_gross) || 0,
        paye: Number(r.ytd_paye) || 0,
        uif: Number(r.ytd_uif) || 0,
      });
    }

    const runRows = (await sql`
      INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by)
      VALUES (${companyId}::UUID, ${periodStart}, ${periodEnd}, 'draft', ${userId}::UUID)
      RETURNING *
    `) as Row[];

    const runId = String(runRows[0]!.id);
    let totalGross = 0, totalPaye = 0, totalUifEmployee = 0, totalUifEmployer = 0, totalNet = 0;
    let totalEti = 0;
    const payslips: Payslip[] = [];

    for (const emp of empRows) {
      const n = (k: string) => Number(emp[k]) || 0;
      const basic = n('basic_salary'), travel = n('travel_allowance'), housing = n('housing_allowance');
      const cell = n('cell_allowance'), other = n('other_allowances');
      const annualBonus = n('annual_bonus'), commission = n('commission');
      const medical = n('medical_aid_contribution'), retirePct = n('retirement_fund_contribution_pct');
      const customDeds: CustomDeduction[] = Array.isArray(emp.custom_deductions)
        ? emp.custom_deductions
        : (typeof emp.custom_deductions === 'string' ? JSON.parse(emp.custom_deductions) : []);

      const taxableTravel = Math.round(travel * ((n('travel_taxable_pct') || 80) / 100) * 100) / 100;
      const grossPay = basic + travel + housing + cell + other + annualBonus + commission;
      const taxableGross = basic + taxableTravel + housing + cell + other + annualBonus + commission;
      const retireFund = Math.round(basic * (retirePct / 100) * 100) / 100;
      const age = calculateAgeFromIdNumber(String(emp.id_number || ''), new Date(periodEnd));
      const grossPaye = calculateMonthlyPAYE(taxableGross - retireFund, age);
      const medicalCredit = calculateMedicalCredits(Boolean(emp.medical_aid_main_member), n('medical_aid_dependants'));
      const paye = Math.max(0, Math.round((grossPaye - medicalCredit) * 100) / 100);
      const uif = calculateUIF(grossPay);

      // ETI — employer-side, does NOT reduce payslip net pay
      const { etiAmount, etiMonths } = computeEti(emp, grossPay, periodEnd);

      const customTotal = customDeds.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const totalDeds = paye + uif.employee + medical + retireFund + customTotal;
      const netPay = Math.round((grossPay - totalDeds) * 100) / 100;

      const ytd = ytdMap.get(String(emp.id)) ?? { gross: 0, paye: 0, uif: 0 };

      const sarsBreakdown = buildSarsBreakdown({
        basic, basicCode: String(emp.basic_salary_code || '3601'),
        travel, travelCode: String(emp.travel_allowance_code || '3713'),
        housing, housingCode: String(emp.housing_allowance_code || '3802'),
        cell, cellCode: String(emp.cell_allowance_code || '3713'),
        other, otherCode: String(emp.other_allowances_code || '3601'),
        annualBonus, bonusCode: String(emp.annual_bonus_code || '3605'),
        commission, commissionCode: String(emp.commission_code || '3606'),
        paye, uifEmployee: uif.employee, retireFund, medical, etiAmount,
      });

      const slipRows = (await sql`
        INSERT INTO payslips (
          payroll_run_id, employee_id, basic_salary, travel_allowance, housing_allowance,
          cell_allowance, other_allowances, annual_bonus, commission,
          gross_pay, paye, uif_employee, uif_employer, sdl,
          medical_aid, medical_aid_credit, retirement_fund, other_deductions,
          total_deductions, net_pay,
          ytd_gross, ytd_paye, ytd_uif,
          eti_amount, eti_months, sars_breakdown
        ) VALUES (
          ${runId}::UUID, ${emp.id}::UUID, ${basic}, ${travel}, ${housing}, ${cell}, ${other},
          ${annualBonus}, ${commission},
          ${grossPay}, ${paye}, ${uif.employee}, ${uif.employer}, ${0},
          ${medical}, ${medicalCredit}, ${retireFund}, ${customTotal},
          ${totalDeds}, ${netPay},
          ${ytd.gross + grossPay},
          ${ytd.paye + paye},
          ${ytd.uif + uif.employee},
          ${etiAmount}, ${etiMonths}, ${JSON.stringify(sarsBreakdown)}::JSONB
        ) RETURNING *
      `) as Row[];

      totalGross += grossPay;
      totalPaye += paye;
      totalUifEmployee += uif.employee;
      totalUifEmployer += uif.employer;
      totalNet += netPay;
      totalEti += etiAmount;

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
        total_sdl=${totalSdl}, total_eti=${totalEti}, total_net=${totalNet},
        total_company_cost=${totalCompanyCost}
      WHERE id = ${runId}::UUID
    `;

    log.info('Payroll run created', { runId, employees: empRows.length, totalGross, totalNet }, 'payroll');
    return {
      ...mapPayrollRun({
        ...runRows[0]!,
        total_gross: totalGross, total_paye: totalPaye,
        total_uif_employee: totalUifEmployee, total_uif_employer: totalUifEmployer,
        total_sdl: totalSdl, total_eti: totalEti, total_net: totalNet,
        total_company_cost: totalCompanyCost
      }),
      payslips,
    };
  } catch (err) {
    log.error('createPayrollRun failed', { error: err }, 'payroll');
    throw err;
  }
}

