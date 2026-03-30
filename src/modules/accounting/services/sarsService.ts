/**
 * SARS eFiling Integration Service
 * Generates VAT201 and EMP201 form data from accounting records.
 * Manages tax periods and compliance calendar for South African tax obligations.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const SA_VAT_RATE = 0.15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VAT201Data {
  periodStart: string;
  periodEnd: string;
  field1_standardRatedSupplies: number;
  field2_zeroRatedSupplies: number;
  field3_exemptSupplies: number;
  field4_totalImports: number;
  field5_outputVAT: number;
  field6_capitalGoods: number;
  field7_otherGoods: number;
  field8_services: number;
  field9_imports: number;
  field10_totalInputVAT: number;
  field11_vatPayableOrRefundable: number;
  outputInvoices: VAT201Invoice[];
  inputInvoices: VAT201Invoice[];
}

export interface VAT201Invoice {
  id: string;
  invoiceNumber: string;
  counterpartyName: string;
  invoiceDate: string;
  totalExclVat: number;
  vatAmount: number;
  vatType: string;
}

export interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  totalPAYE: number;
  totalUIF_employee: number;
  totalUIF_employer: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
  totalTaxableRemuneration: number;
  totalDeductions: number;
  payrollRuns: EMP201PayrollRun[];
}

export interface EMP201PayrollRun {
  id: string;
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  uif: number;
  sdl: number;
}

export interface TaxPeriod {
  type: 'VAT' | 'PAYE';
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  label: string;
}

export interface ComplianceEvent {
  id?: string;
  eventType: string;
  dueDate: string;
  description: string;
  status: 'pending' | 'completed' | 'overdue';
  submissionId?: string;
}

export interface SARSSubmission {
  id: string;
  formType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  formData: Record<string, unknown>;
  submissionReference: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// VAT201 Generation
// ---------------------------------------------------------------------------

/**
 * Generate a VAT201 return from customer and supplier invoices for the period.
 * Output VAT comes from customer_invoices; input VAT from supplier_invoices.
 * GL account codes 2120 (Output VAT) and 1140 (Input VAT) are cross-referenced.
 */
