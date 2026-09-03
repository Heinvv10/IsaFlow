/**
 * MCP read tool: the VAT201.
 *
 * Rewritten because the old one was unusable on a real company. It returned
 * 67,571 characters for a two-month period — over the response limit — because
 * it inlined every underlying transaction with no detail level and no paging.
 * And its arithmetic did not tie: the tax came from the VAT control accounts
 * while the values that tax is meant to be 15% of came from the invoice tables,
 * so box 15 on Velocity Fibre missed SARS's own check by R5.1m and the return
 * could not be filed. Both figures now come from the same journals.
 */
import type { McpTool } from '../types';
import { buildEnvelope, figureBasis, isDetailLevel, type DetailLevel } from '../contracts';
import {
  getVat201Report,
  type Vat201Detail,
} from '@/modules/accounting/services/reports/vat201ReportService';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/**
 * The audit specification names the middle level `boxes`; the shared contract
 * names it `standard`. They are the same level — one row per reporting entity,
 * and the reporting entity of a VAT201 is the box. Both spellings are accepted
 * so neither document is wrong, and the envelope always reports the contract's
 * name back.
 */
function detailArg(args: Record<string, unknown>): Vat201Detail {
  const raw = strArg(args, 'detail');
  if (raw === 'boxes') return 'standard';
  return isDetailLevel(raw) ? (raw as DetailLevel) : 'standard';
}

export const vatStatusTool: McpTool = {
  name: 'vat_status',
  description:
    'The VAT201 for a period, computed live from posted journals. Give the VAT period start and end dates (YYYY-MM-DD; South African VAT periods are normally two calendar months). '
    + 'Returns the SARS boxes, each with BOTH the value of the supply (base) and the tax posted against it, plus totals: box 4 output tax, box 19 input tax, box 20 net VAT payable (positive) or refundable (negative). '
    + 'rateCheck runs SARS\'s own 15% test before you file: impliedTax is base x 15% and variance is tax minus that. ties=false means the ledger disagrees with itself and the return will be queried — read the per-box variance to find which box, then detail="full" for the journals behind it. '
    + 'detail: "summary" = boxes and totals only, no transactions; "standard" (the default, also spelled "boxes") = boxes plus the VAT journal lines, paged; "full" = the same lines each with the base legs of their journal, which is what shows you WHAT was supplied or purchased. Page with cursor until next_cursor is null. '
    + 'excludedRows carries VAT the report could not place in any box — most often tax posted to an account with no VAT posting treatment, which is money SARS is owed or owed to you that no box reports. Read it: it is not a footnote. '
    + 'LIMITS: posted journals only, so drafts are invisible; the period is taken literally from entry_date, so a journal dated outside its VAT period lands in the wrong return; and this computes the return, it does not file it.',
  scope: 'read:vat',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date' },
      period_end: { type: 'string', format: 'date' },
      detail: { type: 'string', enum: ['summary', 'boxes', 'standard', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const start = strArg(args, 'period_start');
    const end = strArg(args, 'period_end');
    if (!start || !end) return toolError('period_start and period_end are required (YYYY-MM-DD)');
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    if (start > end) return toolError('period_start must not be after period_end');

    const detail = detailArg(args);
    const report = await getVat201Report(ctx.companyId, start, end, {
      detail,
      limit: clampLimit(args, 100, 200),
      cursor: strArg(args, 'cursor'),
    });

    return ok({
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      boxes: report.boxes,
      totals: report.totals,
      rateCheck: report.rateCheck,
      // The excluded block groups by account, so the line count and the rand
      // total behind it are stated here rather than left to be inferred.
      excludedLineCount: report.excludedLineCount,
      excludedAmount: report.excludedAmount,
      ...buildEnvelope({
        rows: report.rows,
        rowsTotal: report.rowsTotal,
        universeTotal: report.universeTotal,
        excludedRows: report.excludedRows,
        detail,
        as_at: report.periodEnd,
        posted_through: report.postedThrough,
        next_cursor: report.nextCursor,
        figureBasis: figureBasis('vat.output.v1'),
      }),
    });
  },
};
