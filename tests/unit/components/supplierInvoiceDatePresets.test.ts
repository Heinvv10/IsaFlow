import { describe, it, expect } from 'vitest';
import { presetToRange } from '@/components/accounting/supplier-invoices/datePresets';

const TODAY = '2026-11-22';
describe('supplier bill list presets follow the company financial year', () => {
  it('March year (the old hard-coded behaviour stays the default)', () => {
    expect(presetToRange('this_fy', TODAY)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
    expect(presetToRange('last_fy', TODAY)).toEqual({ from: '2025-03-01', to: '2026-02-28' });
  });
  it('a company whose year starts in July', () => {
    expect(presetToRange('this_fy', TODAY, 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(presetToRange('last_fy', TODAY, 7)).toEqual({ from: '2025-07-01', to: '2026-06-30' });
  });
  it('months and last 30 days', () => {
    expect(presetToRange('this_month', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(presetToRange('last_month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetToRange('last_30_days', TODAY)).toEqual({ from: '2026-10-24', to: TODAY });
  });
  it('presets with no range of their own return nothing', () => {
    expect(presetToRange('custom', TODAY)).toEqual({});
    expect(presetToRange('all', TODAY)).toEqual({});
  });
});
