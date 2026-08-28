import { describe, it, expect, vi } from 'vitest';

// Stub out the JSX-heavy toast util so this .ts test file never has to
// transform src/utils/toast.tsx. We only test the pure buildApplyToast
// logic; the notify wiring is exercised by the e2e flow.
vi.mock('@/utils/toast', () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), promise: vi.fn() },
}));

import { buildApplyToast } from '@/components/accounting/bank-rules/applyToast';

describe('buildApplyToast', () => {
  it('plain success — applied with no skips', () => {
    const r = buildApplyToast({ applied: 50 });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('50 categorised');
  });

  it('zero applied with no skips → still success (a clean no-op)', () => {
    const r = buildApplyToast({ applied: 0 });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('0 categorised');
  });

  it('applied + closed-period skips → success tone (closed period is informational)', () => {
    const r = buildApplyToast({ applied: 100, autoPostSkippedClosedPeriod: 20 });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('100 categorised · 20 skipped (closed period)');
  });

  it('applied + bank-not-GL-linked → warn tone (silent drop)', () => {
    const r = buildApplyToast({ applied: 5, autoPostRulesSkippedNoBankGl: 3 });
    expect(r.kind).toBe('warn');
    expect(r.message).toBe('5 categorised · 3 auto-post rules skipped (bank not GL-linked)');
  });

  it('reports transactions raced by another request', () => {
    // The applyRules run left these alone rather than posting a second journal
    // over someone else's allocation. Silent, it reads as "rules aren't working".
    const r = buildApplyToast({ applied: 10, autoPostSkippedRaced: 2 });
    expect(r.message).toBe('10 categorised · 2 skipped — allocated by another request');
    expect(r.kind).toBe('success');
  });

  it('reports transactions whose row lock timed out', () => {
    const r = buildApplyToast({ applied: 10, autoPostSkippedLocked: 3 });
    expect(r.message).toBe('10 categorised · 3 skipped — locked by another request, retry');
  });

  it('reports a rule that hit the 500-transaction cap', () => {
    const r = buildApplyToast({ applied: 500, autoPostTruncatedRules: 1 });
    expect(r.message).toBe('500 categorised · 1 rule hit the 500-transaction cap — run again');
  });

  it('warns when nothing applied and everything raced', () => {
    // Zero applied with collateral skips is the misleading case the tone exists for.
    const r = buildApplyToast({ applied: 0, autoPostSkippedRaced: 4 });
    expect(r.kind).toBe('warn');
  });

  it('singular: 1 auto-post rule skipped → "rule" not "rules"', () => {
    const r = buildApplyToast({ applied: 5, autoPostRulesSkippedNoBankGl: 1 });
    expect(r.message).toBe('5 categorised · 1 auto-post rule skipped (bank not GL-linked)');
  });

  it('zero applied with closed-period skips → warn tone (no-op with collateral skips is misleading)', () => {
    const r = buildApplyToast({ applied: 0, autoPostSkippedClosedPeriod: 200 });
    expect(r.kind).toBe('warn');
  });

  it('applied + no-period skips → success tone with distinct suffix', () => {
    const r = buildApplyToast({ applied: 45, autoPostSkippedNoPeriod: 684 });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('45 categorised · 684 skipped (no fiscal period)');
  });

  it('zero applied with no-period skips → warn tone (silent drop, fiscal year missing)', () => {
    const r = buildApplyToast({ applied: 0, autoPostSkippedNoPeriod: 684 });
    expect(r.kind).toBe('warn');
  });

  it('closed and no-period skips coexist → both suffixes shown in stable order', () => {
    const r = buildApplyToast({
      applied: 12,
      autoPostSkippedClosedPeriod: 3,
      autoPostSkippedNoPeriod: 9,
    });
    expect(r.message).toBe('12 categorised · 3 skipped (closed period) · 9 skipped (no fiscal period)');
  });

  it('all four signals at once', () => {
    const r = buildApplyToast({
      applied: 729,
      autoPostSkippedClosedPeriod: 151,
      autoPostSkippedNoPeriod: 50,
      autoPostRulesSkippedNoBankGl: 0,
    });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('729 categorised · 151 skipped (closed period) · 50 skipped (no fiscal period)');
  });

  it('undefined inputs default to zero, no skip suffixes shown', () => {
    const r = buildApplyToast({});
    expect(r.kind).toBe('success');
    expect(r.message).toBe('0 categorised');
  });
});
