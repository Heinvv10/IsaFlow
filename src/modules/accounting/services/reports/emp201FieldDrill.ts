/**
 * Drill-down behind each EMP201 total (PAYE, ETI, UIF, SDL, taxable remuneration),
 * read-only: per employee per run, with each run's header total beside the sum of
 * its lines. Personal data: the route is payroll-detail roles only, no token
 * channel, `Cache-Control: no-store`.
 *
 * WHICH RUNS. The same set `generateEMP201` declares: this company's headers whose
 * status is in `EMP201_DECLARABLE_STATUSES` (approved, paid) and whose period month
 * starts inside [from, to]. A calculated, draft, cancelled or reopened run is not
 * in it, so the drill never shows a figure the EMP201 does not carry. PAYE and
 * taxable remuneration also list the SARS directive payments made outside payroll,
 * as the EMP201 adds them.
 *
 * The EMP201 sums the HEADER totals; this lists the LINES. `difference` is the
 * header total less the lines' sum, shown rather than hidden: non-zero is a run
 * whose stored header and lines disagree.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import { MAX_DRILL_PAGE_SIZE } from './drillPaging';

export const EMP201_DRILL_FIELDS = ['paye', 'eti', 'uif', 'sdl', 'remuneration'] as const;
export type Emp201DrillField = (typeof EMP201_DRILL_FIELDS)[number];

export interface Emp201DrillRow {
  runId: string;
  periodYear: number;
  periodMonth: number;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  amount: number;
}

export interface Emp201DrillRun {
  runId: string;
  periodYear: number;
  periodMonth: number;
  status: string;
  headerTotal: number;
  linesTotal: number;
  difference: number;
}

export interface Emp201DrillDirective {
  paymentId: string;
  directiveNumber: string | null;
  employeeName: string;
  paymentDate: string;
  amount: number;
}

export interface Emp201DrillResult {
  field: Emp201DrillField;
  periodStart: string;
  periodEnd: string;
  /** Declarable runs' header totals plus directive payments: the EMP201's figure. */
  total: number;
  /** Lines plus directive payments: what the rows add up to. */
  rowsTotal: number;
  ties: boolean;
  runs: Emp201DrillRun[];
  directivePayments: Emp201DrillDirective[];
  page: number;
  pageSize: number;
  rowCount: number;
  hasMore: boolean;
  rows: Emp201DrillRow[];
}

const cents = (n: number): number => Math.round(n * 100);
const rands = (c: number): number => c / 100;

export function isEmp201DrillField(field: string): field is Emp201DrillField {
  return (EMP201_DRILL_FIELDS as readonly string[]).includes(field);
}

