/**
 * `detail: "summary"` / `group_by` for the list tools whose rows can outgrow a client's result limit
 * (about 90 KB). Totals and groups come from the tool's service, computed in SQL over the same predicate
 * its rows use (services/shared/groupedSummary.ts), so an agent sizing a ledger-scale question reads a
 * few hundred bytes instead of paging for them.
 *
 * Contract, the same on every tool that takes it:
 *  - `detail: "summary"` returns `totals` only; `group_by` adds `groups` and implies summary.
 *  - A summary covers the WHOLE filter set, so `cursor`/`offset` are refused and `limit` is ignored.
 *  - Absent both arguments the tool answers exactly as it did before.
 */
import type { McpToolResult } from '../types';
import type { GroupedSummary } from '@/modules/accounting/services/shared/groupedSummary';
import { toolError } from './toolHelpers';

export type SummaryRequest<G extends string> =
  | { ok: true; summary: boolean; groupBy: G | null }
  | { ok: false; error: McpToolResult };

export const SUMMARY_DETAIL_SCHEMA = {
  type: 'string',
  enum: ['summary', 'standard'],
  description: 'summary = totals (and groups, with group_by) over the whole filter set, no rows. Default standard (rows).',
} as const;

export function groupBySchema(values: readonly string[]): Record<string, unknown> {
  return {
    type: 'string',
    enum: [...values],
    description: `Group the summary by one of: ${values.join(', ')}. Implies detail "summary".`,
  };
}

const NOT_A_PAGE = 'a summary covers the whole filter set, not a page: omit cursor and offset';

/**
 * `lenientDetail` keeps a tool's pre-existing reading of `detail` (an unknown value falls back to rows);
 * a tool that gains `detail` here refuses an unknown one instead.
 */
export function parseSummaryRequest<G extends string>(
  args: Record<string, unknown>,
  groupByValues: readonly G[],
  lenientDetail = false,
): SummaryRequest<G> {
  const fail = (text: string): { ok: false; error: McpToolResult } => ({ ok: false, error: toolError(text) });
  const detail = args.detail === undefined || args.detail === null ? undefined : args.detail;
  if (detail !== undefined && typeof detail !== 'string') return fail('detail must be a string');
  const rowDetails = lenientDetail ? ['standard', 'full'] : ['standard'];
  if (detail !== undefined && detail !== 'summary' && !rowDetails.includes(detail) && !lenientDetail) {
    return fail('detail must be "summary" or "standard"');
  }
  const rawGroup = args.group_by;
  let groupBy: G | null = null;
  if (rawGroup !== undefined && rawGroup !== null) {
    const match = groupByValues.find((g) => g === rawGroup);
    if (match === undefined) return fail(`group_by must be one of: ${groupByValues.join(', ')}`);
    groupBy = match;
  }
  if (groupBy !== null && detail !== undefined && rowDetails.includes(detail)) {
    return fail('group_by needs detail "summary": omit detail or set it to "summary"');
  }
  const summary = detail === 'summary' || groupBy !== null;
  if (summary && (args.cursor !== undefined || args.offset !== undefined)) return fail(NOT_A_PAGE);
  return { ok: true, summary, groupBy };
}

/** The group fields of a grouped summary; the totals-only mode carries none. */
export function groupFields(result: GroupedSummary, groupBy: string): Record<string, unknown> {
  return {
    group_by: groupBy,
    groups: result.groups.map((g) => ({ key: g.key, label: g.label, ...g.values })),
    groups_total: result.groupsTotal,
    groups_returned: result.groups.length,
    other: result.other,
  };
}

/** The wire shape of a summary. `extra` carries a tool's echo of its own window (dates, table). */
export function summaryBody(
  result: GroupedSummary,
  groupBy: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    detail: 'summary',
    group_by: groupBy,
    ...extra,
    totals: result.totals,
    ...(groupBy === null ? {} : groupFields(result, groupBy)),
  };
}
