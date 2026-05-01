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

  it('singular: 1 auto-post rule skipped → "rule" not "rules"', () => {
    const r = buildApplyToast({ applied: 5, autoPostRulesSkippedNoBankGl: 1 });
    expect(r.message).toBe('5 categorised · 1 auto-post rule skipped (bank not GL-linked)');
  });

  it('zero applied with closed-period skips → warn tone (no-op with collateral skips is misleading)', () => {
    const r = buildApplyToast({ applied: 0, autoPostSkippedClosedPeriod: 200 });
    expect(r.kind).toBe('warn');
  });

  it('all three signals at once', () => {
    const r = buildApplyToast({ applied: 729, autoPostSkippedClosedPeriod: 151, autoPostRulesSkippedNoBankGl: 0 });
    expect(r.kind).toBe('success');
    expect(r.message).toBe('729 categorised · 151 skipped (closed period)');
  });

  it('undefined inputs default to zero, no skip suffixes shown', () => {
    const r = buildApplyToast({});
    expect(r.kind).toBe('success');
    expect(r.message).toBe('0 categorised');
  });
});