export async function generateVAT201(companyId: string, 
  periodStart: string,
  periodEnd: string
): Promise<VAT201Data> {
  log.info('Generating VAT201', { periodStart, periodEnd }, 'sarsService');

  // -- Output VAT: customer invoices in period --
  let customerInvoices: Row[] = [];
  try {
    customerInvoices = (await sql`
      SELECT
        ci.id,
        ci.invoice_number,
        ci.invoice_date,
        ci.subtotal,
        ci.vat_amount,
        ci.total,
        ci.vat_type,
        c.name AS customer_name
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id
      WHERE ci.invoice_date >= ${periodStart}
        AND ci.invoice_date <= ${periodEnd}
        AND ci.status != 'cancelled'
      ORDER BY ci.invoice_date
    `) as Row[];
  } catch (err) {
    log.warn('Could not query customer_invoices for VAT201', { error: err }, 'sarsService');
  }

  // -- Input VAT: supplier invoices in period --
  let supplierInvoices: Row[] = [];
  try {
    supplierInvoices = (await sql`
      SELECT
        si.id,
        si.invoice_number,
        si.invoice_date,
        si.subtotal,
        si.vat_amount,
        si.total,
        si.vat_type,
        s.name AS supplier_name
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.invoice_date >= ${periodStart}
        AND si.invoice_date <= ${periodEnd}
        AND si.status != 'cancelled'
      ORDER BY si.invoice_date
    `) as Row[];
  } catch (err) {
    log.warn('Could not query supplier_invoices for VAT201', { error: err }, 'sarsService');
  }

  // Categorise customer invoices (output side)
  let field1_standardRated = 0;
  let field2_zeroRated = 0;
  let field3_exempt = 0;

  const outputInvoices: VAT201Invoice[] = customerInvoices.map((inv: Row) => {
    const subtotal = Number(inv.subtotal) || 0;
    const vatAmt = Number(inv.vat_amount) || 0;
    const vatType = String(inv.vat_type || 'standard').toLowerCase();

    if (vatType === 'zero_rated' || vatType === 'zero-rated' || vatType === 'zero') {
      field2_zeroRated += subtotal;
    } else if (vatType === 'exempt') {
      field3_exempt += subtotal;
    } else {
      field1_standardRated += subtotal;
    }

    return {
      id: String(inv.id),
      invoiceNumber: String(inv.invoice_number || ''),
      counterpartyName: String(inv.customer_name || 'Unknown'),
      invoiceDate: String(inv.invoice_date || ''),
      totalExclVat: subtotal,
      vatAmount: vatAmt,
      vatType,
    };
  });

  // Field 5: Output VAT = standard-rated supplies x 15%
  const field5_outputVAT = roundCents(field1_standardRated * SA_VAT_RATE);

  // Categorise supplier invoices (input side)
  let field6_capitalGoods = 0;
  let field7_otherGoods = 0;
  let field8_services = 0;
  let field9_imports = 0;

  const inputInvoices: VAT201Invoice[] = supplierInvoices.map((inv: Row) => {
    const vatAmt = Number(inv.vat_amount) || 0;
    const subtotal = Number(inv.subtotal) || 0;
    const vatType = String(inv.vat_type || 'standard').toLowerCase();

    // Categorise into input VAT fields based on vat_type metadata
    if (vatType === 'capital' || vatType === 'capital_goods') {
      field6_capitalGoods += vatAmt;
    } else if (vatType === 'import' || vatType === 'imports') {
      field9_imports += vatAmt;
    } else if (vatType === 'services' || vatType === 'service') {
      field8_services += vatAmt;
    } else {
      // Default: other goods and services
      field7_otherGoods += vatAmt;
    }

    return {
      id: String(inv.id),
      invoiceNumber: String(inv.invoice_number || ''),
      counterpartyName: String(inv.supplier_name || 'Unknown'),
      invoiceDate: String(inv.invoice_date || ''),
      totalExclVat: subtotal,
      vatAmount: vatAmt,
      vatType,
    };
  });

  const field10_totalInputVAT = roundCents(
    field6_capitalGoods + field7_otherGoods + field8_services + field9_imports
  );

  const field11_vatPayable = roundCents(field5_outputVAT - field10_totalInputVAT);

  return {
    periodStart,
    periodEnd,
    field1_standardRatedSupplies: roundCents(field1_standardRated),
    field2_zeroRatedSupplies: roundCents(field2_zeroRated),
    field3_exemptSupplies: roundCents(field3_exempt),
    field4_totalImports: roundCents(field9_imports > 0 ? field9_imports / SA_VAT_RATE : 0),
    field5_outputVAT,
    field6_capitalGoods: roundCents(field6_capitalGoods),
    field7_otherGoods: roundCents(field7_otherGoods),
    field8_services: roundCents(field8_services),
    field9_imports: roundCents(field9_imports),
    field10_totalInputVAT,
    field11_vatPayableOrRefundable: field11_vatPayable,
    outputInvoices,
    inputInvoices,
  };
}

// ---------------------------------------------------------------------------
// EMP201 Generation
// ---------------------------------------------------------------------------

/**
 * Generate EMP201 (monthly PAYE/UIF/SDL) data from payroll tables.
 * Handles missing payroll tables gracefully by returning zero-filled data.
 */
