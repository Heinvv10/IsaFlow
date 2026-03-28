/**
 * Payroll Service
 * Handles employee management, payroll runs, payslip generation,
 * and GL journal posting for SA payroll.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  calculateMonthlyPAYE,
  calculateUIF,
  calculateSDL,
  calculateAgeFromIdNumber,
} from './taxTables';
import type {
  EmployeeWithPay,
  PayStructure,
  PayrollRun,
  PayrollRunWithPayslips,
  Payslip,
  CreateEmployeeInput,
  UpdateEmployeeInput,
  CustomDeduction,
} from './types';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/journalEntryService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ── Employee Functions ──────────────────────────────────────────────────────

export async function listEmployees(
  companyId: string,
  search?: string,
  statusFilter?: string
): Promise<EmployeeWithPay[]> {
  try {
    const searchTerm = search ? `%${search}%` : null;
    let rows: Row[];

    if (searchTerm && statusFilter) {
      rows = (await sql`
        SELECT e.*,
          ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
          ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
          ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
          ps.custom_deductions, ps.effective_from, ps.effective_to
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT * FROM pay_structures p
          WHERE p.employee_id = e.id
            AND p.effective_from <= CURRENT_DATE
            AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
          ORDER BY p.effective_from DESC
          LIMIT 1
        ) ps ON TRUE
        WHERE e.company_id = ${companyId}::UUID
          AND e.status = ${statusFilter}
          AND (
            e.first_name ILIKE ${searchTerm}
            OR e.last_name ILIKE ${searchTerm}
            OR e.employee_number ILIKE ${searchTerm}
            OR e.department ILIKE ${searchTerm}
          )
        ORDER BY e.employee_number ASC
        LIMIT 200
      `) as Row[];
    } else if (searchTerm) {
      rows = (await sql`
        SELECT e.*,
          ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
          ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
          ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
          ps.custom_deductions, ps.effective_from, ps.effective_to
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT * FROM pay_structures p
          WHERE p.employee_id = e.id
            AND p.effective_from <= CURRENT_DATE
            AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
          ORDER BY p.effective_from DESC
          LIMIT 1
        ) ps ON TRUE
        WHERE e.company_id = ${companyId}::UUID
          AND (
            e.first_name ILIKE ${searchTerm}
            OR e.last_name ILIKE ${searchTerm}
            OR e.employee_number ILIKE ${searchTerm}
            OR e.department ILIKE ${searchTerm}
          )
        ORDER BY e.employee_number ASC
        LIMIT 200
      `) as Row[];
    } else if (statusFilter) {
      rows = (await sql`
        SELECT e.*,
          ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
          ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
          ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
          ps.custom_deductions, ps.effective_from, ps.effective_to
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT * FROM pay_structures p
          WHERE p.employee_id = e.id
            AND p.effective_from <= CURRENT_DATE
            AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
          ORDER BY p.effective_from DESC
          LIMIT 1
        ) ps ON TRUE
        WHERE e.company_id = ${companyId}::UUID
          AND e.status = ${statusFilter}
        ORDER BY e.employee_number ASC
        LIMIT 200
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT e.*,
          ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
          ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
          ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
          ps.custom_deductions, ps.effective_from, ps.effective_to
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT * FROM pay_structures p
          WHERE p.employee_id = e.id
            AND p.effective_from <= CURRENT_DATE
            AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
          ORDER BY p.effective_from DESC
          LIMIT 1
        ) ps ON TRUE
        WHERE e.company_id = ${companyId}::UUID
        ORDER BY e.employee_number ASC
        LIMIT 200
      `) as Row[];
    }

    return rows.map(mapEmployeeWithPay);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('does not exist')) return [];
    log.error('listEmployees failed', { error: message }, 'payroll');
    throw err;
  }
}

export async function getEmployee(companyId: string, id: string): Promise<EmployeeWithPay | null> {
  try {
    const rows = (await sql`
      SELECT e.*,
        ps.id AS ps_id, ps.basic_salary, ps.travel_allowance,
        ps.housing_allowance, ps.cell_allowance, ps.other_allowances,
        ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
        ps.custom_deductions, ps.effective_from, ps.effective_to
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT * FROM pay_structures p
        WHERE p.employee_id = e.id
          AND p.effective_from <= CURRENT_DATE
          AND (p.effective_to IS NULL OR p.effective_to >= CURRENT_DATE)
        ORDER BY p.effective_from DESC
        LIMIT 1
      ) ps ON TRUE
      WHERE e.id = ${id}
        AND e.company_id = ${companyId}::UUID
    `) as Row[];

    if (rows.length === 0) return null;
    return mapEmployeeWithPay(rows[0]!);
  } catch (err) {
    log.error('getEmployee failed', { id, error: err }, 'payroll');
    throw err;
  }
}

export async function getEmployeePayHistory(
  companyId: string,
  employeeId: string
): Promise<PayStructure[]> {
  try {
    const rows = (await sql`
      SELECT ps.* FROM pay_structures ps
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.employee_id = ${employeeId}
        AND e.company_id = ${companyId}::UUID
      ORDER BY ps.effective_from DESC
    `) as Row[];
    return rows.map(mapPayStructure);
  } catch (err) {
    log.error('getEmployeePayHistory failed', { employeeId, error: err }, 'payroll');
    throw err;
  }
}

export async function getEmployeePayslips(
  companyId: string,
  employeeId: string
): Promise<Payslip[]> {
  try {
    const rows = (await sql`
      SELECT ps.*, pr.period_start, pr.period_end
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      JOIN employees e ON e.id = ps.employee_id
      WHERE ps.employee_id = ${employeeId}
        AND e.company_id = ${companyId}::UUID
      ORDER BY pr.period_end DESC
    `) as Row[];
    return rows.map(mapPayslip);
  } catch (err) {
    log.error('getEmployeePayslips failed', { employeeId, error: err }, 'payroll');
    throw err;
  }
}

export async function createEmployee(
  companyId: string,
  input: CreateEmployeeInput
): Promise<EmployeeWithPay> {
  try {
    // Create employee record
    const empRows = (await sql`
      INSERT INTO employees (
        company_id, employee_number, first_name, last_name, id_number, tax_number,
        start_date, termination_date, bank_name, bank_account_number,
        bank_branch_code, department, position, employment_type,
        pay_frequency, status
      ) VALUES (
        ${companyId}::UUID,
        ${input.employee_number},
        ${input.first_name},
        ${input.last_name},
        ${input.id_number || null},
        ${input.tax_number || null},
        ${input.start_date},
        ${input.termination_date || null},
        ${input.bank_name || null},
        ${input.bank_account_number || null},
        ${input.bank_branch_code || null},
        ${input.department || null},
        ${input.position || null},
        ${input.employment_type || 'permanent'},
        ${input.pay_frequency || 'monthly'},
        ${input.status || 'active'}
      )
      RETURNING *
    `) as Row[];

    const employeeId = String(empRows[0]!.id);
    const customDeds = JSON.stringify(input.custom_deductions || []);

    // Create initial pay structure
    await sql`
      INSERT INTO pay_structures (
        employee_id, basic_salary, travel_allowance, housing_allowance,
        cell_allowance, other_allowances, medical_aid_contribution,
        retirement_fund_contribution_pct, custom_deductions, effective_from
      ) VALUES (
        ${employeeId}::UUID,
        ${input.basic_salary},
        ${input.travel_allowance || 0},
        ${input.housing_allowance || 0},
        ${input.cell_allowance || 0},
        ${input.other_allowances || 0},
        ${input.medical_aid_contribution || 0},
        ${input.retirement_fund_contribution_pct || 0},
        ${customDeds}::JSONB,
        ${input.start_date}
      )
    `;

    log.info('Employee created', {
      id: employeeId,
      number: input.employee_number,
    }, 'payroll');

    const employee = await getEmployee(companyId, employeeId);
    if (!employee) throw new Error('Failed to retrieve created employee');
    return employee;
  } catch (err) {
    log.error('createEmployee failed', { error: err }, 'payroll');
    throw err;
  }
}

export async function updateEmployee(
  companyId: string,
  id: string,
  input: UpdateEmployeeInput
): Promise<EmployeeWithPay> {
  try {
    // Update employee fields (scoped to company)
    await sql`
      UPDATE employees SET
        first_name = COALESCE(${input.first_name ?? null}, first_name),
        last_name = COALESCE(${input.last_name ?? null}, last_name),
        id_number = COALESCE(${input.id_number ?? null}, id_number),
        tax_number = COALESCE(${input.tax_number ?? null}, tax_number),
        termination_date = COALESCE(${input.termination_date ?? null}, termination_date),
        bank_name = COALESCE(${input.bank_name ?? null}, bank_name),
        bank_account_number = COALESCE(${input.bank_account_number ?? null}, bank_account_number),
        bank_branch_code = COALESCE(${input.bank_branch_code ?? null}, bank_branch_code),
        department = COALESCE(${input.department ?? null}, department),
        position = COALESCE(${input.position ?? null}, position),
        employment_type = COALESCE(${input.employment_type ?? null}, employment_type),
        pay_frequency = COALESCE(${input.pay_frequency ?? null}, pay_frequency),
        status = COALESCE(${input.status ?? null}, status),
        updated_at = NOW()
      WHERE id = ${id}
        AND company_id = ${companyId}::UUID
    `;

    // If pay fields provided, create new pay structure record
    if (input.basic_salary !== undefined) {
      // Close the current pay structure
      await sql`
        UPDATE pay_structures
        SET effective_to = CURRENT_DATE - INTERVAL '1 day'
        WHERE employee_id = ${id}::UUID
          AND effective_to IS NULL
      `;

      const customDeds = JSON.stringify(input.custom_deductions || []);

      await sql`
        INSERT INTO pay_structures (
          employee_id, basic_salary, travel_allowance, housing_allowance,
          cell_allowance, other_allowances, medical_aid_contribution,
          retirement_fund_contribution_pct, custom_deductions, effective_from
        ) VALUES (
          ${id}::UUID,
          ${input.basic_salary},
          ${input.travel_allowance || 0},
          ${input.housing_allowance || 0},
          ${input.cell_allowance || 0},
          ${input.other_allowances || 0},
          ${input.medical_aid_contribution || 0},
          ${input.retirement_fund_contribution_pct || 0},
          ${customDeds}::JSONB,
          CURRENT_DATE
        )
      `;
    }

    log.info('Employee updated', { id }, 'payroll');

    const employee = await getEmployee(companyId, id);
    if (!employee) throw new Error('Employee not found');
    return employee;
  } catch (err) {
    log.error('updateEmployee failed', { id, error: err }, 'payroll');
    throw err;
  }
}

// ── Payroll Run Functions ───────────────────────────────────────────────────

export async function createPayrollRun(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  userId: string
): Promise<PayrollRunWithPayslips> {
  try {
    // Get all active employees with current pay structures (scoped to company)
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
        ORDER BY p.effective_from DESC
        LIMIT 1
      ) ps ON TRUE
      WHERE e.company_id = ${companyId}::UUID
        AND e.status = 'active'
        AND e.start_date <= ${periodEnd}::DATE
        AND (e.termination_date IS NULL OR e.termination_date >= ${periodStart}::DATE)
      ORDER BY e.employee_number
    `) as Row[];

    if (empRows.length === 0) {
      throw new Error('No active employees found for this period');
    }

    // Create the payroll run record
    const runRows = (await sql`
      INSERT INTO payroll_runs (company_id, period_start, period_end, status, created_by)
      VALUES (${companyId}::UUID, ${periodStart}, ${periodEnd}, 'draft', ${userId}::UUID)
      RETURNING *
    `) as Row[];

    const runId = String(runRows[0]!.id);

    let totalGross = 0;
    let totalPaye = 0;
    let totalUifEmployee = 0;
    let totalUifEmployer = 0;
    let totalNet = 0;
    const payslips: Payslip[] = [];

    // Process each employee
    for (const emp of empRows) {
      const basicSalary = Number(emp.basic_salary) || 0;
      const travelAllowance = Number(emp.travel_allowance) || 0;
      const housingAllowance = Number(emp.housing_allowance) || 0;
      const cellAllowance = Number(emp.cell_allowance) || 0;
      const otherAllowances = Number(emp.other_allowances) || 0;
      const medicalAidContrib = Number(emp.medical_aid_contribution) || 0;
      const retirementPct = Number(emp.retirement_fund_contribution_pct) || 0;
      const customDeds: CustomDeduction[] = Array.isArray(emp.custom_deductions)
        ? emp.custom_deductions
        : (typeof emp.custom_deductions === 'string'
          ? JSON.parse(emp.custom_deductions)
          : []);

      // Gross pay
      const grossPay = basicSalary + travelAllowance + housingAllowance +
        cellAllowance + otherAllowances;

      // Retirement fund deduction (employee contribution)
      const retirementFund = Math.round(basicSalary * (retirementPct / 100) * 100) / 100;

      // Taxable income: gross minus retirement fund deduction
      // (retirement is deductible up to limits, simplified here)
      const monthlyTaxable = grossPay - retirementFund;

      // Age from ID number
      const age = calculateAgeFromIdNumber(
        String(emp.id_number || ''),
        new Date(periodEnd)
      );

      // PAYE
      const paye = calculateMonthlyPAYE(monthlyTaxable, age);

      // UIF (on basic salary + allowances, excluding certain items)
      const uif = calculateUIF(grossPay);

      // Custom deductions total
      const customDeductionsTotal = customDeds.reduce(
        (sum, d) => sum + (Number(d.amount) || 0), 0
      );

      // Total deductions
      const totalDeductions = paye + uif.employee + medicalAidContrib +
        retirementFund + customDeductionsTotal;

      // Net pay
      const netPay = Math.round((grossPay - totalDeductions) * 100) / 100;

      // YTD calculations
      const ytdRows = (await sql`
        SELECT
          COALESCE(SUM(gross_pay), 0) AS ytd_gross,
          COALESCE(SUM(paye), 0) AS ytd_paye,
          COALESCE(SUM(uif_employee), 0) AS ytd_uif
        FROM payslips ps
        JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE ps.employee_id = ${emp.id}
          AND pr.status IN ('draft', 'completed')
          AND pr.period_start >= DATE_TRUNC('year', ${periodStart}::DATE + INTERVAL '2 months') - INTERVAL '2 months'
      `) as Row[];

      const ytdGross = Number(ytdRows[0]?.ytd_gross || 0) + grossPay;
      const ytdPaye = Number(ytdRows[0]?.ytd_paye || 0) + paye;
      const ytdUif = Number(ytdRows[0]?.ytd_uif || 0) + uif.employee;

      // Insert payslip
      const slipRows = (await sql`
        INSERT INTO payslips (
          payroll_run_id, employee_id, basic_salary, travel_allowance,
          housing_allowance, cell_allowance, other_allowances, gross_pay,
          paye, uif_employee, uif_employer, sdl, medical_aid,
          retirement_fund, other_deductions, total_deductions, net_pay,
          ytd_gross, ytd_paye, ytd_uif
        ) VALUES (
          ${runId}::UUID, ${emp.id}::UUID,
          ${basicSalary}, ${travelAllowance}, ${housingAllowance},
          ${cellAllowance}, ${otherAllowances}, ${grossPay},
          ${paye}, ${uif.employee}, ${uif.employer}, ${0},
          ${medicalAidContrib}, ${retirementFund}, ${customDeductionsTotal},
          ${totalDeductions}, ${netPay},
          ${ytdGross}, ${ytdPaye}, ${ytdUif}
        )
        RETURNING *
      `) as Row[];

      totalGross += grossPay;
      totalPaye += paye;
      totalUifEmployee += uif.employee;
      totalUifEmployer += uif.employer;
      totalNet += netPay;

      payslips.push({
        ...mapPayslip(slipRows[0]!),
        employee_number: String(emp.employee_number),
        first_name: String(emp.first_name),
        last_name: String(emp.last_name),
        id_number: emp.id_number ? String(emp.id_number) : undefined,
        tax_number: emp.tax_number ? String(emp.tax_number) : undefined,
        department: emp.department ? String(emp.department) : undefined,
        position: emp.position ? String(emp.position) : undefined,
      });
    }

    // Calculate SDL on total gross
    const totalSdl = calculateSDL(totalGross);

    // Update payslips with SDL (distribute proportionally)
    for (const slip of payslips) {
      const sdlShare = totalGross > 0
        ? Math.round((slip.gross_pay / totalGross) * totalSdl * 100) / 100
        : 0;
      await sql`
        UPDATE payslips SET sdl = ${sdlShare} WHERE id = ${slip.id}::UUID
      `;
      slip.sdl = sdlShare;
    }

    // Total company cost = gross + employer UIF + SDL
    const totalCompanyCost = Math.round(
      (totalGross + totalUifEmployer + totalSdl) * 100
    ) / 100;

    // Update run totals
    await sql`
      UPDATE payroll_runs SET
        total_gross = ${totalGross},
        total_paye = ${totalPaye},
        total_uif_employee = ${totalUifEmployee},
        total_uif_employer = ${totalUifEmployer},
        total_sdl = ${totalSdl},
        total_net = ${totalNet},
        total_company_cost = ${totalCompanyCost}
      WHERE id = ${runId}::UUID
    `;

    log.info('Payroll run created', {
      runId,
      employees: empRows.length,
      totalGross,
      totalNet,
    }, 'payroll');

    return {
      ...mapPayrollRun({
        ...runRows[0]!,
        total_gross: totalGross,
        total_paye: totalPaye,
        total_uif_employee: totalUifEmployee,
        total_uif_employer: totalUifEmployer,
        total_sdl: totalSdl,
        total_net: totalNet,
        total_company_cost: totalCompanyCost,
      }),
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
    // Get the run (scoped to company)
    const runRows = (await sql`
      SELECT * FROM payroll_runs WHERE id = ${runId} AND company_id = ${companyId}::UUID
    `) as Row[];

    if (runRows.length === 0) throw new Error('Payroll run not found');
    if (String(runRows[0]!.status) !== 'draft') {
      throw new Error('Can only complete draft payroll runs');
    }

    const run = runRows[0]!;
    const totalGross = Number(run.total_gross);
    const totalPaye = Number(run.total_paye);
    const totalUifEmployee = Number(run.total_uif_employee);
    const totalUifEmployer = Number(run.total_uif_employer);
    const totalSdl = Number(run.total_sdl);
    const _totalNet = Number(run.total_net);

    // Look up GL account IDs by account code
    // We need: Salaries expense, PAYE payable, UIF payable, SDL payable, Bank
    const accountRows = (await sql`
      SELECT id, account_code, account_name FROM gl_accounts
      WHERE account_code IN ('6000', '6010', '2200', '2210', '2220', '2230', '1000', '1100')
      ORDER BY account_code
    `) as Row[];

    const accountMap: Record<string, string> = {};
    for (const acc of accountRows) {
      accountMap[String(acc.account_code)] = String(acc.id);
    }

    // Use common expense/liability account codes or find by name
    const salariesAccountId = accountMap['6000'] || accountMap['6010'];
    const payePayableId = accountMap['2200'] || accountMap['2210'];
    const uifPayableId = accountMap['2220'] || accountMap['2210'];
    const sdlPayableId = accountMap['2230'] || accountMap['2210'];
    const bankAccountId = accountMap['1000'] || accountMap['1100'];

    if (!salariesAccountId || !bankAccountId) {
      // Try to find by name patterns
      const fallbackRows = (await sql`
        SELECT id, account_code, account_name, account_type FROM gl_accounts
        WHERE account_name ILIKE '%salar%'
          OR account_name ILIKE '%wage%'
          OR account_name ILIKE '%paye%'
          OR account_name ILIKE '%uif%'
          OR account_name ILIKE '%sdl%'
          OR account_name ILIKE '%bank%'
          OR account_type = 'asset'
        ORDER BY account_code
        LIMIT 20
      `) as Row[];

      for (const acc of fallbackRows) {
        const name = String(acc.account_name).toLowerCase();
        const id = String(acc.id);
        if (!salariesAccountId && (name.includes('salar') || name.includes('wage'))) {
          accountMap['salaries'] = id;
        }
        if (!payePayableId && name.includes('paye')) {
          accountMap['paye'] = id;
        }
        if (!uifPayableId && name.includes('uif')) {
          accountMap['uif'] = id;
        }
        if (!sdlPayableId && name.includes('sdl')) {
          accountMap['sdl'] = id;
        }
        if (!bankAccountId && name.includes('bank') && String(acc.account_type) === 'asset') {
          accountMap['bank'] = id;
        }
      }
    }

    const finalSalariesId = salariesAccountId || accountMap['salaries'];
    const finalPayeId = payePayableId || accountMap['paye'];
    const finalUifId = uifPayableId || accountMap['uif'];
    const finalSdlId = sdlPayableId || accountMap['sdl'];
    const finalBankId = bankAccountId || accountMap['bank'];

    if (!finalSalariesId || !finalBankId) {
      throw new Error(
        'Required GL accounts not found. Please set up Salaries/Wages expense and Bank accounts in your Chart of Accounts.'
      );
    }

    // Build journal lines — balanced double-entry
    const periodEnd = String(run.period_end);
    const lines = [];

    // Debit: Salaries & Wages expense (gross + employer UIF + SDL = total company cost)
    const totalEmployerCost = totalGross + totalUifEmployer + totalSdl;
    lines.push({
      glAccountId: finalSalariesId,
      debit: totalEmployerCost,
      credit: 0,
      description: `Payroll - Salaries & Wages`,
    });

    // Credit: PAYE Payable
    if (totalPaye > 0 && finalPayeId) {
      lines.push({
        glAccountId: finalPayeId,
        debit: 0,
        credit: totalPaye,
        description: `Payroll - PAYE`,
      });
    }

    // Credit: UIF Payable (employee + employer)
    const totalUif = totalUifEmployee + totalUifEmployer;
    if (totalUif > 0 && finalUifId) {
      lines.push({
        glAccountId: finalUifId,
        debit: 0,
        credit: totalUif,
        description: `Payroll - UIF`,
      });
    }

    // Credit: SDL Payable
    if (totalSdl > 0 && finalSdlId) {
      lines.push({
        glAccountId: finalSdlId,
        debit: 0,
        credit: totalSdl,
        description: `Payroll - SDL`,
      });
    }

    // Credit: Bank (net pay)
    // Calculate credit to bank as balancing figure
    const totalCreditsAbove = totalPaye +
      (finalUifId ? totalUif : 0) +
      (finalSdlId ? totalSdl : 0);

    // If some liability accounts are missing, add those amounts to bank
    const bankCredit = totalEmployerCost - totalCreditsAbove;
    lines.push({
      glAccountId: finalBankId,
      debit: 0,
      credit: Math.round(bankCredit * 100) / 100,
      description: `Payroll - Net Pay`,
    });

    // Create journal entry
    const journalEntry = await createJournalEntry(companyId, {
      entryDate: periodEnd,
      description: `Payroll for period ${run.period_start} to ${run.period_end}`,
      source: 'manual',
      lines,
    }, userId);

    // Post the journal entry
    await postJournalEntry(companyId, journalEntry.id, userId);

    // Update payroll run status
    const updatedRows = (await sql`
      UPDATE payroll_runs SET
        status = 'completed',
        journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${runId}
      RETURNING *
    `) as Row[];

    log.info('Payroll run completed', {
      runId,
      journalEntryId: journalEntry.id,
    }, 'payroll');

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
    if (String(runRows[0]!.status) !== 'completed') {
      throw new Error('Can only reverse completed payroll runs');
    }

    // Reverse the journal entry if it exists
    if (runRows[0]!.journal_entry_id) {
      const { reverseJournalEntry } = await import(
        '@/modules/accounting/services/journalEntryService'
      );
      await reverseJournalEntry(
        companyId, String(runRows[0]!.journal_entry_id), userId
      );
    }

    const updatedRows = (await sql`
      UPDATE payroll_runs SET status = 'reversed'
      WHERE id = ${runId}
      RETURNING *
    `) as Row[];

    log.info('Payroll run reversed', { runId }, 'payroll');
    return mapPayrollRun(updatedRows[0]!);
  } catch (err) {
    log.error('reversePayrollRun failed', { runId, error: err }, 'payroll');
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

// ── Mapping Functions ───────────────────────────────────────────────────────

function mapEmployeeWithPay(row: Row): EmployeeWithPay {
  return {
    id: String(row.id),
    employee_number: String(row.employee_number),
    first_name: String(row.first_name),
    last_name: String(row.last_name),
    id_number: row.id_number ? String(row.id_number) : null,
    tax_number: row.tax_number ? String(row.tax_number) : null,
    start_date: String(row.start_date),
    termination_date: row.termination_date ? String(row.termination_date) : null,
    bank_name: row.bank_name ? String(row.bank_name) : null,
    bank_account_number: row.bank_account_number ? String(row.bank_account_number) : null,
    bank_branch_code: row.bank_branch_code ? String(row.bank_branch_code) : null,
    department: row.department ? String(row.department) : null,
    position: row.position ? String(row.position) : null,
    employment_type: String(row.employment_type) as EmployeeWithPay['employment_type'],
    pay_frequency: String(row.pay_frequency) as EmployeeWithPay['pay_frequency'],
    status: String(row.status) as EmployeeWithPay['status'],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    pay_structure: row.ps_id ? {
      id: String(row.ps_id),
      employee_id: String(row.id),
      basic_salary: Number(row.basic_salary) || 0,
      travel_allowance: Number(row.travel_allowance) || 0,
      housing_allowance: Number(row.housing_allowance) || 0,
      cell_allowance: Number(row.cell_allowance) || 0,
      other_allowances: Number(row.other_allowances) || 0,
      medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
      retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
      custom_deductions: Array.isArray(row.custom_deductions)
        ? row.custom_deductions
        : (typeof row.custom_deductions === 'string'
          ? JSON.parse(row.custom_deductions)
          : []),
      effective_from: String(row.effective_from),
      effective_to: row.effective_to ? String(row.effective_to) : null,
      created_at: String(row.created_at),
    } : null,
  };
}

function mapPayStructure(row: Row): PayStructure {
  return {
    id: String(row.id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
    retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
    custom_deductions: Array.isArray(row.custom_deductions)
      ? row.custom_deductions
      : (typeof row.custom_deductions === 'string'
        ? JSON.parse(row.custom_deductions)
        : []),
    effective_from: String(row.effective_from),
    effective_to: row.effective_to ? String(row.effective_to) : null,
    created_at: String(row.created_at),
  };
}

function mapPayrollRun(row: Row): PayrollRun {
  return {
    id: String(row.id),
    period_start: String(row.period_start),
    period_end: String(row.period_end),
    run_date: String(row.run_date),
    status: String(row.status) as PayrollRun['status'],
    total_gross: Number(row.total_gross) || 0,
    total_paye: Number(row.total_paye) || 0,
    total_uif_employee: Number(row.total_uif_employee) || 0,
    total_uif_employer: Number(row.total_uif_employer) || 0,
    total_sdl: Number(row.total_sdl) || 0,
    total_net: Number(row.total_net) || 0,
    total_company_cost: Number(row.total_company_cost) || 0,
    journal_entry_id: row.journal_entry_id ? String(row.journal_entry_id) : null,
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at),
  };
}

function mapPayslip(row: Row): Payslip {
  return {
    id: String(row.id),
    payroll_run_id: String(row.payroll_run_id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    gross_pay: Number(row.gross_pay) || 0,
    paye: Number(row.paye) || 0,
    uif_employee: Number(row.uif_employee) || 0,
    uif_employer: Number(row.uif_employer) || 0,
    sdl: Number(row.sdl) || 0,
    medical_aid: Number(row.medical_aid) || 0,
    retirement_fund: Number(row.retirement_fund) || 0,
    other_deductions: Number(row.other_deductions) || 0,
    total_deductions: Number(row.total_deductions) || 0,
    net_pay: Number(row.net_pay) || 0,
    ytd_gross: Number(row.ytd_gross) || 0,
    ytd_paye: Number(row.ytd_paye) || 0,
    ytd_uif: Number(row.ytd_uif) || 0,
    created_at: String(row.created_at),
  };
}
