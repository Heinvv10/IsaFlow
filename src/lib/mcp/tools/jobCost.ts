/**
 * MCP read tool: job_cost_report — where unbilled effort is actually stuck.
 *
 * Split out of domainReports.ts to stay under the 300-line cap. It is the
 * counterpart to `wip_report` and deliberately answers a different question:
 * WIP is approved, billable, unbilled time, which on these books is 24 entries
 * worth R42,455 — while 2,013 entries worth R2,448,850 sit in `submitted`,
 * logged and sent for approval and never approved. A practice reading WIP alone
 * is out by R2.4m, and only showing the statuses side by side reveals it.
 */
import type { McpTool } from '../types';
import {
  getJobCostReport,
  type JobCostGrouping,
} from '@/modules/accounting/services/practice/jobCostService';
import { buildEnvelope, isDetailLevel } from '../contracts';
import type { DetailLevel, ExcludedRow } from '../contracts';
import { guardCastableArgs, ok, strArg } from './toolHelpers';
import { fmtDate } from '@/lib/fmtDate';

const NO_LEDGER_ROWS = '1970-01-01T00:00:00.000Z';

function detailOf(args: Record<string, unknown>): DetailLevel {
  const raw = strArg(args, 'detail');
  return raw && isDetailLevel(raw) ? raw : 'standard';
}

const JOB_COST_GROUPINGS: readonly JobCostGrouping[] = ['client', 'category', 'work_item'];

export const jobCostReportTool: McpTool = {
  name: 'job_cost_report',
  description:
    'Logged effort and its value across EVERY time-entry status, grouped by practice client, job category or work item: hours, value and entry count in each status, plus the unbilled total. ' +
    'READ THIS INSTEAD OF wip_report IF YOU WANT TO KNOW WHAT IS OWED. wip_report counts only APPROVED, billable, unbilled time — the correct definition of work in progress and a badly incomplete picture of unbilled effort. On these books it returns 24 entries worth R42,455, while 2,013 entries worth R2,448,850 sit in submitted: logged, sent for approval, and never approved. Showing the statuses side by side is what makes that blockage visible; a WIP figure alone is out by R2.4m. ' +
    'unbilled_value counts billable time at ANY approval status that has not yet been billed or invoiced. Non-billable time and leave are in the status buckets and the totals but never in unbilled_value. ' +
    'Value is the line_total STORED on each entry — hours times the rate that applied when it was logged — not recomputed here, because hours is NUMERIC(6,2) and re-deriving the money reintroduces a rounding difference. It carries no VAT. ' +
    'This is practice time only. Nothing here has reached the general ledger, and it does not include materials, subcontractors or any cost that was journalised — project_profitability covers the GL side. An entry with no client, category or work item cannot be grouped and appears in excludedRows with its value.',
  scope: 'read:practice',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      group_by: {
        type: 'string',
        enum: ['client', 'category', 'work_item'],
        description: 'Defaults to client.',
      },
      practice_client_id: { type: 'string', description: 'Narrow to one practice client.' },
      date_from: { type: 'string', format: 'date', description: 'Inclusive entry date, YYYY-MM-DD.' },
      date_to: { type: 'string', format: 'date', description: 'Inclusive entry date, YYYY-MM-DD.' },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, {
      uuid: ['practice_client_id'],
      date: ['date_from', 'date_to'],
    });
    if (guard) return guard;

    // A JSON Schema enum is advisory in this server — nothing validates against
    // it — and this value chooses a SQL grouping branch.
    const requested = strArg(args, 'group_by');
    const groupBy: JobCostGrouping =
      requested !== undefined && (JOB_COST_GROUPINGS as readonly string[]).includes(requested)
        ? (requested as JobCostGrouping)
        : 'client';

    const detail = detailOf(args);
    const report = await getJobCostReport(ctx.companyId, {
      groupBy,
      dateFrom: strArg(args, 'date_from'),
      dateTo: strArg(args, 'date_to'),
      practiceClientId: strArg(args, 'practice_client_id'),
    });

    const rows = report.rows.map((r) => ({
      group_id: r.groupId,
      group_name: r.groupName,
      total_hours: r.totalHours,
      total_value: r.totalValue,
      unbilled_hours: r.unbilledHours,
      unbilled_value: r.unbilledValue,
      by_status: r.byStatus,
    }));

    const envelope = buildEnvelope({
      rows: detail === 'summary' ? [] : rows,
      rowsTotal: report.rowsTotal,
      universeTotal: report.universeTotal,
      detail,
      as_at: strArg(args, 'date_to') ?? fmtDate(new Date()),
      posted_through: report.postedThrough ?? NO_LEDGER_ROWS,
      excludedRows: report.excluded as ExcludedRow[],
    });

    return ok({
      ...envelope,
      group_by: groupBy,
      totals: report.totals,
    });
  },
};