/** Null when `runId` is not a declarable run of this company in the window. */
export async function emp201FieldDrill(
  companyId: string, periodStart: string, periodEnd: string, field: Emp201DrillField,
  opts: { runId?: string; page?: number; pageSize?: number } = {},
): Promise<Emp201DrillResult | null> {
  const startDate = periodStart.slice(0, 10);
  const endDate = periodEnd.slice(0, 10);
  const statuses: string[] = [...EMP201_DECLARABLE_STATUSES];
  const size = Math.min(Math.max(Math.trunc(opts.pageSize ?? 100) || 100, 1), MAX_DRILL_PAGE_SIZE);
  const pg = Math.max(Math.trunc(opts.page ?? 1) || 1, 1);

  const lineRows = (await sql`
    SELECT prl.id::TEXT AS line_id, prh.id::TEXT AS run_id, prh.period_year, prh.period_month, prh.status,
           prh.total_paye, prh.total_eti, prh.total_uif, prh.total_sdl, prh.total_gross,
           prl.employee_id::TEXT AS employee_id, COALESCE(pe.employee_number, '') AS employee_number,
           TRIM(COALESCE(pe.first_name, '') || ' ' || COALESCE(pe.last_name, '')) AS employee_name,
           prl.paye, prl.eti, COALESCE(prl.uif_employee, 0) + COALESCE(prl.uif_employer, 0) AS uif, prl.sdl,
           prl.gross_pay, COALESCE((
             SELECT SUM((item->>'amount')::numeric)
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array'
                 THEN prl.component_breakdown ELSE '[]'::jsonb END) item
              WHERE item->>'isNonCash' = 'true'), 0) AS non_cash
    FROM payroll_run_headers prh
    LEFT JOIN payroll_run_lines prl ON prl.run_id = prh.id
    LEFT JOIN payroll_employees pe ON pe.id = prl.employee_id AND pe.company_id = prh.company_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.status = ANY(${statuses}::text[])
      AND make_date(prh.period_year, prh.period_month, 1) >= ${startDate}::date
      AND make_date(prh.period_year, prh.period_month, 1) <= ${endDate}::date
    ORDER BY prh.period_year, prh.period_month, pe.employee_number, prl.id
  `) as DbRow[];

  const headerKey = { paye: 'total_paye', eti: 'total_eti', uif: 'total_uif', sdl: 'total_sdl', remuneration: 'total_gross' }[field];
  const runs = new Map<string, Emp201DrillRun & { lineCents: number; headerCents: number }>();
  const all: Emp201DrillRow[] = [];
  for (const r of lineRows) {
    const runId = String(r.run_id);
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId, periodYear: Number(r.period_year), periodMonth: Number(r.period_month), status: String(r.status),
        headerTotal: 0, linesTotal: 0, difference: 0, lineCents: 0, headerCents: cents(Number(r[headerKey]) || 0),
      };
      runs.set(runId, run);
    }
    if (r.line_id == null) continue;
    const nonCash = Number(r.non_cash) || 0;
    // Remuneration is cash gross plus the non-cash benefits, as the EMP201 adds them; its header total
    // is cash gross only, so the run's non-cash lines are added to it here.
    const amount = Math.round((field === 'remuneration' ? (Number(r.gross_pay) || 0) + nonCash : Number(r[field]) || 0) * 100) / 100;
    if (field === 'remuneration') run.headerCents += cents(nonCash);
    run.lineCents += cents(amount);
    all.push({
      runId, periodYear: run.periodYear, periodMonth: run.periodMonth, employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number), employeeName: String(r.employee_name), amount,
    });
  }
  if (opts.runId !== undefined && !runs.has(opts.runId)) return null;
  const scoped = [...runs.values()].filter((r) => opts.runId === undefined || r.runId === opts.runId);
  const rows = all.filter((r) => opts.runId === undefined || r.runId === opts.runId);

  const directives: Emp201DrillDirective[] = [];
  if ((field === 'paye' || field === 'remuneration') && opts.runId === undefined) {
    const standalone = await listStandaloneDirectivePayments(companyId, { start: startDate, end: endDate });
    for (const p of standalone) {
      directives.push({
        paymentId: p.paymentId, directiveNumber: p.directiveNumber, employeeName: p.employeeName,
        paymentDate: p.paymentDate, amount: field === 'paye' ? p.paye : p.gross,
      });
    }
  }
  const directiveCents = directives.reduce((s, d) => s + cents(d.amount), 0);
  const runList: Emp201DrillRun[] = scoped.map((r) => ({
    runId: r.runId, periodYear: r.periodYear, periodMonth: r.periodMonth, status: r.status,
    headerTotal: rands(r.headerCents), linesTotal: rands(r.lineCents), difference: rands(r.headerCents - r.lineCents),
  }));
  const headerCents = scoped.reduce((s, r) => s + r.headerCents, 0);
  const lineCents = scoped.reduce((s, r) => s + r.lineCents, 0);
  return {
    field, periodStart, periodEnd,
    total: rands(headerCents + directiveCents), rowsTotal: rands(lineCents + directiveCents),
    ties: headerCents === lineCents, runs: runList, directivePayments: directives,
    page: pg, pageSize: size, rowCount: rows.length, hasMore: pg * size < rows.length,
    rows: rows.slice((pg - 1) * size, pg * size),
  };
}
