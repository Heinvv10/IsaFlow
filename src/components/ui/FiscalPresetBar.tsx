/**
 * FiscalPresetBar — the preset pills of DateRangeField on their own, for a page that already owns its From/To
 * fields and their gating (useDateGate, URL deep links). `onPick` hands the page the range to set; the page
 * puts it in its own state and resets its gates. Pills follow the company financial year (see DateRangeField).
 */
import { cn } from '@/utils/cn';
import { useCompany } from '@/contexts/CompanyContext';
import { todayInSast } from '@/lib/saDateParser';
import {
  FY_PRESET_KEYS, FY_PRESET_LABELS, matchPreset, presetRange, type FyPresetKey, type IsoRange,
} from '@/lib/fiscalRangePresets';

export const DEFAULT_FY_START_MONTH = 3;
const PILL = 'min-h-8 rounded-full border px-3 py-1 text-xs transition-colors max-lg:min-h-11';
const ON = 'border-brand-600 bg-brand-600 text-white hover:bg-brand-700';
const OFF = 'border-[var(--ff-border-primary)] bg-transparent text-ink-muted hover:border-slate-500';

/** The active company's financial-year start month (1-12), March when none is set. */
export function useFyStartMonth(explicit?: number): number {
  const fromCompany = useCompanyFyStart();
  return explicit ?? fromCompany ?? DEFAULT_FY_START_MONTH;
}

/** useCompany throws outside a CompanyProvider (a bare page test); a range picker can do without it, so say so and carry on. */
function useCompanyFyStart(): number | undefined {
  try {
    return useCompany().activeCompany?.financialYearStart;
  } catch (e) {
    if (e instanceof Error && /CompanyProvider/.test(e.message)) return undefined;
    throw e;
  }
}

export interface FiscalPresetBarProps {
  /** Names the group for assistive tech, e.g. "Period". */
  label: string;
  value: { from: string | null; to: string | null };
  onPick: (range: IsoRange) => void;
  /** Pressing Custom (the dates are left alone). */
  onCustom?: () => void;
  /** True once the user has typed a date: Custom stays pressed even if the dates happen to equal a preset. */
  custom?: boolean;
  fyStartMonth?: number;
  presets?: FyPresetKey[];
  getToday?: () => Date;
  disabled?: boolean;
  className?: string;
}

export function FiscalPresetBar({
  label, value, onPick, onCustom, custom = false, fyStartMonth, presets = FY_PRESET_KEYS, getToday, disabled, className,
}: FiscalPresetBarProps) {
  const fy = useFyStartMonth(fyStartMonth);
  const today = todayInSast((getToday ?? (() => new Date()))());
  const pressed = custom ? 'custom' : matchPreset(value, today, fy);
  const pick = (key: FyPresetKey) => {
    if (key === 'custom') { onCustom?.(); return; }
    const r = presetRange(key, today, fy);
    if (r) onPick(r);
  };
  return (
    <div role="group" aria-label={`${label} presets`} className={cn('flex flex-wrap gap-1.5', className)}>
      {presets.map(key => (
        <button key={key} type="button" disabled={disabled} aria-pressed={pressed === key}
          onClick={() => pick(key)} className={cn(PILL, pressed === key ? ON : OFF)}>
          {FY_PRESET_LABELS[key]}
        </button>
      ))}
    </div>
  );
}
