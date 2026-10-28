/**
 * The query string of the tracking routes (budgets P3 spec §4), validated by
 * zod before the engine runs: a malformed value is a 400, never a guess.
 *
 *   period=month|quarter|ytd|fy|custom (default ytd)
 *   month=YYYY-MM | fiscal_year=<label> [&quarter=1..5] | from=YYYY-MM&to=YYYY-MM
 *   version_id, cc1_id, cc2_id, bu_id: uuid    group_by=cc1|cc2|bu (bullets)
 *
 * An empty value is absent. A repeated parameter (an array) is refused. Years
 * lie in 1900-2200, and a parameter of another period (`fiscal_year` with
 * `period=month`, `quarter` without `period=quarter`, `from`/`to` outside
 * custom) is refused by the window's own rule (`assertParamsApply`). Any
 * other key is ignored, `company_id` included: the company is the
 * authenticated request's, never the query's. The window rules (quarter past
 * the year, from > to, > 24 months) are `trackingWindow`'s, so they hold for
 * every caller, not only this one.
 */
import { z } from 'zod';
import { UUID } from '@/lib/schemas/common';
import { TRACKING_PERIODS, TrackingError, type TrackingParams, type TrackingPeriod } from './trackingTypes';
import { assertParamsApply, YEAR_MAX, YEAR_MIN } from './trackingWindow';

const blankIsAbsent = (v: unknown) => (v === '' ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankIsAbsent, schema.optional());
const inRange = (year: number) => year >= YEAR_MIN && year <= YEAR_MAX;
const RANGE = `Year must lie in ${YEAR_MIN}-${YEAR_MAX}`;
const MonthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month, YYYY-MM')
  .refine((v) => inRange(Number(v.slice(0, 4))), RANGE);

const shape = {
  period: opt(z.enum(TRACKING_PERIODS as [TrackingPeriod, ...TrackingPeriod[]])),
  month: opt(MonthKey),
  fiscal_year: opt(z.string().regex(/^\d{4}$/, 'Must be a financial-year label such as 2027').refine((v) => inRange(Number(v)), RANGE)),
  quarter: opt(z.string().regex(/^[1-5]$/, 'Must be 1 to 5')),
  from: opt(MonthKey),
  to: opt(MonthKey),
  version_id: opt(UUID),
  cc1_id: opt(UUID),
  cc2_id: opt(UUID),
  bu_id: opt(UUID),
  group_by: opt(z.enum(['cc1', 'cc2', 'bu'])),
};

export const TrackingQuerySchema = z.object(shape);

export type TrackingQueryResult =
  | { ok: true; params: TrackingParams }
  | { ok: false; message: string; fieldErrors: Record<string, string[] | undefined> };

export function parseTrackingQuery(query: unknown): TrackingQueryResult {
  const parsed = TrackingQuerySchema.safeParse(query);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const first = Object.entries(fieldErrors).find(([, v]) => v && v.length > 0);
    return { ok: false, message: first ? `${first[0]}: ${first[1]![0]}` : 'Invalid query', fieldErrors };
  }
  const q = parsed.data;
  const params: TrackingParams = { period: q.period ?? 'ytd' };
  if (q.month !== undefined) params.month = q.month;
  if (q.fiscal_year !== undefined) params.fiscalYear = Number(q.fiscal_year);
  if (q.quarter !== undefined) params.quarter = Number(q.quarter);
  if (q.from !== undefined) params.from = q.from;
  if (q.to !== undefined) params.to = q.to;
  if (q.version_id !== undefined) params.versionId = q.version_id;
  if (q.cc1_id !== undefined) params.cc1Id = q.cc1_id;
  if (q.cc2_id !== undefined) params.cc2Id = q.cc2_id;
  if (q.bu_id !== undefined) params.buId = q.bu_id;
  if (q.group_by !== undefined) params.groupBy = q.group_by;
  // The window's own rule, applied before any query: a parameter that does not apply to the period is a 400.
  try {
    assertParamsApply(params);
  } catch (err) {
    if (err instanceof TrackingError) return { ok: false, message: err.message, fieldErrors: {} };
    throw err;
  }
  return { ok: true, params };
}
