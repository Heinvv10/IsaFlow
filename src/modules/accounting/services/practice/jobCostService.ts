/**
 * Logged effort and its value, across EVERY status — the report that shows
 * where unbilled work is actually stuck.
 *
 * WHY THIS IS NOT `wip_report`. `practiceWipService#getWipByClient` counts only
 * time that is approved, billable and not yet billed, which is the correct
 * definition of work in progress and a badly incomplete picture of unbilled
 * effort. On these books it returns 24 entries worth R42,455 — while 2,013
 * entries worth R2,448,850 sit in `submitted`, logged and sent for approval and
 * never approved. A practice reading WIP alone would conclude it was owed
 * R42,455 and be out by R2.4m.
 *
 * So this reports every status side by side. The blockage is the finding, and
 * it is invisible unless the statuses are shown together.
 *
 * `line_total` is the STORED value, not hours times rate recomputed here. Hours
 * is NUMERIC(6,2) and the money was derived and rounded when the entry was
 * written; re-deriving it in JS reintroduces the rounding difference that was
 * already fixed once.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

export type JobCostGrouping = 'client' | 'category' | 'work_item';

/** Every status a time entry can hold. Named so a new one shows up as unknown. */
export const TIME_ENTRY_STATUSES = [
  'draft', 'submitted', 'approved', 'billed', 'invoiced', 'not_billable', 'leave',
] as const;

export interface JobCostStatusBucket {
  hours: number;
  value: number;
  entries: number;
}

export interface JobCostRow {
  groupId: string | null;
  groupName: string;
  byStatus: Record<string, JobCostStatusBucket>;
  totalHours: number;
  totalValue: number;
  /** Logged, billable, and not yet billed or invoiced — at ANY approval status. */
  unbilledValue: number;
  unbilledHours: number;
}

export interface JobCostExclusion {
  id: string;
  reason: string;
  detail?: string;
  amount?: number;
}

export interface JobCostReport {
  rows: JobCostRow[];
  rowsTotal: number;

  excluded: JobCostExclusion[];
  totals: {
    hours: number;
    value: number;
    unbilledValue: number;
  };
  postedThrough: string | null;
}

