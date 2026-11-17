/**
 * The period of a new weekly or fortnightly run (wave 6 FQd): the periods of the company's pay week from 13 weeks back
 * to 4 ahead (payrollPayWeek.periodsAround, the same rule the route judges), each with its pay date, and the pay-week
 * card beneath. A fortnight needs the fortnight start first; the list says so until it is set.
 */
import { useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { useCompany } from '@/contexts/CompanyContext';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import {
  formatPayDate, formatPeriodRange, periodsAround, type PeriodFrequency,
} from '@/modules/accounting/services/payroll/payrollPayWeek';
import { PayWeekSettingsCard, payWeekOf, type PayWeekState } from './PayWeekSettingsCard';

const LOAD_FAILED = 'Could not load the pay week';

/** Today, as the browser sees it: only which periods are offered depends on it. */
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());

export function RunPeriodPicker({ frequency, value, onChange }: {
  frequency: PeriodFrequency; value: string | null; onChange: (periodStart: string | null) => void;
}) {
  const { companyRole } = useCompany();
  const canEdit = companyRole === 'owner' || companyRole === 'admin';
  const [state, setState] = useState<PayWeekState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    apiJson('/api/payroll/settings/pay-week', undefined, LOAD_FAILED)
      .then((d) => { if (live) setState(payWeekOf(d)); })
      .catch((err: unknown) => { if (live) setError(apiErrorMessage(err, LOAD_FAILED)); });
    return () => { live = false; };
  }, []);

  const periods = useMemo(() => (state ? periodsAround(frequency, state, today()) : []), [frequency, state]);
  const options = periods.map((p) => ({
    value: p.periodStart, label: `${formatPeriodRange(p.periodStart, p.periodEnd)} (paid ${formatPayDate(p.payDate)})`,
  }));
  // A period from another frequency or an older pay week is not one of these: clear it.
  useEffect(() => {
    if (value && state && !periods.some((p) => p.periodStart === value)) onChange(null);
  }, [periods, value, state, onChange]);

  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>;
  if (!state) return <p className="text-sm text-[var(--ff-text-secondary)]">Loading the pay week...</p>;
  return (
    <>
      <Select label="Period" required options={options} value={value} onChange={onChange}
        placeholder={options.length ? 'Choose the period' : 'Set the fortnight start below first'}
        disabled={options.length === 0} />
      <PayWeekSettingsCard key={JSON.stringify(state)} state={state} canEdit={canEdit} onSaved={setState} />
    </>
  );
}
