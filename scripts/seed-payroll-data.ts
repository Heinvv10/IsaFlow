/**
 * ISAFlow Payroll Demo Data Seeder
 * Populates PRD-02 payroll tables + UIF declarations + Tax directives
 * for the ISAFlow Demo company so the payroll pages have real data to display.
 *
 * Run with:
 *   export $(grep -E '^(MIGRATION_ADMIN_DATABASE_URL|DATABASE_URL)=' .env.local | xargs)
 *   npx tsx scripts/seed-payroll-data.ts
 *
 * Uses MIGRATION_ADMIN_DATABASE_URL (BYPASSRLS) so seed inserts bypass RLS policies.
 * Safe to re-run — cleanExisting() wipes the company scope first.
 */

import { createSql, closeSql } from './_pg';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: MIGRATION_ADMIN_DATABASE_URL or DATABASE_URL not set.');
  process.exit(1);
}

const sql = createSql(DATABASE_URL);

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';

/** UIF contribution ceiling for 2026 (monthly) */
const UIF_CEILING = 17712;

/** Employee deterministic UUIDs */
const EMP_IDS = Array.from({ length: 10 }, (_, i) =>
  `e1000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`
);

// ── Employee definitions ───────────────────────────────────────────────────────

interface EmployeeSpec {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string;
  tax_number: string;
  employment_type: 'permanent' | 'director' | 'contract';
  start_date: string;
  department: string;
  monthly_gross: number;
  equity_race: 'african' | 'coloured' | 'indian' | 'white';
  equity_gender: 'male' | 'female';
  uif_excluded: boolean;
}

const EMPLOYEES: EmployeeSpec[] = [
  // Directors
  {
    id: EMP_IDS[0]!, employee_number: 'EMP-001',
    first_name: 'Riaan', last_name: 'Mostert',
    id_number: '7201015026082', tax_number: '9012345678',
    employment_type: 'director', start_date: '2021-03-01',
    department: 'Executive', monthly_gross: 75000,
    equity_race: 'white', equity_gender: 'male', uif_excluded: false,
  },
  {
    id: EMP_IDS[1]!, employee_number: 'EMP-002',
    first_name: 'Naledi', last_name: 'Dlamini',
    id_number: '7808260501083', tax_number: '9123456780',
    employment_type: 'director', start_date: '2021-03-01',
    department: 'Executive', monthly_gross: 68000,
    equity_race: 'african', equity_gender: 'female', uif_excluded: false,
  },
  // Senior Accountants
  {
    id: EMP_IDS[2]!, employee_number: 'EMP-003',
    first_name: 'Pieter', last_name: 'van der Berg',
    id_number: '8405125082082', tax_number: '9234567801',
    employment_type: 'permanent', start_date: '2022-01-10',
    department: 'Accounting', monthly_gross: 42000,
    equity_race: 'white', equity_gender: 'male', uif_excluded: false,
  },
  {
    id: EMP_IDS[3]!, employee_number: 'EMP-004',
    first_name: 'Thandi', last_name: 'Nkosi',
    id_number: '9002280419083', tax_number: '9345678012',
    employment_type: 'permanent', start_date: '2022-06-01',
    department: 'Accounting', monthly_gross: 38500,
    equity_race: 'african', equity_gender: 'female', uif_excluded: false,
  },
  // Accountants
  {
    id: EMP_IDS[4]!, employee_number: 'EMP-005',
    first_name: 'Farouk', last_name: 'Adams',
    id_number: '9504075175080', tax_number: '9456780123',
    employment_type: 'permanent', start_date: '2023-02-01',
    department: 'Accounting', monthly_gross: 26500,
    equity_race: 'coloured', equity_gender: 'male', uif_excluded: false,
  },
  {
    id: EMP_IDS[5]!, employee_number: 'EMP-006',
    first_name: 'Priya', last_name: 'Govender',
    id_number: '9609214245082', tax_number: '9567801234',
    employment_type: 'permanent', start_date: '2023-05-15',
    department: 'Accounting', monthly_gross: 24000,
    equity_race: 'indian', equity_gender: 'female', uif_excluded: false,
  },
  {
    id: EMP_IDS[6]!, employee_number: 'EMP-007',
    first_name: 'Lungelo', last_name: 'Zulu',
    id_number: '9811035526084', tax_number: '9678012345',
    employment_type: 'permanent', start_date: '2024-01-08',
    department: 'Accounting', monthly_gross: 21500,
    equity_race: 'african', equity_gender: 'male', uif_excluded: false,
  },
  // Admin
  {
    id: EMP_IDS[7]!, employee_number: 'EMP-008',
    first_name: 'Sandra', last_name: 'Botha',
    id_number: '8801010100189', tax_number: '9780123456',
    employment_type: 'permanent', start_date: '2022-09-01',
    department: 'Administration', monthly_gross: 16500,
    equity_race: 'white', equity_gender: 'female', uif_excluded: false,
  },
  {
    id: EMP_IDS[8]!, employee_number: 'EMP-009',
    first_name: 'Moses', last_name: 'Sithole',
    id_number: '9203065457086', tax_number: '9801234567',
    employment_type: 'permanent', start_date: '2023-11-01',
    department: 'Administration', monthly_gross: 14000,
    equity_race: 'african', equity_gender: 'male', uif_excluded: false,
  },
  // Intern
  {
    id: EMP_IDS[9]!, employee_number: 'EMP-010',
    first_name: 'Anika', last_name: 'Pretorius',
    id_number: '0205050026081', tax_number: '9912345678',
    employment_type: 'contract', start_date: '2025-07-01',
    department: 'Accounting', monthly_gross: 8000,
    equity_race: 'white', equity_gender: 'female', uif_excluded: false,
  },
];

