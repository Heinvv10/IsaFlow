import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { queryText, reportHref } from './reportReturnState';
import { localISODate } from '@/lib/dateUtils';

interface FiscalPeriod { id: string; periodName: string; startDate: string; endDate: string; status: string }

export function useTrialBalanceFilters() {
  const router = useRouter();
  const queryKey = reportHref('tb', router.query);
  const ready = router.isReady !== false;
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [periodsLoaded, setPeriodsLoaded] = useState(false);
  const [periodsError, setPeriodsError] = useState('');
  const [restoredKey, setRestoredKey] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [comparePeriodId, setComparePeriodId] = useState('');
  const [showMovement, setShowMovement] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const failure = 'Could not load the fiscal periods - try again';
    apiFetch('/api/accounting/fiscal-periods', { credentials: 'include' })
      .then(async r => { await assertOk(r, failure); return r.json(); })
      .then(res => { if (!cancelled) setPeriods(res.data?.items || res.data || []); })
      .catch((err: unknown) => { if (!cancelled) setPeriodsError(apiErrorMessage(err, failure)); })
      .finally(() => { if (!cancelled) setPeriodsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const query = Object.fromEntries(new URL(queryKey, 'https://report.invalid').searchParams);
    setCostCentreId(queryText(query, 'cost_centre_id'));
    setBusinessUnitId(queryText(query, 'business_unit_id'));
    setShowMovement(query.show_movement === 'true');
  }, [ready, queryKey]);

  useEffect(() => {
    if (!ready || !periodsLoaded) return;
    const query = Object.fromEntries(new URL(queryKey, 'https://report.invalid').searchParams);
    const today = localISODate();
    const requested = periods.find(p => p.id === query.fiscal_period_id);
    const dated = periods.find(p => p.startDate.slice(0, 10) === query.from && p.endDate.slice(0, 10) === query.to);
    const best = requested ?? dated ?? periods.find(p => p.status === 'open' && p.startDate.slice(0, 10) <= today && p.endDate.slice(0, 10) >= today)
      ?? periods.find(p => p.status === 'open') ?? periods[0];
    setSelectedPeriod(best?.id ?? '');
    setComparePeriodId(periods.some(p => p.id === query.compare_period_id && p.id !== best?.id) ? query.compare_period_id! : '');
    setRestoredKey(queryKey);
  }, [ready, periodsLoaded, periods, queryKey]);

  const returnTo = reportHref('tb', {
    fiscal_period_id: selectedPeriod, cost_centre_id: costCentreId,
    business_unit_id: businessUnitId,
    compare_period_id: comparePeriodId, show_movement: String(showMovement),
  });
  return { periods, periodsError, selectedPeriod, setSelectedPeriod, costCentreId, setCostCentreId,
    businessUnitId, setBusinessUnitId,
    comparePeriodId, setComparePeriodId, showMovement, setShowMovement, returnTo,
    filtersReady: ready && periodsLoaded && restoredKey === queryKey };
}
