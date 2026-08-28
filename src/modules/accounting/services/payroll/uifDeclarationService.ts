/**
 * UIF Declaration Service — monthly UI-19 filing.
 * Aggregates payroll run lines for a period and persists totals.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateUIF } from './uifEngine';
import { getTaxYear } from './taxTables';
import { getAccountByCode } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

type Row = DbRow;

export interface UifDeclaration {
  id: string;
  companyId: string;
  periodYear: number;
  periodMonth: number;
  uifReference: string | null;
  totalEmployees: number;
  totalLeviableSalary: number;
  totalEmployeeContribution: number;
  totalEmployerContribution: number;
  totalUif: number;
  status: 'draft' | 'submitted' | 'accepted' | 'paid';
  submittedAt: string | null;
  submittedBy: string | null;
  notes: string | null;
  journalEntryId: string | null;
  paymentDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UifPaymentResult {
  id: string;
  totalPaid: number;
  journalEntryId: string;
  status: 'paid';
}

export interface UifDeclarationLine {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  leviableSalary: number;
  employeeContribution: number;
  employerContribution: number;
  isCapped: boolean;
}

export interface UifDeclarationDetail extends UifDeclaration {
  lines: UifDeclarationLine[];
}

function mapDeclaration(r: Row): UifDeclaration {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodYear: Number(r.period_year),
    periodMonth: Number(r.period_month),
    uifReference: r.uif_reference ? String(r.uif_reference) : null,
    totalEmployees: Number(r.total_employees),
    totalLeviableSalary: Number(r.total_leviable_salary),
    totalEmployeeContribution: Number(r.total_employee_contribution),
    totalEmployerContribution: Number(r.total_employer_contribution),
    totalUif: Number(r.total_employee_contribution) + Number(r.total_employer_contribution),
    status: String(r.status) as UifDeclaration['status'],
    submittedAt: r.submitted_at
      ? (r.submitted_at instanceof Date ? r.submitted_at.toISOString() : String(r.submitted_at))
      : null,
    submittedBy: r.submitted_by ? String(r.submitted_by) : null,
    notes: r.notes ? String(r.notes) : null,
    journalEntryId: r.journal_entry_id ? String(r.journal_entry_id) : null,
    paymentDate: r.payment_date ? fmtDate(r.payment_date) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function listUifDeclarations(
  companyId: string,
  filters: { year?: number } = {},
): Promise<UifDeclaration[]> {
  const rows = (await sql`
    SELECT *
    FROM uif_declarations
    WHERE company_id = ${companyId}::uuid
      AND (${filters.year ?? null}::int IS NULL OR period_year = ${filters.year ?? null})
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapDeclaration);
}

export async function getUifDeclaration(
  companyId: string,
  id: string,
): Promise<UifDeclarationDetail | null> {
  const rows = (await sql`
    SELECT * FROM uif_declarations
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (rows.length === 0 || !rows[0]) return null;

  const decl = mapDeclaration(rows[0]);
  const taxYear = getTaxYear(decl.periodMonth, decl.periodYear);

  // Pull per-employee lines from the payroll run for this period
  const lineRows = (await sql`
    SELECT
      prl.employee_id,
      pe.employee_number,
      pe.first_name,
      pe.last_name,
      prl.gross_pay,
      prl.uif_employee,
      prl.uif_employer
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees   pe  ON pe.id  = prl.employee_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.period_year  = ${decl.periodYear}
      AND prh.period_month = ${decl.periodMonth}
      AND prh.status IN ('calculated', 'approved', 'paid')
    ORDER BY pe.employee_number
  `) as Row[];

  const lines: UifDeclarationLine[] = lineRows.map(r => {
    const grossPay = Number(r.gross_pay);
    const uif = calculateUIF(grossPay, taxYear);
    return {
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      employeeName: `${r.first_name} ${r.last_name}`,
      grossPay,
      leviableSalary: uif.isCapped
        ? uif.employeeContribution / 0.01
        : grossPay,
      employeeContribution: Number(r.uif_employee),
      employerContribution: Number(r.uif_employer),
      isCapped: uif.isCapped,
    };
  });

  return { ...decl, lines };
}

export async function generateUifDeclaration(
  companyId: string,
  year: number,
  month: number,
  generatedByUserId: string,
): Promise<UifDeclaration> {
  log.info('Generating UIF declaration', { companyId, year, month }, 'uifDeclarationService');

  // Aggregate from payroll run lines for the period
  const aggRows = (await sql`
    SELECT
      COUNT(DISTINCT prl.employee_id)::int        AS employee_count,
      COALESCE(SUM(prl.uif_employee), 0)::numeric AS total_uif_employee,
      COALESCE(SUM(prl.uif_employer), 0)::numeric AS total_uif_employer
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id  = ${companyId}::uuid
      AND prh.period_year  = ${year}
      AND prh.period_month = ${month}
      AND prh.status IN ('calculated', 'approved', 'paid')
  `) as Row[];

  const agg = aggRows[0];
  if (!agg) throw new Error('Aggregation query returned no row');

  const totalUifEmployee = Number(agg.total_uif_employee);
  const totalUifEmployer = Number(agg.total_uif_employer);
  const employeeCount = Number(agg.employee_count);

  // Leviable salary = employee contribution / 0.01
  // (stored uif_employee already reflects the ceiling cap applied at run time)
  const totalLeviable = totalUifEmployee > 0 ? totalUifEmployee / 0.01 : 0;

  const r = (n: number) => Math.round(n * 100) / 100;

  const upsertRows = (await sql`
    INSERT INTO uif_declarations (
      company_id, period_year, period_month,
      total_employees, total_leviable_salary,
      total_employee_contribution, total_employer_contribution,
      status, submitted_by, updated_at
    ) VALUES (
      ${companyId}::uuid, ${year}, ${month},
      ${employeeCount}, ${r(totalLeviable)},
      ${r(totalUifEmployee)}, ${r(totalUifEmployer)},
      'draft', ${generatedByUserId}::uuid, NOW()
    )
    ON CONFLICT (company_id, period_year, period_month) DO UPDATE SET
      total_employees             = EXCLUDED.total_employees,
      total_leviable_salary       = EXCLUDED.total_leviable_salary,
      total_employee_contribution = EXCLUDED.total_employee_contribution,
      total_employer_contribution = EXCLUDED.total_employer_contribution,
      status = CASE
        WHEN uif_declarations.status = 'draft' THEN 'draft'
        ELSE uif_declarations.status
      END,
      updated_at = NOW()
    RETURNING *
  `) as Row[];

  if (!upsertRows[0]) throw new Error('Upsert returned no row');

  log.info(
    'UIF declaration generated',
    { companyId, year, month, employeeCount, totalLeviable },
    'uifDeclarationService',
  );

  return mapDeclaration(upsertRows[0]);
}

export async function markUifSubmitted(
  companyId: string,
  id: string,
  submittedByUserId: string,
): Promise<UifDeclaration | null> {
  const rows = (await sql`
    UPDATE uif_declarations SET
      status       = 'submitted',
      submitted_at = NOW(),
      submitted_by = ${submittedByUserId}::uuid,
      updated_at   = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (rows.length === 0 || !rows[0]) return null;
  log.info('UIF declaration marked submitted', { companyId, id }, 'uifDeclarationService');
  return mapDeclaration(rows[0]);
}

async function resolveGlAccount(companyId: string, code: string, label: string): Promise<string> {
  const acc = await getAccountByCode(companyId, code);
  if (!acc) throw new Error(`GL account ${code} (${label}) not found for company`);
  return acc.id;
}

/** DR 2150 UIF Payable / CR 1110 Bank — clears the month's UIF liability on payment to Labour Dept. */
export async function markUifDeclarationPaid(
  companyId: string,
  declarationId: string,
  opts: { paymentDate?: string; bankAccountId?: string },
  userId: string,
): Promise<UifPaymentResult> {
  const declRows = (await sql`
    SELECT * FROM uif_declarations
    WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (declRows.length === 0 || !declRows[0]) throw new Error(`UIF declaration ${declarationId} not found`);
  const decl = mapDeclaration(declRows[0]);
  if (decl.status === 'paid') {
    log.info('UIF declaration already paid — idempotent', { companyId, declarationId }, 'uifDeclarationService');
    return { id: decl.id, totalPaid: decl.totalUif, journalEntryId: decl.journalEntryId ?? '', status: 'paid' };
  }
  if (decl.status !== 'submitted') {
    throw new Error(`UIF declaration must be 'submitted' before paying (current: ${decl.status})`);
  }
  const uifPayableId = await resolveGlAccount(companyId, '2150', 'UIF Payable');
  const bankAccId = opts.bankAccountId ?? await resolveGlAccount(companyId, '1110', 'Bank - Primary');
  const totalPaid = Math.round((decl.totalEmployeeContribution + decl.totalEmployerContribution) * 100) / 100;
  const paymentDate = opts.paymentDate ?? new Date().toISOString().slice(0, 10);
  const narrative = `UIF payment ${decl.periodYear}-${String(decl.periodMonth).padStart(2, '0')}`;
  const entry = await createJournalEntry(companyId, {
    entryDate: paymentDate,
    description: narrative,
    source: 'auto_payroll',
    lines: [
      { glAccountId: uifPayableId, debit: totalPaid, credit: 0,         description: narrative },
      { glAccountId: bankAccId,    debit: 0,         credit: totalPaid, description: narrative },
    ],
  }, userId);
  await postJournalEntry(companyId, entry.id, userId);
  await sql`
    UPDATE uif_declarations SET
      status           = 'paid',
      payment_date     = ${paymentDate}::date,
      journal_entry_id = ${entry.id}::uuid,
      updated_at       = NOW()
    WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('UIF declaration marked paid', { companyId, declarationId, totalPaid, journalEntryId: entry.id }, 'uifDeclarationService');
  return { id: declarationId, totalPaid, journalEntryId: entry.id, status: 'paid' };
}
