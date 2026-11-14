/**
 * MRR trend and cohort retention of the admin metrics module (audit 2.4, 2.10).
 * SAST is UTC+2: 2026-11-14T22:30Z is already 15 November in Johannesburg.
 */
import { describe, expect, it } from 'vitest';
import { churnTrend, cohortRetention, mrrTrend, sastDate } from '@/modules/admin/services/metrics/timeSeriesMath';
import type { SubscriptionFact } from '@/modules/admin/services/metrics/revenueMath';

function fact(company_id: string, annual_units: number, created: string, extra: Partial<SubscriptionFact> = {}): SubscriptionFact {
  const status = extra.status ?? 'active';
  return {
    id: `${company_id}-${created}`, company_id, plan_id: 'p', plan_name: 'P', billing_cycle: 'monthly', status,
    created_at: new Date(created), mrr_from: new Date(created), cancelled_at: null, annual_units,
    company_excluded: false, counts_toward_mrr: status === 'active', ...extra,
  };
}

describe('sastDate', () => {
  it('uses the Johannesburg calendar day', () => {
    expect(sastDate(new Date('2026-11-14T21:59:59Z'))).toBe('2026-11-14');
    expect(sastDate(new Date('2026-11-14T22:00:00Z'))).toBe('2026-11-15');
  });
});

describe('mrrTrend', () => {
  const now = new Date('2026-11-14T22:30:00Z'); // 00:30 on 15 Nov SAST
  const facts = [
    fact('a', 1_200_000, '2026-10-01T00:00:00Z'),                                    // 1 000, all along
    fact('b', 2_400_000, '2026-11-10T08:00:00Z', {                                    // 2 000 from 10 Nov
      status: 'cancelled', cancelled_at: new Date('2026-11-13T09:00:00Z'), counts_toward_mrr: false }), // gone 13 Nov
    fact('c', 3_600_000, '2026-11-14T21:00:00Z'),                                    // 3 000, 23:00 on 14 Nov SAST
    fact('d', 9_600_000, '2026-10-01T00:00:00Z', { status: 'trial', counts_toward_mrr: false }),
  ];
  const trend = mrrTrend(facts, now, 7);
  it('labels SAST days and ends today', () => {
    expect(trend.map((p) => p.date)).toEqual([
      '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15',
    ]);
  });
  it('keeps a since-cancelled subscription on the days before its cancellation; never a trial', () => {
    expect(trend.map((p) => p.mrr_cents)).toEqual([1_000, 3_000, 3_000, 3_000, 1_000, 4_000, 4_000]);
    expect(trend.map((p) => p.company_count)).toEqual([1, 2, 2, 2, 1, 2, 2]);
  });
  it("today's point is MRR now", () => {
    // a + c (b cancelled, d trial): (1 200 000 + 3 600 000) / 1200 = 4 000
    expect(trend.at(-1)?.mrr_cents).toBe(4_000);
  });
});

describe('mrrTrend: a converted trial (review H1)', () => {
  it('counts from its conversion, not from the trial start the row was created at', () => {
    const now = new Date('2026-11-14T22:30:00Z');
    // The trial row was created on 1 Nov and converted (same row) on 12 Nov 10:00 SAST.
    const converted = fact('t', 1_200_000, '2026-11-01T08:00:00Z', { mrr_from: new Date('2026-11-12T08:00:00Z') });
    expect(mrrTrend([converted], now, 7).map((p) => p.mrr_cents)).toEqual([0, 0, 0, 1_000, 1_000, 1_000, 1_000]);
  });
});