export interface JobCostFilters {
  groupBy: JobCostGrouping;
  dateFrom?: string;
  dateTo?: string;
  practiceClientId?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Statuses whose work has already been turned into an invoice. */
const BILLED_STATUSES = new Set(['billed', 'invoiced']);
/** Statuses that are not chargeable work at all. */
const NON_CHARGEABLE_STATUSES = new Set(['not_billable', 'leave']);

export async function getJobCostReport(
  companyId: string,
  filters: JobCostFilters,
): Promise<JobCostReport> {
  const df = filters.dateFrom ?? null;
  const dt = filters.dateTo ?? null;
  const pc = filters.practiceClientId ?? null;
  const byClient = filters.groupBy === 'client';
  const byCategory = filters.groupBy === 'category';

  // One aggregate over the whole population. Grouping is chosen in SQL rather
  // than by three near-identical queries, and the LEFT JOINs are for LABELS
  // only — every predicate that must restrict is in WHERE, because a predicate
  // in an outer join's ON clause restricts nothing.
  const rows = (await sql`
    SELECT
      CASE WHEN ${byClient}::BOOLEAN THEN te.practice_client_id::TEXT
           WHEN ${byCategory}::BOOLEAN THEN te.job_category_id::TEXT
           ELSE te.work_item_id::TEXT END AS group_id,
      CASE WHEN ${byClient}::BOOLEAN THEN pc.legal_name
           WHEN ${byCategory}::BOOLEAN THEN pjc.name
           ELSE pwi.name END AS group_name,
      te.status,
      te.billable,
      SUM(te.hours)::NUMERIC AS hours,
      COALESCE(SUM(te.line_total), 0)::NUMERIC AS value,
      COUNT(*)::INT AS entries,
      MAX(te.created_at) AS posted_through
    FROM time_entries te
    LEFT JOIN practice_clients pc ON pc.id = te.practice_client_id
    LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
    LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
    WHERE te.company_id = ${companyId}::UUID
      AND (${df}::DATE IS NULL OR te.entry_date >= ${df}::DATE)
      AND (${dt}::DATE IS NULL OR te.entry_date <= ${dt}::DATE)
      AND (${pc}::UUID IS NULL OR te.practice_client_id = ${pc}::UUID)
    GROUP BY 1, 2, te.status, te.billable
  `) as Row[];

  const grouped = new Map<string, JobCostRow>();
  const ungrouped: { hours: number; value: number; entries: number } =
    { hours: 0, value: 0, entries: 0 };
  let postedThrough: string | null = null;

  for (const r of rows) {
    const iso = r.posted_through ? new Date(String(r.posted_through)).toISOString() : null;
    if (iso && (postedThrough === null || iso > postedThrough)) postedThrough = iso;

    const hours = Number(r.hours) || 0;
    const value = Number(r.value) || 0;
    const entries = Number(r.entries) || 0;
    const status = String(r.status ?? '');
    const billable = r.billable !== false;

    // An entry with no client, category or work item cannot be attributed to
    // the requested grouping. It is aggregated into an exclusion rather than
    // bucketed under an empty key, which would read as a real group.
    if (r.group_id == null) {
      ungrouped.hours += hours;
      ungrouped.value += value;
      ungrouped.entries += entries;
      continue;
    }

    const key = String(r.group_id);
    const row = grouped.get(key) ?? {
      groupId: key,
      groupName: r.group_name == null ? '(unnamed)' : String(r.group_name),
      byStatus: {},
      totalHours: 0,
      totalValue: 0,
      unbilledValue: 0,
      unbilledHours: 0,
    };

    const bucket = row.byStatus[status] ?? { hours: 0, value: 0, entries: 0 };
    bucket.hours += hours;
    bucket.value += value;
    bucket.entries += entries;
    row.byStatus[status] = bucket;

    row.totalHours += hours;
    row.totalValue += value;
    if (billable && !BILLED_STATUSES.has(status) && !NON_CHARGEABLE_STATUSES.has(status)) {
      row.unbilledValue += value;
      row.unbilledHours += hours;
    }
    grouped.set(key, row);
  }

  const out = [...grouped.values()]
    .map((r) => ({
      ...r,
      totalHours: round2(r.totalHours),
      totalValue: round2(r.totalValue),
      unbilledValue: round2(r.unbilledValue),
      unbilledHours: round2(r.unbilledHours),
      byStatus: Object.fromEntries(
        Object.entries(r.byStatus).map(([k, v]) => [
          k, { hours: round2(v.hours), value: round2(v.value), entries: v.entries },
        ]),
      ),
    }))
    .sort((a, b) => b.unbilledValue - a.unbilledValue);

  const excluded: JobCostExclusion[] = [];
  if (ungrouped.entries > 0) {
    excluded.push({
      id: 'ungrouped',
      reason: `no_${filters.groupBy}`,
      detail: `${ungrouped.entries} time entries carry no ${filters.groupBy.replace('_', ' ')} and cannot be attributed to one.`,
      amount: round2(ungrouped.value),
    });
  }

  return {
    rows: out,
    rowsTotal: out.length,
    // No universeTotal. `out` are GROUPS produced by grouping the entries;
    // `excluded` is ONE bucket standing for N ungrouped ENTRIES. Adding them
    // counted a bucket of entries as though it were one more group, and the
    // sum was the arithmetic buildEnvelope then checked — so it could not
    // fail. The ungrouped bucket is a disclosure about entries that could not
    // be attributed, not a group withheld from a wider set of groups.
    excluded,
    totals: {
      hours: round2(out.reduce((s, r) => s + r.totalHours, 0)),
      value: round2(out.reduce((s, r) => s + r.totalValue, 0)),
      unbilledValue: round2(out.reduce((s, r) => s + r.unbilledValue, 0)),
    },
    postedThrough,
  };
}
