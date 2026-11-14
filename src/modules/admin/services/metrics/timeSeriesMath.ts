/**
 * Revenue over time — pure, no database (admin audit 2.4, 2.10).
 *
 * Days and months are South African (SAST, UTC+2, no daylight saving), so the
 * "today" point is today in Johannesburg whatever the server's clock zone.
 */

import type { CohortRetentionRow, MrrTrendPoint } from '../../types/admin-billing.types';
import { percentOrNull, revenueAt, type SubscriptionFact } from './revenueMath';

const SAST_OFFSET_MS = 2 * 3_600_000;
const DAY_MS = 86_400_000;

/** The SAST calendar date (YYYY-MM-DD) of instant `t`. */
export function sastDate(t: Date): string {
  return new Date(t.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant SAST month (year, month0 + offset) begins. */
function sastMonthStart(year: number, month0: number, offset = 0): Date {
  return new Date(Date.UTC(year, month0 + offset, 1) - SAST_OFFSET_MS);
}

function sastYearMonth(t: Date): { year: number; month0: number } {
  const shifted = new Date(t.getTime() + SAST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month0: shifted.getUTCMonth() };
}

/** The instant the SAST month `offset` months from now's month begins (0 = this month, -1 = last month). */
export function sastMonthStartFrom(now: Date, offset: number): Date {
  const { year, month0 } = sastYearMonth(now);
  return sastMonthStart(year, month0, offset);
}

const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b);

/**
 * MRR at the end of each of the last `days` SAST days; today's point is MRR
 * now, so it equals the headline MRR. History follows `inMrrAt`: a subscription
 * cancelled on the 20th still counts on the days before it.
 */
export function mrrTrend(facts: readonly SubscriptionFact[], now: Date, days = 30): MrrTrendPoint[] {
  const points: MrrTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = sastDate(new Date(now.getTime() - i * DAY_MS));
    const dayEnd = new Date(Date.parse(`${date}T00:00:00Z`) - SAST_OFFSET_MS + DAY_MS - 1);
    const r = revenueAt(facts, earlier(dayEnd, now));
    points.push({ date, mrr_cents: r.mrr_cents, company_count: r.paying_companies });
  }
  return points;
}

export interface CohortCompany {
  id: string;
  created_at: Date;
  trial_ends_at: Date | null;
}

type CohortSub = Pick<SubscriptionFact, 'company_id' | 'status' | 'created_at' | 'cancelled_at'>;

/**
 * Did the company have a live subscription at `at`? Created by then, and: a
 * cancelled one only before its cancelled_at; a trial one only while the
 * company's trial had not ended; active, past_due and paused ones count.
 */
function liveAt(subs: readonly CohortSub[], trialEndsAt: Date | null, at: Date): boolean {
  const t = at.getTime();
  return subs.some((s) => {
    if (s.created_at.getTime() > t) return false;
    if (s.status === 'cancelled') return s.cancelled_at !== null && s.cancelled_at.getTime() > t;
    if (s.status === 'trial') return trialEndsAt === null || trialEndsAt.getTime() > t;
    return true;
  });
}

/**
 * Signup cohorts of the last `months` SAST months (the current one included),
 * oldest first; only months in which a company signed up. Mn is measured at
 * the end of the Nth month after the signup month (M0: the signup month
 * itself), and is null while that month has not ended.
 */
export function cohortRetention(
  companies: readonly CohortCompany[],
  subs: readonly CohortSub[],
  now: Date,
  months = 6,
): CohortRetentionRow[] {
  const { year, month0 } = sastYearMonth(now);
  const byCompany = new Map<string, CohortSub[]>();
  for (const s of subs) byCompany.set(s.company_id, [...(byCompany.get(s.company_id) ?? []), s]);

  const rows: CohortRetentionRow[] = [];
  for (let k = -(months - 1); k <= 0; k++) {
    const start = sastMonthStart(year, month0, k);
    const end = sastMonthStart(year, month0, k + 1);
    const cohort = companies.filter((c) => c.created_at >= start && c.created_at < end);
    if (cohort.length === 0) continue;
    const pct = (n: number): number | null => {
      const at = new Date(sastMonthStart(year, month0, k + n + 1).getTime() - 1);
      if (at.getTime() > now.getTime()) return null;
      const kept = cohort.filter((c) => liveAt(byCompany.get(c.id) ?? [], c.trial_ends_at, at)).length;
      return percentOrNull(kept, cohort.length, 1);
    };
    rows.push({
      cohort_month: sastDate(start),
      cohort_size: cohort.length,
      m0_pct: pct(0),
      m1_pct: pct(1),
      m2_pct: pct(2),
      m3_pct: pct(3),
    });
  }
  return rows;
}