// ── Payroll calculation helpers ───────────────────────────────────────────────

/** Simplified PAYE — 2026 SA tax tables (annual brackets / rebates) */
function calcPAYE(monthlyGross: number): number {
  const annual = monthlyGross * 12;
  let tax = 0;
  if (annual <= 237100)      tax = annual * 0.18;
  else if (annual <= 370500) tax = 42678 + (annual - 237100) * 0.26;
  else if (annual <= 512800) tax = 77362 + (annual - 370500) * 0.31;
  else if (annual <= 673000) tax = 121475 + (annual - 512800) * 0.36;
  else if (annual <= 857900) tax = 179147 + (annual - 673000) * 0.39;
  else if (annual <= 1817000) tax = 251258 + (annual - 857900) * 0.41;
  else                        tax = 644489 + (annual - 1817000) * 0.45;
  // Primary rebate 2026
  const rebate = 17235;
  const netTax = Math.max(0, tax - rebate);
  return Math.round((netTax / 12) * 100) / 100;
}

/** UIF: 1% of gross capped at UIF_CEILING, both employee and employer */
function calcUIF(monthlyGross: number): number {
  return Math.round(Math.min(monthlyGross, UIF_CEILING) * 0.01 * 100) / 100;
}

// ── batchInsert ───────────────────────────────────────────────────────────────

