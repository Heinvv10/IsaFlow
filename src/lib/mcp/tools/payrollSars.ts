/**
 * MCP read tools: EMP201 status and IRP5 data.
 *
 * `emp201_status` WRAPS `reports/emp201Service#generateEMP201`, whose status
 * filter was `'calculated'` until recently — that matched 1 of 86 production pay
 * runs, so the monthly PAYE/UIF/SDL declaration was built from one run and
 * showed almost nothing owing. It now reads the declarable statuses and carries
 * the ETI offset. This tool deliberately does not re-derive any of it.
 *
 * `irp5_data` is a BUILD despite the spec calling it a wrap.
 * `irp5Service#buildIRP5Certificate` is real, but nothing assembled the
 * `IRP5EmployeeData` it takes: the only caller of that module,
 * `pages/api/accounting/sars/emp501.ts`, aggregates `payroll_runs` and
 * `payslips`, two tables dropped in migration 384, so it throws 42P01 on every
 * call. `payroll/irp5DataService` is the aggregate that was missing.
 */
import type { McpTool } from '../types';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import { buildEnvelope, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

function wholeNumberArg(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export const emp201StatusTool: McpTool = {
  name: 'emp201_status',
  description:
    'The SARS EMP201 position for a period: PAYE withheld, the ETI claimed against it, PAYE actually payable after that offset, UIF split into the employee and employer halves, SDL, and the pay runs each figure came from. ' +
    'It counts only runs in a DECLARABLE status — approved or paid. A draft or calculated run is not a finalised payroll and must not be declared, and a cancelled one never counts. It reports the runs it used so you can check that against list_pay_runs; if a month you expected is missing, the run was almost certainly never approved. ' +
    'The UIF split is an approximation. payroll_run_headers stores a single combined employee-plus-employer total, so this halves it. Where the two halves genuinely differ — an employee over the UIF ceiling, or one excluded from UIF — the split will be wrong even though the combined total is right. ' +
    'It does not file anything, does not compute penalties or interest, and does not know what was actually paid over to SARS. It tells you what the payroll says is owed for the period, not what is outstanding.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      period_end: { type: 'string', format: 'date', description: 'Inclusive YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (guard) return guard;
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    if (end < start) return toolError('period_end must not precede period_start');

    const detail = detailOf(args);
    const data = await generateEMP201(ctx.companyId, start, end);

    const rows = data.payrollRuns.map((r) => ({
      run_id: r.id,
      run_date: r.runDate,
      employee_count: r.employeeCount,
      gross_pay: r.grossPay,
      paye: r.paye,
      eti: r.eti,
      uif: r.uif,
      sdl: r.sdl,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: rows.length,
      // universeTotal omitted, and NOT because the universe is these rows.
      // emp201Service filters to declarable runs (approved/paid), so a wider
      // candidate set genuinely exists — every run in the period — but this
      // tool does not count it and does not report the runs it drops. Claiming
      // `rows.length` asserted an identity that could not fail AND implied a
      // completeness this report does not have. Stating nothing is honest;
      // the asymmetry with irp5_data, which DOES name its non-declarable runs
      // from the same status list, is recorded as a finding.
      detail,
      as_at: end,
      // The EMP201 is built from run headers, not journal rows; the last period
      // it covers is the honest pin, and now() would prove nothing.
      posted_through: rows.length > 0
        ? `${rows[rows.length - 1]!.run_date}T00:00:00.000Z`
        : NO_LEDGER_ROWS,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      period_start: data.periodStart,
      period_end: data.periodEnd,
      paye_withheld: data.totalPAYE,
      eti_claimed: data.totalETI,
      paye_payable: data.payePayable,
      uif_employee: data.totalUIF_employee,
      uif_employer: data.totalUIF_employer,
      uif_total: data.totalUIF,
      uif_split_is_approximate: true,
      sdl: data.totalSDL,
      total_declared: data.totalDeductions,
      employee_count: data.employeeCount,
      taxable_remuneration: data.totalTaxableRemuneration,
    });
  },
};

export const irp5DataTool: McpTool = {
  name: 'irp5_data',
  description:
    'Per-employee annual payroll totals for a SARS tax year, as an IRP5 / IT3(a) needs them: gross remuneration, taxable income, PAYE, the employee and employer UIF halves, SDL, ETI and net pay, with the number of pay runs behind each employee. ' +
    'The SA tax year runs 1 MARCH to 28 or 29 FEBRUARY, so tax_year 2026 means 2025-03-01 to 2026-02-28. Pass the year the tax year ENDS in. ' +
    'It counts only DECLARABLE runs — approved or paid — using the same status list as emp201_status, so a certificate and a monthly declaration cannot disagree about which runs happened. Runs inside the year that were never approved appear in excludedRows as run_not_declarable with the remuneration they carry, because "this employee earned nothing" and "this employee\'s runs were never approved" are different facts. ' +
    'SA identity numbers and SARS tax numbers are MASKED to their last four digits unless you pass reveal_identity_numbers: true. They are personal information under POPIA. ' +
    'This is the DATA for a certificate, not a certificate. It does not allocate amounts to SARS source codes, does not validate against the IRP5 rules, does not produce an EasyFile export, and does not file anything. It also carries no allowance or fringe-benefit breakdown — those live in each run line\'s component detail and are not aggregated here.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      tax_year: {
        type: 'number',
        description: 'The calendar year the SA tax year ENDS in, e.g. 2026 for 2025-03-01 to 2026-02-28.',
      },
      employee_id: { type: 'string', description: 'Narrow to one payroll employee.' },
      reveal_identity_numbers: {
        type: 'boolean',
        description: 'Return full SA ID and tax numbers instead of the last four digits. Personal information — ask only when you need it.',
      },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    required: ['tax_year'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['employee_id'] });
    if (guard) return guard;

    const taxYear = wholeNumberArg(args.tax_year, 1900, 2999);
    if (taxYear === null) return toolError('tax_year must be a four-digit calendar year');

    const detail = detailOf(args);
    const ds = await getIrp5EmployeeTotals(ctx.companyId, taxYear, {
      revealIdentityNumbers: args.reveal_identity_numbers === true,
      employeeId: strArg(args, 'employee_id'),
    });

    const rows = ds.rows.map((r) => ({
      employee_id: r.employeeId,
      employee_number: r.employeeNumber,
      first_name: r.firstName,
      last_name: r.lastName,
      id_number: r.idNumber,
      tax_number: r.taxNumber,
      identity_numbers_masked: r.identityNumbersMasked,
      gross_salary: r.grossSalary,
      taxable_income: r.taxableIncome,
      paye: r.paye,
      uif_employee: r.uifEmployee,
      uif_employer: r.uifEmployer,
      sdl: r.sdl,
      eti: r.eti,
      net_pay: r.netPay,
      runs_included: r.runsIncluded,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: ds.rowsTotal,
      universeTotal: ds.universeTotal,
      detail,
      as_at: ds.periodEnd,
      posted_through: ds.postedThrough ?? NO_LEDGER_ROWS,
      excludedRows: ds.excluded as ExcludedRow[],
      // Excluded employees are listed individually up to a cap; excludedTotal
      // is the real count, so `truncatedExcludedRows` tells the reader when the
      // list they can see is shorter than the count they are given.
      excludedTotal: ds.excludedTotal,
    });

    return ok({
      ...envelope,
      tax_year: ds.taxYear,
      period_start: ds.periodStart,
      period_end: ds.periodEnd,
      totals: {
        gross_salary: rows.reduce((s, r) => s + r.gross_salary, 0),
        paye: rows.reduce((s, r) => s + r.paye, 0),
        uif_employee: rows.reduce((s, r) => s + r.uif_employee, 0),
        uif_employer: rows.reduce((s, r) => s + r.uif_employer, 0),
        sdl: rows.reduce((s, r) => s + r.sdl, 0),
        eti: rows.reduce((s, r) => s + r.eti, 0),
      },
    });
  },
};
