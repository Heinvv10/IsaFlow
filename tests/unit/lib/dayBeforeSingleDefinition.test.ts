/**
 * One `dayBefore` (PR-B review r1 L3): it lives in `lib/dateUtils` (browser-safe,
 * local-calendar arithmetic) and `gl/fiscalYearRegistry` re-exports that same
 * function, so the registry's callers and the browser-bundled tracking modules
 * cannot drift apart.
 */
import { describe, expect, it } from 'vitest';
import * as dateUtils from '@/lib/dateUtils';
import * as registry from '@/modules/accounting/services/gl/fiscalYearRegistry';

describe('dayBefore', () => {
  it('is calendar arithmetic across month, year and leap-day boundaries', () => {
    expect(dateUtils.dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dateUtils.dayBefore('2028-03-01')).toBe('2028-02-29');
    expect(dateUtils.dayBefore('2026-01-01')).toBe('2025-12-31');
    expect(dateUtils.dayBefore('2026-10-15')).toBe('2026-10-14');
  });

  it("the registry's dayBefore IS the dateUtils one", () => {
    expect(registry.dayBefore).toBe(dateUtils.dayBefore);
  });
});
