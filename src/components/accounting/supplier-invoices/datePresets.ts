/**
 * Date-range presets for the supplier invoice list filter. The financial year comes from the company
 * (March when none is set, as before); the arithmetic lives in `@/lib/fiscalRangePresets`.
 */
import type { DatePreset } from './listTypes';
import { presetRange, type FyPresetKey } from '@/lib/fiscalRangePresets';
import { DEFAULT_FY_START_MONTH } from '@/components/ui/FiscalPresetBar';
import { todayInSast } from '@/lib/saDateParser';

const SHARED: Partial<Record<DatePreset, FyPresetKey>> = {
  this_month: 'this_month', last_month: 'last_month', last_30_days: 'last_30_days', this_fy: 'this_fy', last_fy: 'last_fy',
};

export function presetToRange(
  preset: DatePreset, today: string = todayInSast(), fyStartMonth: number = DEFAULT_FY_START_MONTH,
): { from?: string; to?: string } {
  const key = SHARED[preset];
  return key ? (presetRange(key, today, fyStartMonth) ?? {}) : {};
}
