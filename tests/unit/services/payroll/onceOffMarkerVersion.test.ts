/**
 * Review M of f37f0f15a6: the version whose lines first carry the breakdown's onceOff marker is defined beside its
 * entry in payrollCalculationVersion.ts, never a literal that drifts on a rebase. Pinned to the entry whose note
 * introduced the marker.
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { ONCE_OFF_MARKER_VERSION, PAYROLL_CALCULATION_VERSION } from '@/modules/accounting/services/payroll/payrollCalculationVersion';

describe('ONCE_OFF_MARKER_VERSION', () => {
  it('is the version whose note introduced the onceOff marker, and no later than the current version', () => {
    const notes = readFileSync('src/modules/accounting/services/payroll/payrollCalculationVersion.ts', 'utf8');
    const entry = notes.split(/\n \* (?=\d+: )/).find((e) => /onceOff/.test(e));
    expect(entry, 'a version note names the onceOff marker').toBeDefined();
    expect(Number(/^(\d+):/.exec(entry!)![1])).toBe(ONCE_OFF_MARKER_VERSION);
    expect(ONCE_OFF_MARKER_VERSION).toBeLessThanOrEqual(PAYROLL_CALCULATION_VERSION);
  });
});
