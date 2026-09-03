/**
 * MCP read tools: payroll.
 *
 * The connector had no payroll surface at all. On the two live sets of books
 * these were specified against there are zero pay runs and zero payroll
 * employees, no PAYE/UIF/SDL liability has ever been raised, and the payroll
 * GL structure (2140/2150/2160/2170/2175) sits empty — deactivated on
 * Brightsphere, active on Velocity Fibre. An agent could read the whole ledger
 * and not be able to tell you any of that.
 *
 * Both tools return a `ReportEnvelope`, so "no pay runs" and "the first page of
 * eighty-six pay runs" are distinguishable, which they are not from a bare
 * array.
 */
import type { McpTool } from '../types';
import {
  listPayrollEmployeesPage,
  payrollEmployeeCursorParts,
} from '@/modules/accounting/services/payroll/payrollEmployeeQueryService';
import {
  listPayRunsPage,
  payRunCursorParts,
} from '@/modules/accounting/services/payroll/payrollRunQueryService';
import { buildEnvelope, decodeCursor, encodeCursor, isDetailLevel } from '../contracts';
import type { DetailLevel } from '../contracts';
import { clampLimit, ok, strArg, toolError } from './toolHelpers';
import { fmtDate } from '@/lib/fmtDate';

const EMPLOYEE_STATUSES = ['active', 'terminated', 'suspended', 'on_leave'] as const;
const RUN_STATUSES = ['draft', 'calculated', 'approved', 'paid', 'cancelled'] as const;

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

/**
 * `universeTotal` is the candidate set for the CALLER'S filter, not the whole
 * company.
 *
 * The envelope's completeness identity exists to catch rows the REPORT dropped
 * on its own — a null due date silently removed from an aging. A status the
 * caller explicitly asked for is not a gap in the report; counting the whole
 * company as the universe made `status: "approved"` raise a completenessFault
 * saying "1 unaccounted" on every call, which trains a reader to ignore the
 * field that matters. The narrowing is reported as `filtered_out` instead, so
 * it is still visible without crying wolf.
 */
function filteredOut(universeTotal: number, rowsTotal: number): number {
  return Math.max(0, universeTotal - rowsTotal);
}

/** `posted_through` is MAX(created_at) of the rows consumed — never now(). */
function postedThroughOr(value: string | null): string {
  return value ?? '1970-01-01T00:00:00.000Z';
}

export const listEmployeesTool: McpTool = {
  name: 'list_employees',
  description:
    'List payroll employees with their employment status, start and end dates, and whether they are excluded from UIF. ' +
    'Returns EVERY status by default — active, terminated, suspended — because a listing that silently showed only active staff would hide exactly the leaver whose final pay run you are chasing. Pass status to narrow it. ' +
    'SA identity numbers and SARS tax numbers are MASKED to their last four digits unless you pass reveal_identity_numbers: true; they are personal information under POPIA and an agent reconciling headcount does not need them. ' +
    'This is the payroll employee master, NOT the application users returned by company_profile, and NOT the AR customers returned by list_customers. ' +
    'It does not tell you what anyone was paid — that is list_pay_runs for the totals, and the run itself for per-employee lines. ' +
    'Paginated: pass the returned next_cursor to get the following page. rowsTotal is the number matching your filter; a completenessFault means the report could not account for every candidate row and says how many.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...EMPLOYEE_STATUSES], description: 'Omit for every status.' },
      reveal_identity_numbers: {
        type: 'boolean',
        description: 'Return full SA ID and tax numbers instead of the last four digits. Personal information — ask only when you need it.',
      },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'number', description: 'Default 50, max 200.' },
      cursor: { type: 'string', description: 'next_cursor from a previous call.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const detail = detailOf(args);
    const limit = clampLimit(args, 50, 200);

    const rawCursor = strArg(args, 'cursor');
    let after: readonly string[] | undefined;
    if (rawCursor) {
      const decoded = decodeCursor(rawCursor, 3);
      if (!decoded) return toolError('invalid cursor');
      after = decoded.parts;
    }

    const page = await listPayrollEmployeesPage(ctx.companyId, {
      status: strArg(args, 'status'),
      revealIdentityNumbers: args.reveal_identity_numbers === true,
      limit,
      after,
    });

    const last = page.rows[page.rows.length - 1];
    const envelope = buildEnvelope({
      rows: page.rows.map((e) => ({
        id: e.id,
        employee_number: e.employeeNumber,
        first_name: e.firstName,
        last_name: e.lastName,
        status: e.status,
        employment_type: e.employmentType,
        start_date: e.startDate,
        end_date: e.endDate,
        cost_centre_id: e.costCentreId,
        uif_excluded: e.uifExcluded,
        id_number: e.idNumber,
        tax_number: e.taxNumber,
        id_number_masked: e.idNumberMasked,
      })),
      rowsTotal: page.rowsTotal,
      // universeTotal omitted. It used to be `page.rowsTotal` — the same
      // quantity buildEnvelope checks it against, so `rowsTotal + 0 ===
      // rowsTotal` could not fail whatever the query did. Passing the real
      // wider set (page.universeTotal) instead would be worse: it raises a
      // completenessFault for a narrowing the CALLER asked for, which is the
      // crying-wolf problem the comment above filteredOut() describes. So the
      // wider set is reported OUTSIDE the identity, as company_total_* and
      // filtered_out below — the same place chart_of_accounts_health puts its
      // universe. Nothing is lost; the claim that could not fail is.
      detail,
      as_at: fmtDate(new Date()),
      posted_through: postedThroughOr(page.postedThrough),
      next_cursor: page.hasMore && last ? encodeCursor({ parts: payrollEmployeeCursorParts(last) }) : null,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      company_total_employees: page.universeTotal,
      filtered_out: filteredOut(page.universeTotal, page.rowsTotal),
    });
  },
};

