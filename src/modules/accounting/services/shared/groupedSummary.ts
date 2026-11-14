/**
 * One grouped-totals query for the MCP list tools' `detail: "summary"` / `group_by` mode.
 *
 * The caller hands over `from`: a fragment that is `FROM <tables> WHERE <predicate>` and is the SAME fragment its row
 * query is built from. This module never writes a predicate, so a summary cannot count a row set the list does not
 * serve. The grand totals are the sum of the groups out of one statement (one snapshot), never a second query, so the
 * groups, the `other` remainder and the totals cannot disagree with each other.
 *
 * Every measure must be ADDITIVE (a COUNT or a SUM): the remainder past the group cap and the totals are sums of the
 * per-group values. `keyExpr`, `labelExpr`, `order` and the measure expressions are constants written in code, never
 * user input, which is what makes `sql.unsafe` safe here.
 */
import { sql, type DbRow } from '@/lib/neon';

/** The groups a summary returns; the rest are rolled into `other`. */
export const MAX_SUMMARY_GROUPS = 200;

type Fragment = ReturnType<typeof sql>;

export interface SummaryMeasure {
  name: string;
  /** An additive aggregate over the `from` fragment's rows, e.g. `COUNT(*)` or `COALESCE(SUM(x.amount), 0)`. */
  expr: string;
  kind: 'count' | 'money';
}

export interface SummaryDimension {
  /** SQL for the group key (text). A NULL key becomes the empty string: the group of rows with no value. */
  keyExpr: string;
  /** SQL for a human label, or null. Must be functionally dependent on the key. */
  labelExpr: string | null;
  /** ORDER BY over the grouped columns `k` and `m0..mN` (measure i is `m<i>`). Must end on a total order (`k`). */
  order: string;
}

export interface SummaryGroup {
  key: string;
  label: string | null;
  values: Record<string, number>;
}

export interface GroupedSummary {
  totals: Record<string, number>;
  groups: SummaryGroup[];
  /** Distinct groups, including those rolled into `other`. */
  groupsTotal: number;
  /** Everything past the cap, summed; null when every group is returned. */
  other: Record<string, number> | null;
}

function cents(v: number): number {
  return Math.round(v * 100) / 100;
}

function toValues(row: DbRow, measures: readonly SummaryMeasure[]): Record<string, number> {
  const out: Record<string, number> = {};
  measures.forEach((m, i) => {
    const n = Number(row[`m${i}`] ?? 0);
    out[m.name] = m.kind === 'count' ? n : cents(n);
  });
  return out;
}

const PART_GROUP = 1;
const PART_OTHER = 2;
const PART_TOTAL = 3;

/** `dimension` null = one group over everything (totals only). */
export async function runGroupedSummary(
  from: Fragment,
  measures: readonly SummaryMeasure[],
  dimension: SummaryDimension | null,
  cap: number = MAX_SUMMARY_GROUPS,
): Promise<GroupedSummary> {
  const keyExpr = dimension?.keyExpr ?? `'all'`;
  const labelExpr = dimension?.labelExpr ?? 'NULL::text';
  const order = dimension?.order ?? 'k';
  const perGroup = measures.map((m, i) => `${m.expr} AS m${i}`).join(', ');
  const sums = measures.map((_, i) => `COALESCE(SUM(m${i}), 0) AS m${i}`).join(', ');
  const cols = measures.map((_, i) => `m${i}`).join(', ');

  const rows = (await sql`
    WITH g AS (
      SELECT COALESCE((${sql.unsafe(keyExpr)})::text, '') AS k, MAX(${sql.unsafe(labelExpr)})::text AS lbl, ${sql.unsafe(perGroup)}
      ${from}
      GROUP BY 1
    ), ranked AS (
      SELECT g.*, ROW_NUMBER() OVER (ORDER BY ${sql.unsafe(order)}) AS rn FROM g
    )
    SELECT ${PART_GROUP}::int AS part, k, lbl, 1::bigint AS n, ${sql.unsafe(cols)} FROM ranked WHERE rn <= ${cap}::int
    UNION ALL
    SELECT ${PART_OTHER}::int, NULL, NULL, COUNT(*), ${sql.unsafe(sums)} FROM ranked WHERE rn > ${cap}::int
    UNION ALL
    SELECT ${PART_TOTAL}::int, NULL, NULL, COUNT(*), ${sql.unsafe(sums)} FROM ranked
  `) as DbRow[];

  const groups: SummaryGroup[] = rows
    .filter((r) => Number(r.part) === PART_GROUP)
    .map((r) => ({
      key: String(r.k),
      label: r.lbl === null || r.lbl === undefined ? null : String(r.lbl),
      values: toValues(r, measures),
    }));
  const other = rows.find((r) => Number(r.part) === PART_OTHER);
  const total = rows.find((r) => Number(r.part) === PART_TOTAL);
  return {
    totals: total ? toValues(total, measures) : toValues({}, measures),
    groups: dimension ? groups : [],
    groupsTotal: dimension ? Number(total?.n ?? 0) : 0,
    other: dimension && other && Number(other.n) > 0 ? toValues(other, measures) : null,
  };
}