describe('churnTrend (review M1)', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const aug = '2026-08-01T00:00:00Z'; // 02:00 SAST on 1 Aug: after the August base was taken
  const rows = churnTrend([
    fact('a', 1_200_000, aug),                                                                   // pays throughout
    fact('b', 1_200_000, aug, { status: 'cancelled', cancelled_at: new Date('2026-10-10T00:00:00Z') }), // churns in Oct
    fact('c', 1_200_000, '2026-10-05T00:00:00Z', { status: 'cancelled', cancelled_at: new Date('2026-10-20T00:00:00Z') }), // new in Oct: not in its base
    fact('d', 1_200_000, aug, { status: 'cancelled', cancelled_at: new Date('2026-10-15T00:00:00Z'), company_excluded: true }), // deleted/internal
    fact('e', 1_200_000, aug, { status: 'trial' }),                                              // never paying
    fact('r', 0, aug),                                                       // active on a R0 plan: not a paying company (L3)
    fact('f', 1_200_000, aug, { status: 'cancelled', cancelled_at: new Date('2026-11-20T00:00:00Z') }), // dated after now (L3)
  ], now, 4);
  it('per SAST month: paying companies at the start that pay nothing by the end; an empty base is null', () => {
    // Base: a, b, f (r pays R0; c joined in Oct; d excluded; e a trial). Oct: b churns, 1 / 3.
    // Nov: base a, f; f's cancellation is dated 20 Nov, after now (14 Nov): not churn yet.
    expect(rows).toEqual([
      { month: '2026-08-01', churned_companies: 0, churn_rate_pct: null },
      { month: '2026-09-01', churned_companies: 0, churn_rate_pct: 0 },
      { month: '2026-10-01', churned_companies: 1, churn_rate_pct: 33.33 },
      { month: '2026-11-01', churned_companies: 0, churn_rate_pct: 0 },
    ]);
  });
});

describe('cohortRetention', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  const companies = [
    { id: 'sep1', created_at: new Date('2026-09-05T10:00:00Z'), trial_ends_at: new Date('2026-10-05T10:00:00Z') },
    { id: 'sep2', created_at: new Date('2026-09-20T10:00:00Z'), trial_ends_at: new Date('2026-10-20T10:00:00Z') },
    { id: 'oct1', created_at: new Date('2026-10-15T10:00:00Z'), trial_ends_at: null },
    { id: 'nov1', created_at: new Date('2026-11-02T10:00:00Z'), trial_ends_at: null },
    { id: 'old', created_at: new Date('2026-04-30T10:00:00Z'), trial_ends_at: null }, // outside 6 months
  ];
  const subs = [
    // sep1: trial from signup, converted to paid on 1 Oct (trial sub cancelled then).
    fact('sep1', 0, '2026-09-05T10:00:00Z', { status: 'cancelled', cancelled_at: new Date('2026-10-01T09:00:00Z') }),
    fact('sep1', 3_588_000, '2026-10-01T09:00:00Z'),
    // sep2: a trial that ran out on 20 Oct and was never converted (status stays 'trial').
    fact('sep2', 0, '2026-09-20T10:00:00Z', { status: 'trial' }),
    // oct1: signed up 15 Oct (mid-month) and paid the same day.
    fact('oct1', 3_588_000, '2026-10-15T10:00:00Z'),
    fact('nov1', 3_588_000, '2026-11-02T10:00:00Z'),
  ];
  const rows = cohortRetention(companies, subs, now);
  it('one row per signup month in the window, oldest first', () => {
    expect(rows.map((r) => [r.cohort_month, r.cohort_size])).toEqual([['2026-09-01', 2], ['2026-10-01', 1], ['2026-11-01', 1]]);
  });
  it('M0 counts a mid-month signup; an expired trial stops counting; months not yet ended are null', () => {
    // Sep: end Sep both live (100); end Oct sep1 paid, sep2 trial ended 20 Oct (50); end Nov, end Dec: future.
    expect(rows[0]).toMatchObject({ m0_pct: 100, m1_pct: 50, m2_pct: null, m3_pct: null });
    // Oct: end Oct oct1 live (100); the rest future.
    expect(rows[1]).toMatchObject({ m0_pct: 100, m1_pct: null, m2_pct: null, m3_pct: null });
    // Nov: November has not ended.
    expect(rows[2]).toMatchObject({ m0_pct: null, m1_pct: null, m2_pct: null, m3_pct: null });
  });
  it('a later month can never exceed what the subscriptions allow: cancelled before month end is lost', () => {
    const r = cohortRetention(
      [{ id: 'x', created_at: new Date('2026-09-10T00:00:00Z'), trial_ends_at: null }],
      [fact('x', 1, '2026-09-10T00:00:00Z', { status: 'cancelled', cancelled_at: new Date('2026-09-25T00:00:00Z') })],
      now,
    );
    expect(r[0]).toMatchObject({ m0_pct: 0, m1_pct: 0 });
  });
});