export const listPayRunsTool: McpTool = {
  name: 'list_pay_runs',
  description:
    'List payroll runs with their statutory totals — gross, PAYE, UIF (employee and employer combined), SDL, ETI and net pay — and whether each one actually reached the general ledger. ' +
    'posted_to_gl is the field that matters: a run can be calculated and approved and still have posted NOTHING, which is the state these books were found in. journal_entry_id names the journal when it did post. ' +
    'Filter by year or status. Statuses run draft → calculated → approved → paid; only an approved run can post its journal. ' +
    'It does NOT return per-employee payslip lines, EMP201 totals for a SARS period, or IRP5 data — those are separate calls. The UIF total is the employee and employer halves combined, so an EMP201 needs it split. ' +
    'rowsTotal counts the runs matching your filter and the envelope counts the whole company as its universe, so a status filter that hides 85 of 86 runs shows up as a completenessFault rather than as a short list.',
  scope: 'read:payroll',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      year: { type: 'number', description: 'Period year, e.g. 2026.' },
      status: { type: 'string', enum: [...RUN_STATUSES] },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'number', description: 'Default 50, max 200.' },
      cursor: { type: 'string', description: 'next_cursor from a previous call.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const detail = detailOf(args);
    const limit = clampLimit(args, 50, 200);

    const yearRaw = Number(args.year);
    if (args.year !== undefined && (!Number.isFinite(yearRaw) || yearRaw < 1900 || yearRaw > 9999)) {
      return toolError('invalid year');
    }

    const rawCursor = strArg(args, 'cursor');
    let after: readonly string[] | undefined;
    if (rawCursor) {
      const decoded = decodeCursor(rawCursor, 3);
      if (!decoded) return toolError('invalid cursor');
      after = decoded.parts;
    }

    const page = await listPayRunsPage(ctx.companyId, {
      year: args.year === undefined ? undefined : Math.floor(yearRaw),
      status: strArg(args, 'status'),
      limit,
      after,
    });

    const last = page.rows[page.rows.length - 1];
    const envelope = buildEnvelope({
      rows: page.rows.map((r) => ({
        id: r.id,
        period_year: r.periodYear,
        period_month: r.periodMonth,
        status: r.status,
        employee_count: r.employeeCount,
        total_gross: r.totalGross,
        total_paye: r.totalPaye,
        total_uif: r.totalUif,
        total_sdl: r.totalSdl,
        total_eti: r.totalEti,
        total_net: r.totalNet,
        journal_entry_id: r.journalEntryId,
        posted_to_gl: r.journalEntryId !== null,
      })),
      rowsTotal: page.rowsTotal,
      // universeTotal omitted. It used to be `page.rowsTotal` — the same
      // quantity buildEnvelope checks it against, so `rowsTotal + 0 ===
      // rowsTotal` could not fail whatever the query did. Passing the real
      // wider set (page.universeTotal) instead would be worse: it raises a
      // completenessFault for a narrowing the CALLER asked for, which is the
      // crying-wolf problem the comment above filteredOut() describes. So the
      // wider set is reported OUTSIDE the identity, as company_total_* and
      // filtered_out below — the same place chart_of_accounts_health puts its
      // universe. Nothing is lost; the claim that could not fail is.
      detail,
      as_at: fmtDate(new Date()),
      posted_through: postedThroughOr(page.postedThrough),
      next_cursor: page.hasMore && last ? encodeCursor({ parts: payRunCursorParts(last) }) : null,
      excludedRows: [],
    });

    return ok({
      ...envelope,
      company_total_runs: page.universeTotal,
      filtered_out: filteredOut(page.universeTotal, page.rowsTotal),
      posted_to_gl_on_this_page: page.rows.filter((r) => r.journalEntryId !== null).length,
    });
  },
};
