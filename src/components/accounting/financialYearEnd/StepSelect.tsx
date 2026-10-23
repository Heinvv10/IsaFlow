import type { FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { INPUT_CLS } from '@/components/accounting/settings/settingsTypes';
import { localISODate } from '@/lib/dateUtils';
import { BTN_PRIMARY, CARD_CLS, MONTH_NAMES, fmtDay, monthOf, yearToChangeHeading } from './yearEndTypes';

interface Props {
  currentYear: FiscalYearRecord;
  month: number | null;
  onMonth: (m: number | null) => void;
  onNext: () => void;
  loading: boolean;
}

export function StepSelect({ currentYear, month, onMonth, onNext, loading }: Props) {
  const currentEnd = monthOf(currentYear.endDate);
  return (
    <section className={CARD_CLS} data-testid="step-select">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">1. {yearToChangeHeading(currentYear, localISODate())}</h2>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-6">
        <div><dt className="text-[var(--ff-text-secondary)]">Financial year</dt><dd data-testid="current-year-label" className="font-medium text-[var(--ff-text-primary)]">FY{currentYear.fiscalYear}</dd></div>
        <div><dt className="text-[var(--ff-text-secondary)]">Dates</dt><dd data-testid="current-year-range" className="font-medium text-[var(--ff-text-primary)]">{fmtDay(currentYear.startDate)} to {fmtDay(currentYear.endDate)}</dd></div>
        <div><dt className="text-[var(--ff-text-secondary)]">Months</dt><dd className="font-medium text-[var(--ff-text-primary)]">{currentYear.months}</dd></div>
        <div><dt className="text-[var(--ff-text-secondary)]">Type</dt><dd className="font-medium text-[var(--ff-text-primary)] capitalize">{currentYear.kind}</dd></div>
      </dl>
      <label htmlFor="new-year-end-month" className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">New financial year-end month</label>
      <select id="new-year-end-month" data-testid="new-year-end-month" className={`${INPUT_CLS} max-w-xs`}
        value={month ?? ''} onChange={e => onMonth(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">Select a month</option>
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={i + 1} disabled={i + 1 === currentEnd}>
            {name}{i + 1 === currentEnd ? ' (current year end)' : ''}
          </option>
        ))}
      </select>
      <div className="mt-6">
        <button type="button" data-testid="step-select-next" className={BTN_PRIMARY} disabled={month === null || loading} onClick={onNext}>
          {loading ? 'Checking...' : 'Preview change'}
        </button>
      </div>
    </section>
  );
}