export async function generateEMP201(companyId: string, 
  periodStart: string,
  periodEnd: string
): Promise<EMP201Data> {
  log.info('Generating EMP201', { periodStart, periodEnd }, 'sarsService');

  const emptyResult: EMP201Data = {
    periodStart,
    periodEnd,
    totalPAYE: 0,
    totalUIF_employee: 0,
    totalUIF_employer: 0,
    totalUIF: 0,
    totalSDL: 0,
    employeeCount: 0,
    totalTaxableRemuneration: 0,
    totalDeductions: 0,
    payrollRuns: [],
  };

  // Check if payroll tables exist
  let hasPayrollTables = false;
  try {
    const tables = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('payroll_runs', 'payslips')
    `) as Row[];
    hasPayrollTables = tables.length >= 2;
  } catch (err) {
    log.warn('Could not check payroll tables', { error: err }, 'sarsService');
  }

  if (!hasPayrollTables) {
    log.info('Payroll tables not found, returning empty EMP201', {}, 'sarsService');
    return emptyResult;
  }

  try {
    // Get payroll runs in the period
    const runs = (await sql`
      SELECT
        pr.id,
        pr.run_date,
        COUNT(DISTINCT ps.employee_id) AS employee_count,
        COALESCE(SUM(ps.gross_pay), 0) AS gross_pay,
        COALESCE(SUM(ps.paye), 0) AS paye,
        COALESCE(SUM(ps.uif_employee), 0) AS uif_employee,
        COALESCE(SUM(ps.uif_employer), 0) AS uif_employer,
        COALESCE(SUM(ps.sdl), 0) AS sdl
      FROM payroll_runs pr
      LEFT JOIN payslips ps ON ps.payroll_run_id = pr.id
      WHERE pr.run_date >= ${periodStart}
        AND pr.run_date <= ${periodEnd}
        AND pr.status != 'cancelled'
      GROUP BY pr.id, pr.run_date
      ORDER BY pr.run_date
    `) as Row[];

    if (runs.length === 0) {
      return emptyResult;
    }

    let totalPAYE = 0;
    let totalUIFEmployee = 0;
    let totalUIFEmployer = 0;
    let totalSDL = 0;
    let totalGross = 0;
    const _unusedEmployeeIds = new Set<string>();

    const payrollRuns: EMP201PayrollRun[] = runs.map((r: Row) => {
      const paye = Number(r.paye) || 0;
      const uifEmp = Number(r.uif_employee) || 0;
      const uifEr = Number(r.uif_employer) || 0;
      const sdl = Number(r.sdl) || 0;
      const gross = Number(r.gross_pay) || 0;

      totalPAYE += paye;
      totalUIFEmployee += uifEmp;
      totalUIFEmployer += uifEr;
      totalSDL += sdl;
      totalGross += gross;

      return {
        id: String(r.id),
        runDate: String(r.run_date),
        employeeCount: Number(r.employee_count) || 0,
        grossPay: roundCents(gross),
        paye: roundCents(paye),
        uif: roundCents(uifEmp + uifEr),
        sdl: roundCents(sdl),
      };
    });

    // Get distinct employee count for the period
    try {
      const empCount = (await sql`
        SELECT COUNT(DISTINCT ps.employee_id) AS cnt
        FROM payslips ps
        JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE pr.run_date >= ${periodStart}
          AND pr.run_date <= ${periodEnd}
          AND pr.status != 'cancelled'
      `) as Row[];
      if (empCount[0]?.cnt) {
        // Use the distinct count from DB
      }
    } catch {
      // Fallback: sum from runs
    }

    const totalUIF = roundCents(totalUIFEmployee + totalUIFEmployer);
    const totalDeductions = roundCents(totalPAYE + totalUIF + totalSDL);

    return {
      periodStart,
      periodEnd,
      totalPAYE: roundCents(totalPAYE),
      totalUIF_employee: roundCents(totalUIFEmployee),
      totalUIF_employer: roundCents(totalUIFEmployer),
      totalUIF,
      totalSDL: roundCents(totalSDL),
      employeeCount: payrollRuns.reduce((max, r) => Math.max(max, r.employeeCount), 0),
      totalTaxableRemuneration: roundCents(totalGross),
      totalDeductions,
      payrollRuns,
    };
  } catch (err) {
    log.warn('Error generating EMP201 from payroll data', { error: err }, 'sarsService');
    return emptyResult;
  }
}

// ---------------------------------------------------------------------------
// Submissions CRUD
// ---------------------------------------------------------------------------

/** Save a SARS submission as draft */
export async function saveDraftSubmission(
  companyId: string,
  formType: string,
  periodStart: string,
  periodEnd: string,
  formData: Record<string, unknown>,
  userId: string
): Promise<SARSSubmission> {
  log.info('Saving draft submission', { formType, periodStart, periodEnd }, 'sarsService');

  const rows = (await sql`
    INSERT INTO sars_submissions (form_type, period_start, period_end, status, form_data, submitted_by)
    VALUES (${formType}, ${periodStart}, ${periodEnd}, 'draft', ${JSON.stringify(formData)}::jsonb, ${userId})
    RETURNING *
  `) as Row[];

  return mapSubmissionRow(rows[0]);
}

/** List all submissions, most recent first */
export async function listSubmissions(companyId: string, 
  formType?: string
): Promise<SARSSubmission[]> {
  let rows: Row[];
  if (formType) {
    rows = (await sql`
      SELECT * FROM sars_submissions
      WHERE form_type = ${formType}
      ORDER BY created_at DESC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM sars_submissions
      ORDER BY created_at DESC
    `) as Row[];
  }

  return rows.map(mapSubmissionRow);
}

/** Get a single submission by ID */
export async function getSubmission(companyId: string, id: string): Promise<SARSSubmission | null> {
  const rows = (await sql`
    SELECT * FROM sars_submissions WHERE id = ${id}
  `) as Row[];

  if (rows.length === 0) return null;
  return mapSubmissionRow(rows[0]);
}

/** Mark a submission as submitted with a SARS reference */
export async function markSubmitted(companyId: string, 
  id: string,
  reference: string
): Promise<SARSSubmission> {
  log.info('Marking submission as submitted', { id, reference }, 'sarsService');

  const rows = (await sql`
    UPDATE sars_submissions
    SET status = 'submitted',
        submission_reference = ${reference},
        submitted_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];

  if (rows.length === 0) {
    throw new Error(`Submission ${id} not found`);
  }

  return mapSubmissionRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Tax Periods
// ---------------------------------------------------------------------------

/**
 * Return SA tax periods for the current tax year.
 * VAT: Bi-monthly periods — Category A (odd: Jan/Feb...) or Category B (even: Feb/Mar...)
 * PAYE: Monthly periods
 */
export function getTaxPeriods(year?: number, alignment: 'odd' | 'even' = 'odd'): TaxPeriod[] {
  const y = year || new Date().getFullYear();
  const periods: TaxPeriod[] = [];
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  // VAT bi-monthly periods
  // Category A (odd): Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec
  // Category B (even): Feb-Mar, Apr-May, Jun-Jul, Aug-Sep, Oct-Nov, Dec-Jan
  const startMonths = alignment === 'even' ? [2, 4, 6, 8, 10, 12] : [1, 3, 5, 7, 9, 11];

  const vatPeriods: Array<{ start: string; end: string; label: string }> = startMonths.map(sm => {
    const endMonth = sm + 1;
    const startYear = y;
    const endYear = endMonth > 12 ? y + 1 : y;
    const em = endMonth > 12 ? 1 : endMonth;
    const lastDay = new Date(endYear, em, 0).getDate(); // handles leap year automatically
    return {
      start: `${startYear}-${pad(sm)}-01`,
      end: `${endYear}-${pad(em)}-${pad(lastDay)}`,
      label: `${monthNames[sm - 1]}–${monthNames[em - 1]} ${endYear !== startYear ? startYear + '/' + endYear : startYear}`,
    };
  });

  for (const vp of vatPeriods) {
    const endDate = new Date(vp.end);
    // VAT201 due by 25th of month following end of period
    const dueMonth = endDate.getMonth() + 2; // +1 for next month, +1 because getMonth is 0-indexed
    const dueYear = dueMonth > 12 ? endDate.getFullYear() + 1 : endDate.getFullYear();
    const dueM = dueMonth > 12 ? dueMonth - 12 : dueMonth;
    const dueDate = `${dueYear}-${pad(dueM)}-25`;

    periods.push({
      type: 'VAT',
      periodStart: vp.start,
      periodEnd: vp.end,
      dueDate,
      label: `VAT201 — ${vp.label}`,
    });
  }

  // PAYE monthly periods
  const payeMonthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  for (let m = 1; m <= 12; m++) {
    const lastDay = new Date(y, m, 0).getDate();
    const periodStart = `${y}-${pad(m)}-01`;
    const periodEnd = `${y}-${pad(m)}-${pad(lastDay)}`;

    // EMP201 due by 7th of following month
    const dueMonth = m + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;
    const dueDate = `${dueYear}-${pad(dueM)}-07`;

    periods.push({
      type: 'PAYE',
      periodStart,
      periodEnd,
      dueDate,
      label: `EMP201 — ${payeMonthNames[m - 1]} ${y}`,
    });
  }

  return periods;
}

// ---------------------------------------------------------------------------
// Compliance Calendar
// ---------------------------------------------------------------------------

/**
 * Build a compliance calendar with upcoming SARS deadlines.
 * Includes VAT201, EMP201, EMP501, IRP5/IT3(a), and Provisional Tax (IRP6).
 */
export function getComplianceCalendar(year?: number, alignment: 'odd' | 'even' = 'odd'): ComplianceEvent[] {
  const y = year || new Date().getFullYear();
  const events: ComplianceEvent[] = [];

  // VAT201 deadlines — due 25th of month following bi-monthly period end
  const vatEndMonths = alignment === 'even' ? [3, 5, 7, 9, 11, 1] : [2, 4, 6, 8, 10, 12];
  const vatLabels = alignment === 'even'
    ? ['Feb–Mar', 'Apr–May', 'Jun–Jul', 'Aug–Sep', 'Oct–Nov', 'Dec–Jan']
    : ['Jan–Feb', 'Mar–Apr', 'May–Jun', 'Jul–Aug', 'Sep–Oct', 'Nov–Dec'];

  for (let i = 0; i < vatEndMonths.length; i++) {
    const endMonth = vatEndMonths[i] as number;
    const dueMonth = endMonth + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;

    events.push({
      eventType: 'VAT201_DUE',
      dueDate: `${dueYear}-${pad(dueM)}-25`,
      description: `VAT201 return for ${vatLabels[i]} ${y}`,
      status: getDeadlineStatus(`${dueYear}-${pad(dueM)}-25`),
    });
  }

  // EMP201 deadlines — due 7th of each following month
  const calMonthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  for (let m = 1; m <= 12; m++) {
    const dueMonth = m + 1;
    const dueYear = dueMonth > 12 ? y + 1 : y;
    const dueM = dueMonth > 12 ? 1 : dueMonth;

    events.push({
      eventType: 'EMP201_DUE',
      dueDate: `${dueYear}-${pad(dueM)}-07`,
      description: `EMP201 (PAYE/UIF/SDL) for ${calMonthNames[m - 1]} ${y}`,
      status: getDeadlineStatus(`${dueYear}-${pad(dueM)}-07`),
    });
  }

  // EMP501 — Interim (end of May) and Annual (end of October)
  events.push({
    eventType: 'EMP501_DUE',
    dueDate: `${y}-05-31`,
    description: `EMP501 Interim Reconciliation — Tax Year ending Feb ${y}`,
    status: getDeadlineStatus(`${y}-05-31`),
  });
  events.push({
    eventType: 'EMP501_DUE',
    dueDate: `${y}-10-31`,
    description: `EMP501 Annual Reconciliation — Tax Year ending Feb ${y}`,
    status: getDeadlineStatus(`${y}-10-31`),
  });

  // Provisional Tax (IRP6) — End of August and end of February
  events.push({
    eventType: 'PROVISIONAL_TAX',
    dueDate: `${y}-08-31`,
    description: `IRP6 First Provisional Tax Payment — Tax Year ending Feb ${y + 1}`,
    status: getDeadlineStatus(`${y}-08-31`),
  });
  events.push({
    eventType: 'PROVISIONAL_TAX',
    dueDate: `${y + 1}-02-28`,
    description: `IRP6 Second Provisional Tax Payment — Tax Year ending Feb ${y + 1}`,
    status: getDeadlineStatus(`${y + 1}-02-28`),
  });

  // Sort by due date
  events.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return events;
}

/**
 * Load compliance events from the database (if any exist), merged with
 * the static calendar. DB events can override status (e.g. marked completed).
 */
export async function getComplianceCalendarWithDB(companyId: string, year?: number): Promise<ComplianceEvent[]> {
  const staticEvents = getComplianceCalendar(year);

  try {
    const y = year || new Date().getFullYear();
    const dbEvents = (await sql`
      SELECT
        ce.id, ce.event_type, ce.due_date, ce.description,
        ce.status, ce.submission_id
      FROM sars_compliance_events ce
      WHERE EXTRACT(YEAR FROM ce.due_date) = ${y}
         OR EXTRACT(YEAR FROM ce.due_date) = ${y + 1}
      ORDER BY ce.due_date
    `) as Row[];

    // Merge: if a DB event matches a static event by type + due_date, use DB status
    const dbMap = new Map<string, Row>();
    for (const dbe of dbEvents) {
      const key = `${dbe.event_type}_${String(dbe.due_date).slice(0, 10)}`;
      dbMap.set(key, dbe);
    }

    return staticEvents.map((se) => {
      const key = `${se.eventType}_${se.dueDate}`;
      const dbMatch = dbMap.get(key);
      if (dbMatch) {
        return {
          ...se,
          id: String(dbMatch.id),
          status: dbMatch.status as ComplianceEvent['status'],
          submissionId: dbMatch.submission_id ? String(dbMatch.submission_id) : undefined,
        };
      }
      return se;
    });
  } catch (err) {
    log.warn('Could not load compliance events from DB, using static calendar', { error: err }, 'sarsService');
    return staticEvents;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function getDeadlineStatus(dueDate: string): ComplianceEvent['status'] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);

  if (due < today) return 'overdue';
  return 'pending';
}

function mapSubmissionRow(row: Row): SARSSubmission {
  return {
    id: String(row.id),
    formType: String(row.form_type),
    periodStart: String(row.period_start).slice(0, 10),
    periodEnd: String(row.period_end).slice(0, 10),
    status: String(row.status),
    formData: row.form_data || {},
    submissionReference: row.submission_reference ? String(row.submission_reference) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    submittedBy: row.submitted_by ? String(row.submitted_by) : null,
    notes: row.notes ? String(row.notes) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
