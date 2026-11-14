// Admin audit 1.13 / 2.2: the trial state, the days-left rounding and the counts
// are pure functions of the one trials query's rows, so they are pinned here with
// a fixed clock (the database round trip is in admin-trials-list.int.test.ts).
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { classifyTrial, summariseTrials, type TrialCompany } from '@/modules/admin/services/trialQueries';

const NOW = new Date('2026-11-14T10:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function raw(endsInMs: number, extra: Record<string, unknown> = {}) {
  return { id: 'c', name: 'Co', trial_ends_at: at(endsInMs), trial_started_at: at(-30 * DAY), status: 'active',
    user_count: '2', plan_name: null, is_paid: false, converted_at: null, ...extra };
}

describe('classifyTrial', () => {
  it('rounds days left up: 12 hours is 1 day, 3 days less a second is 3', () => {
    expect(classifyTrial(raw(12 * 3600_000), NOW).days_left).toBe(1);
    expect(classifyTrial(raw(3 * DAY - 1000), NOW).days_left).toBe(3);
    expect(classifyTrial(raw(30 * DAY), NOW).days_left).toBe(30);
  });

  it('a trial that ended an hour ago is expired with 0 days; ended 20 days ago is -20', () => {
    const justEnded = classifyTrial(raw(-3600_000), NOW);
    expect(justEnded).toMatchObject({ trial_state: 'expired', days_left: 0 });
    expect(Object.is(justEnded.days_left, -0)).toBe(false);
    expect(classifyTrial(raw(-20 * DAY), NOW)).toMatchObject({ trial_state: 'expired', days_left: -20 });
  });

  it('a paying company is converted whatever its trial_ends_at says, and company status is ignored', () => {
    const paid = classifyTrial(raw(-40 * DAY, { is_paid: true, converted_at: at(-3 * DAY), status: 'trial' }), NOW);
    expect(paid.trial_state).toBe('converted');
    expect(paid.converted_at).toBe(at(-3 * DAY).toISOString());
    expect(classifyTrial(raw(5 * DAY, { status: 'suspended' }), NOW).trial_state).toBe('active');
    expect(classifyTrial(raw(5 * DAY, { status: 'active' }), NOW).trial_state).toBe('active');
  });
});

describe('summariseTrials', () => {
  const trials: TrialCompany[] = [
    raw(3 * DAY), raw(12 * 3600_000), raw(20 * DAY),
    raw(-20 * DAY), raw(-5 * DAY, { status: 'suspended' }),
    raw(-40 * DAY, { is_paid: true, converted_at: at(-3 * DAY) }),
    raw(-90 * DAY, { is_paid: true, converted_at: at(-60 * DAY) }),
    raw(-10 * DAY, { is_paid: true, converted_at: null }),
  ].map((r) => classifyTrial(r, NOW));

  it('counts every state from the same rows', () => {
    expect(summariseTrials(trials, NOW)).toEqual({
      total_trials: 8,
      active_trials: 3,
      expiring_this_week: 2,
      expired_unpaid: 2,
      converted_this_month: 1,
      conversion_rate_percent: 12.5,
    });
  });

  it('an empty list is all zeros, not a division by zero', () => {
    expect(summariseTrials([], NOW)).toEqual({ total_trials: 0, active_trials: 0, expiring_this_week: 0,
      expired_unpaid: 0, converted_this_month: 0, conversion_rate_percent: 0 });
  });
});