async function batchInsert(
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return;
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const keys = Object.keys(chunk[0]!);
    const valPlaceholders = chunk
      .map((_, ri) =>
        `(${keys.map((_, ki) => `$${ri * keys.length + ki + 1}`).join(', ')})`
      )
      .join(', ');
    const vals = chunk.flatMap(r => keys.map(k => r[k]));
    await sql.query(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${valPlaceholders} ON CONFLICT DO NOTHING`,
      vals
    );
  }
}

// ── Table existence guard ─────────────────────────────────────────────────────

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await sql.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return rows[0]?.exists === true;
}

// ── CLEAN ─────────────────────────────────────────────────────────────────────

async function cleanExisting(): Promise<void> {
  console.log('[clean] Removing existing payroll data for company...');

  // FK child → parent order
  const safeDelete = async (table: string, where: string, params: unknown[]) => {
    if (!(await tableExists(table))) return;
    await sql.query(`DELETE FROM ${table} WHERE ${where}`, params);
  };

  // run lines before run headers
  await safeDelete(
    'payroll_run_lines',
    'run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)',
    [COMPANY_ID]
  );
  await safeDelete('payroll_run_headers', 'company_id = $1', [COMPANY_ID]);

  // leave requests + balances before employee + types
  await safeDelete('payroll_leave_requests', 'company_id = $1', [COMPANY_ID]);
  await safeDelete(
    'payroll_leave_balances',
    'employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)',
    [COMPANY_ID]
  );
  await safeDelete('payroll_leave_types', 'company_id = $1', [COMPANY_ID]);

  // employee components before employees
  await safeDelete(
    'payroll_employee_components',
    'employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)',
    [COMPANY_ID]
  );
  await safeDelete(
    'payroll_bank_details',
    'employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)',
    [COMPANY_ID]
  );
  await safeDelete('payroll_employees', 'company_id = $1', [COMPANY_ID]);
  await safeDelete('payroll_components', 'company_id = $1', [COMPANY_ID]);

  // top-level
  await safeDelete('uif_declarations', 'company_id = $1', [COMPANY_ID]);
  await safeDelete('tax_directives', 'company_id = $1', [COMPANY_ID]);

  console.log('[clean] Done.\n');
}

// ── 1. Employees ──────────────────────────────────────────────────────────────

async function seedEmployees(): Promise<void> {
  if (!(await tableExists('payroll_employees'))) {
    console.log('[employees] Table missing — skipped.');
    return;
  }

  const rows = EMPLOYEES.map(e => ({
    id: e.id,
    company_id: COMPANY_ID,
    employee_number: e.employee_number,
    first_name: e.first_name,
    last_name: e.last_name,
    id_number: e.id_number,
    tax_number: e.tax_number,
    employment_type: e.employment_type,
    start_date: e.start_date,
    status: 'active',
    department: e.department,
    equity_race: e.equity_race,
    equity_gender: e.equity_gender,
    equity_disability: false,
    uif_excluded: e.uif_excluded,
    medical_aid_main_member: true,
    medical_aid_dependants_count: e.employment_type === 'director' ? 2 : 0,
  }));

  await batchInsert('payroll_employees', rows);
  console.log(`[employees] Seeded ${rows.length} payroll employees.`);
}

// ── 2. Pay components ─────────────────────────────────────────────────────────

interface ComponentSpec {
  id: string;
  name: string;
  sars_source_code: string;
  component_type: 'earning' | 'deduction' | 'employer_contribution';
  is_taxable: boolean;
  is_uif_applicable: boolean;
  is_sdl_applicable: boolean;
}

const COMP_IDS = {
  basic:       'c2000000-0000-0000-0000-000000000001',
  bonus:       'c2000000-0000-0000-0000-000000000002',
  medical:     'c2000000-0000-0000-0000-000000000003',
  provident:   'c2000000-0000-0000-0000-000000000004',
  ra:          'c2000000-0000-0000-0000-000000000005',
  advance:     'c2000000-0000-0000-0000-000000000006',
};

const COMPONENTS: ComponentSpec[] = [
  { id: COMP_IDS.basic,     name: 'Basic Salary',         sars_source_code: '3601', component_type: 'earning',              is_taxable: true,  is_uif_applicable: true,  is_sdl_applicable: true  },
  { id: COMP_IDS.bonus,     name: 'Annual Bonus',          sars_source_code: '3605', component_type: 'earning',              is_taxable: true,  is_uif_applicable: false, is_sdl_applicable: true  },
  { id: COMP_IDS.medical,   name: 'Medical Aid',           sars_source_code: '4005', component_type: 'deduction',            is_taxable: false, is_uif_applicable: false, is_sdl_applicable: false },
  { id: COMP_IDS.provident, name: 'Provident Fund',        sars_source_code: '4001', component_type: 'deduction',            is_taxable: false, is_uif_applicable: false, is_sdl_applicable: false },
  { id: COMP_IDS.ra,        name: 'Retirement Annuity',    sars_source_code: '4006', component_type: 'deduction',            is_taxable: false, is_uif_applicable: false, is_sdl_applicable: false },
  { id: COMP_IDS.advance,   name: 'Salary Advance',        sars_source_code: '3907', component_type: 'deduction',            is_taxable: false, is_uif_applicable: false, is_sdl_applicable: false },
];

async function seedComponents(): Promise<void> {
  if (!(await tableExists('payroll_components'))) {
    console.log('[components] Table missing — skipped.');
    return;
  }

  const rows = COMPONENTS.map(c => ({
    id: c.id,
    company_id: COMPANY_ID,
    name: c.name,
    sars_source_code: c.sars_source_code,
    component_type: c.component_type,
    is_taxable: c.is_taxable,
    is_uif_applicable: c.is_uif_applicable,
    is_sdl_applicable: c.is_sdl_applicable,
    is_active: true,
  }));

  await batchInsert('payroll_components', rows);
  console.log(`[components] Seeded ${rows.length} pay components.`);
}

// ── 3. Employee components ────────────────────────────────────────────────────

async function seedEmployeeComponents(): Promise<void> {
  if (!(await tableExists('payroll_employee_components'))) {
    console.log('[emp-components] Table missing — skipped.');
    return;
  }

  const rows: Record<string, unknown>[] = [];

  for (const emp of EMPLOYEES) {
    const g = emp.monthly_gross;
    // Basic salary = gross
    rows.push({
      id: randomUUID(), employee_id: emp.id,
      component_id: COMP_IDS.basic,
      amount: g,
      effective_from: emp.start_date,
    });
    // Medical aid: directors R3 800, seniors R2 800, others R1 800
    const medAid = emp.employment_type === 'director' ? 3800
      : g >= 35000 ? 2800 : 1800;
    rows.push({
      id: randomUUID(), employee_id: emp.id,
      component_id: COMP_IDS.medical,
      amount: medAid,
      effective_from: emp.start_date,
    });
    // Provident fund: 7.5% of gross
    rows.push({
      id: randomUUID(), employee_id: emp.id,
      component_id: COMP_IDS.provident,
      amount: Math.round(g * 0.075 * 100) / 100,
      effective_from: emp.start_date,
    });
    // RA only for directors and senior accountants
    if (emp.employment_type === 'director' || g >= 35000) {
      rows.push({
        id: randomUUID(), employee_id: emp.id,
        component_id: COMP_IDS.ra,
        amount: Math.round(g * 0.05 * 100) / 100,
        effective_from: emp.start_date,
      });
    }
  }

  await batchInsert('payroll_employee_components', rows);
  console.log(`[emp-components] Seeded ${rows.length} employee component links.`);
}

// ── 4 & 5. Payroll runs + lines ───────────────────────────────────────────────

interface RunSpec {
  id: string;
  period_month: number;
  period_year: number;
  run_date: string;
}

const RUN_IDS = {
  jan: 'a3d00000-0000-0000-0000-000000000001',
  feb: 'a3d00000-0000-0000-0000-000000000002',
  mar: 'a3d00000-0000-0000-0000-000000000003',
};

const RUNS: RunSpec[] = [
  { id: RUN_IDS.jan, period_month: 1, period_year: 2026, run_date: '2026-01-25' },
  { id: RUN_IDS.feb, period_month: 2, period_year: 2026, run_date: '2026-02-25' },
  { id: RUN_IDS.mar, period_month: 3, period_year: 2026, run_date: '2026-03-25' },
];

async function seedPayrollRuns(): Promise<void> {
  if (!(await tableExists('payroll_run_headers'))) {
    console.log('[payroll-runs] Table missing — skipped.');
    return;
  }

  // Build per-employee line data first so we can sum totals
  const allLines: Record<string, unknown>[] = [];
  const headers: Record<string, unknown>[] = [];

  for (const run of RUNS) {
    let totalGross = 0, totalPaye = 0, totalUif = 0, totalNet = 0;

    for (const emp of EMPLOYEES) {
      const gross = emp.monthly_gross;
      const paye = calcPAYE(gross);
      const uifEmp = calcUIF(gross);
      const uifEmr = uifEmp; // employer matches employee
      const medAid = emp.employment_type === 'director' ? 3800
        : gross >= 35000 ? 2800 : 1800;
      const provident = Math.round(gross * 0.075 * 100) / 100;
      const ra = (emp.employment_type === 'director' || gross >= 35000)
        ? Math.round(gross * 0.05 * 100) / 100
        : 0;
      const totalDed = paye + uifEmp + medAid + provident + ra;
      const netPay = Math.round((gross - totalDed) * 100) / 100;

      totalGross += gross;
      totalPaye  += paye;
      totalUif   += uifEmp;
      totalNet   += netPay;

      const componentBreakdown = [
        { code: '3601', name: 'Basic Salary',      type: 'earning',   amount: gross   },
        { code: '4005', name: 'Medical Aid',        type: 'deduction', amount: medAid  },
        { code: '4001', name: 'Provident Fund',     type: 'deduction', amount: provident },
        ...(ra > 0 ? [{ code: '4006', name: 'Retirement Annuity', type: 'deduction', amount: ra }] : []),
      ];

      allLines.push({
        id: randomUUID(),
        run_id: run.id,
        employee_id: emp.id,
        gross_pay: gross,
        taxable_income: gross - medAid - provident - ra,
        paye,
        uif_employee: uifEmp,
        uif_employer: uifEmr,
        sdl: Math.round(gross * 0.01 * 100) / 100,
        eti: 0,
        net_pay: netPay,
        component_breakdown: JSON.stringify(componentBreakdown),
        validation_results: JSON.stringify([]),
      });
    }

    headers.push({
      id: run.id,
      company_id: COMPANY_ID,
      period_month: run.period_month,
      period_year: run.period_year,
      status: 'approved',
      run_date: run.run_date,
      total_gross: Math.round(totalGross * 100) / 100,
      total_taxable: Math.round(totalGross * 100) / 100,
      total_paye: Math.round(totalPaye * 100) / 100,
      total_uif: Math.round(totalUif * 2 * 100) / 100, // employee + employer
      total_sdl: Math.round(totalGross * 0.01 * 100) / 100,
      total_eti: 0,
      total_net: Math.round(totalNet * 100) / 100,
      employee_count: EMPLOYEES.length,
      notes: `Approved payroll run for ${run.period_year}/${String(run.period_month).padStart(2, '0')}`,
      created_by: ADMIN_ID,
    });
  }

  await batchInsert('payroll_run_headers', headers);
  console.log(`[payroll-runs] Seeded ${headers.length} payroll run headers.`);

  if (!(await tableExists('payroll_run_lines'))) {
    console.log('[payroll-run-lines] Table missing — skipped.');
    return;
  }
  await batchInsert('payroll_run_lines', allLines);
  console.log(`[payroll-run-lines] Seeded ${allLines.length} payroll run lines.`);
}

// ── 6. Leave types ────────────────────────────────────────────────────────────

interface LeaveTypeSpec {
  id: string;
  name: string;
  bcea_type: string;
  accrual_rule: 'monthly' | 'cycle_30_per_36' | 'none';
  accrual_days: number;
  max_carry_over: number | null;
  is_paid: boolean;
}

const LT_IDS = {
  annual:     'a1d00000-0000-0000-0000-000000000001',
  sick:       'a1d00000-0000-0000-0000-000000000002',
  family:     'a1d00000-0000-0000-0000-000000000003',
  maternity:  'a1d00000-0000-0000-0000-000000000004',
  unpaid:     'a1d00000-0000-0000-0000-000000000005',
};

const LEAVE_TYPES: LeaveTypeSpec[] = [
  { id: LT_IDS.annual,    name: 'Annual Leave',          bcea_type: 'annual',              accrual_rule: 'monthly',          accrual_days: 1.25, max_carry_over: 15,   is_paid: true  },
  { id: LT_IDS.sick,      name: 'Sick Leave',            bcea_type: 'sick',                accrual_rule: 'cycle_30_per_36',  accrual_days: 0,    max_carry_over: null, is_paid: true  },
  { id: LT_IDS.family,    name: 'Family Responsibility', bcea_type: 'family_responsibility',accrual_rule: 'none',            accrual_days: 3,    max_carry_over: null, is_paid: true  },
  { id: LT_IDS.maternity, name: 'Maternity Leave',       bcea_type: 'maternity',           accrual_rule: 'none',             accrual_days: 120,  max_carry_over: null, is_paid: true  },
  { id: LT_IDS.unpaid,    name: 'Unpaid Leave',          bcea_type: 'unpaid',              accrual_rule: 'none',             accrual_days: 0,    max_carry_over: null, is_paid: false },
];

async function seedLeaveTypes(): Promise<void> {
  if (!(await tableExists('payroll_leave_types'))) {
    console.log('[leave-types] Table missing — skipped.');
    return;
  }

  const rows = LEAVE_TYPES.map(lt => ({
    id: lt.id,
    company_id: COMPANY_ID,
    name: lt.name,
    bcea_type: lt.bcea_type,
    accrual_rule: lt.accrual_rule,
    accrual_days: lt.accrual_days,
    max_carry_over: lt.max_carry_over,
    is_paid: lt.is_paid,
    is_active: true,
  }));

  await batchInsert('payroll_leave_types', rows);
  console.log(`[leave-types] Seeded ${rows.length} BCEA leave types.`);
}

// ── 7. Leave balances ─────────────────────────────────────────────────────────

async function seedLeaveBalances(): Promise<void> {
  if (!(await tableExists('payroll_leave_balances'))) {
    console.log('[leave-balances] Table missing — skipped.');
    return;
  }

  const rows: Record<string, unknown>[] = [];
  const BALANCE_YEAR = 2026;

  for (const emp of EMPLOYEES) {
    // Annual leave: 15 days accrued, some taken depending on seniority
    const annualTaken = emp.monthly_gross >= 35000 ? 5 : 3;
    rows.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      employee_id: emp.id,
      leave_type_id: LT_IDS.annual,
      balance_year: BALANCE_YEAR,
      accrued: 15,
      taken: annualTaken,
      pending: 0,
    });

    // Sick leave: 30 days per 3-year cycle, few taken
    rows.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      employee_id: emp.id,
      leave_type_id: LT_IDS.sick,
      balance_year: BALANCE_YEAR,
      accrued: 30,
      taken: Math.floor(Math.random() * 4),
      pending: 0,
    });

    // Family responsibility: 3 days flat
    rows.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      employee_id: emp.id,
      leave_type_id: LT_IDS.family,
      balance_year: BALANCE_YEAR,
      accrued: 3,
      taken: 0,
      pending: 0,
    });

    // Unpaid: 0 accrued by default
    rows.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      employee_id: emp.id,
      leave_type_id: LT_IDS.unpaid,
      balance_year: BALANCE_YEAR,
      accrued: 0,
      taken: 0,
      pending: 0,
    });
  }

  await batchInsert('payroll_leave_balances', rows);
  console.log(`[leave-balances] Seeded ${rows.length} leave balance records.`);
}

// ── 8. Leave requests ─────────────────────────────────────────────────────────

async function seedLeaveRequests(): Promise<void> {
  if (!(await tableExists('payroll_leave_requests'))) {
    console.log('[leave-requests] Table missing — skipped.');
    return;
  }

  const requests = [
    // Approved annual leave
    { emp: EMP_IDS[2]!, lt: LT_IDS.annual,  start: '2026-01-05', end: '2026-01-09', days: 5, status: 'approved', reason: 'Family holiday' },
    { emp: EMP_IDS[4]!, lt: LT_IDS.annual,  start: '2026-01-12', end: '2026-01-14', days: 3, status: 'approved', reason: 'Personal time off' },
    { emp: EMP_IDS[7]!, lt: LT_IDS.annual,  start: '2026-02-02', end: '2026-02-04', days: 3, status: 'approved', reason: 'Annual leave' },
    { emp: EMP_IDS[1]!, lt: LT_IDS.annual,  start: '2026-02-16', end: '2026-02-20', days: 5, status: 'approved', reason: 'Directors conference' },
    { emp: EMP_IDS[6]!, lt: LT_IDS.annual,  start: '2026-03-09', end: '2026-03-11', days: 3, status: 'approved', reason: 'Easter break' },
    // Sick leave
    { emp: EMP_IDS[3]!, lt: LT_IDS.sick,    start: '2026-01-20', end: '2026-01-21', days: 2, status: 'approved', reason: 'Influenza — medical certificate attached' },
    { emp: EMP_IDS[5]!, lt: LT_IDS.sick,    start: '2026-02-10', end: '2026-02-10', days: 1, status: 'approved', reason: 'Gastroenteritis' },
    { emp: EMP_IDS[8]!, lt: LT_IDS.sick,    start: '2026-03-03', end: '2026-03-04', days: 2, status: 'approved', reason: 'Sick leave — GP certificate provided' },
    // Family responsibility
    { emp: EMP_IDS[0]!, lt: LT_IDS.family,  start: '2026-02-06', end: '2026-02-06', days: 1, status: 'approved', reason: 'Child illness' },
    { emp: EMP_IDS[9]!, lt: LT_IDS.family,  start: '2026-03-17', end: '2026-03-17', days: 1, status: 'pending',  reason: 'Family bereavement' },
    // Pending annual
    { emp: EMP_IDS[2]!, lt: LT_IDS.annual,  start: '2026-04-07', end: '2026-04-10', days: 4, status: 'pending',  reason: 'School holidays' },
    { emp: EMP_IDS[6]!, lt: LT_IDS.annual,  start: '2026-04-14', end: '2026-04-17', days: 4, status: 'pending',  reason: 'Easter long weekend' },
    // Rejected
    { emp: EMP_IDS[4]!, lt: LT_IDS.annual,  start: '2026-02-24', end: '2026-02-27', days: 4, status: 'rejected', reason: 'Year-end period — request declined' },
    // Unpaid
    { emp: EMP_IDS[9]!, lt: LT_IDS.unpaid,  start: '2026-01-26', end: '2026-01-26', days: 1, status: 'approved', reason: 'Unpaid personal day' },
  ];

  const rows = requests.map(r => ({
    id: randomUUID(),
    company_id: COMPANY_ID,
    employee_id: r.emp,
    leave_type_id: r.lt,
    start_date: r.start,
    end_date: r.end,
    days: r.days,
    reason: r.reason,
    status: r.status,
    approved_by: r.status === 'approved' ? ADMIN_ID : null,
    approved_at: r.status === 'approved' ? new Date(r.end).toISOString() : null,
  }));

  await batchInsert('payroll_leave_requests', rows);
  console.log(`[leave-requests] Seeded ${rows.length} leave requests.`);
}

// ── 9. Tax directives ─────────────────────────────────────────────────────────

async function seedTaxDirectives(): Promise<void> {
  if (!(await tableExists('tax_directives'))) {
    console.log('[tax-directives] Table missing — skipped.');
    return;
  }

  const directives = [
    {
      employee_id: EMP_IDS[0]!,
      employee_name: 'Riaan Mostert',
      employee_tax_number: '9012345678',
      directive_number: 'TD-2026-001',
      directive_type: 'retirement',
      amount: 350000,
      tax_rate: 0.2700,
      tax_amount: 94500,
      effective_date: '2026-01-01',
      expiry_date: '2026-12-31',
      status: 'approved',
      sars_reference: 'SARS-RTR-20260101-001',
      notes: 'Retirement fund lump sum on partial withdrawal',
      requested_by: ADMIN_ID,
      approved_by: ADMIN_ID,
    },
    {
      employee_id: EMP_IDS[1]!,
      employee_name: 'Naledi Dlamini',
      employee_tax_number: '9123456780',
      directive_number: 'TD-2026-002',
      directive_type: 'lump_sum',
      amount: 120000,
      tax_rate: 0.1800,
      tax_amount: 21600,
      effective_date: '2026-02-01',
      expiry_date: '2026-12-31',
      status: 'approved',
      sars_reference: 'SARS-LUM-20260201-001',
      notes: 'Performance bonus lump sum directive',
      requested_by: ADMIN_ID,
      approved_by: ADMIN_ID,
    },
    {
      employee_id: EMP_IDS[2]!,
      employee_name: 'Pieter van der Berg',
      employee_tax_number: '9234567801',
      directive_number: 'TD-2026-003',
      directive_type: 'severance',
      amount: 210000,
      tax_rate: 0.2100,
      tax_amount: 44100,
      effective_date: '2026-03-01',
      expiry_date: '2026-12-31',
      status: 'pending',
      sars_reference: null,
      notes: 'Severance package — awaiting SARS approval',
      requested_by: ADMIN_ID,
      approved_by: null,
    },
    {
      employee_id: EMP_IDS[3]!,
      employee_name: 'Thandi Nkosi',
      employee_tax_number: '9345678012',
      directive_number: 'TD-2026-004',
      directive_type: 'lump_sum',
      amount: 75000,
      tax_rate: 0.1800,
      tax_amount: 13500,
      effective_date: '2026-01-15',
      expiry_date: '2026-12-31',
      status: 'approved',
      sars_reference: 'SARS-LUM-20260115-004',
      notes: '13th cheque directive',
      requested_by: ADMIN_ID,
      approved_by: ADMIN_ID,
    },
    {
      employee_id: EMP_IDS[4]!,
      employee_name: 'Farouk Adams',
      employee_tax_number: '9456780123',
      directive_number: 'TD-2026-005',
      directive_type: 'retirement',
      amount: 490000,
      tax_rate: 0.3600,
      tax_amount: 176400,
      effective_date: '2026-03-15',
      expiry_date: null,
      status: 'pending',
      sars_reference: null,
      notes: 'Provident fund full withdrawal on resignation',
      requested_by: ADMIN_ID,
      approved_by: null,
    },
  ];

  const rows = directives.map(d => ({
    id: randomUUID(),
    company_id: COMPANY_ID,
    ...d,
  }));

  await batchInsert('tax_directives', rows);
  console.log(`[tax-directives] Seeded ${rows.length} tax directives.`);
}

// ── 10. UIF declarations ──────────────────────────────────────────────────────

async function seedUifDeclarations(): Promise<void> {
  if (!(await tableExists('uif_declarations'))) {
    console.log('[uif-declarations] Table missing — skipped.');
    return;
  }

  // Compute totals per run from employee data
  const periods = [
    { period_month: 1, period_year: 2026, status: 'submitted', submitted_at: '2026-02-07T08:30:00Z', uif_ref: 'UIF-2026-01-001' },
    { period_month: 2, period_year: 2026, status: 'draft',     submitted_at: null,                   uif_ref: null },
    { period_month: 3, period_year: 2026, status: 'draft',     submitted_at: null,                   uif_ref: null },
  ];

  const rows = periods.map(p => {
    let totalLeviable = 0, totalEmployee = 0, totalEmployer = 0;
    for (const emp of EMPLOYEES) {
      const capped = Math.min(emp.monthly_gross, UIF_CEILING);
      totalLeviable  += capped;
      totalEmployee  += Math.round(capped * 0.01 * 100) / 100;
      totalEmployer  += Math.round(capped * 0.01 * 100) / 100;
    }

    return {
      id: randomUUID(),
      company_id: COMPANY_ID,
      period_year: p.period_year,
      period_month: p.period_month,
      uif_reference: p.uif_ref,
      total_employees: EMPLOYEES.length,
      total_leviable_salary: Math.round(totalLeviable * 100) / 100,
      total_employee_contribution: Math.round(totalEmployee * 100) / 100,
      total_employer_contribution: Math.round(totalEmployer * 100) / 100,
      status: p.status,
      submitted_at: p.submitted_at,
      submitted_by: p.status === 'submitted' ? ADMIN_ID : null,
      notes: p.status === 'submitted'
        ? 'UI-19 submitted via e-filing'
        : `Draft — pending submission for ${p.period_year}/${String(p.period_month).padStart(2, '0')}`,
    };
  });

  await batchInsert('uif_declarations', rows);
  console.log(`[uif-declarations] Seeded ${rows.length} UIF declarations.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== ISAFlow Payroll Demo Data Seeder ===');
  console.log(`Company : ${COMPANY_ID}`);
  console.log(`Admin   : ${ADMIN_ID}`);
  console.log(`Periods : Jan 2026, Feb 2026, Mar 2026\n`);

  await cleanExisting();

  await seedEmployees();
  await seedComponents();
  await seedEmployeeComponents();
  await seedPayrollRuns();
  await seedLeaveTypes();
  await seedLeaveBalances();
  await seedLeaveRequests();
  await seedTaxDirectives();
  await seedUifDeclarations();

  console.log('\n=== Payroll seeding complete! ===');

  // Summary counts
  const counts: [string, string][] = [
    ['payroll_employees',        `SELECT COUNT(*) AS c FROM payroll_employees WHERE company_id = $1`],
    ['payroll_components',       `SELECT COUNT(*) AS c FROM payroll_components WHERE company_id = $1`],
    ['payroll_employee_components', `SELECT COUNT(*) AS c FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)`],
    ['payroll_run_headers',      `SELECT COUNT(*) AS c FROM payroll_run_headers WHERE company_id = $1`],
    ['payroll_run_lines',        `SELECT COUNT(*) AS c FROM payroll_run_lines WHERE run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)`],
    ['payroll_leave_types',      `SELECT COUNT(*) AS c FROM payroll_leave_types WHERE company_id = $1`],
    ['payroll_leave_balances',   `SELECT COUNT(*) AS c FROM payroll_leave_balances WHERE company_id = $1`],
    ['payroll_leave_requests',   `SELECT COUNT(*) AS c FROM payroll_leave_requests WHERE company_id = $1`],
    ['tax_directives',           `SELECT COUNT(*) AS c FROM tax_directives WHERE company_id = $1`],
    ['uif_declarations',         `SELECT COUNT(*) AS c FROM uif_declarations WHERE company_id = $1`],
  ];

  for (const [label, query] of counts) {
    try {
      const rows = await sql.query<{ c: string }>(query, [COMPANY_ID]);
      console.log(`  ${label.padEnd(32)} ${rows[0]?.c ?? 0}`);
    } catch {
      console.log(`  ${label.padEnd(32)} (table not found)`);
    }
  }

  await closeSql();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Seeder error:', err);
  process.exit(1);
});
