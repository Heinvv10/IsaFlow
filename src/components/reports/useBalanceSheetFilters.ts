import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { queryText, reportHref } from './reportReturnState';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';

export function useBalanceSheetFilters() {
  const router = useRouter();
  const queryKey = reportHref('bs', router.query);
  const ready = router.isReady !== false;
  const [asAtDate, setAsAtDate] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [resolvedKey, setResolvedKey] = useState('');
  // A failed period lookup leaves the date EMPTY (the report does not run) and says so: a balance sheet "as at"
  // a date nobody chose would be a wrong figure with no warning. Picking a date clears it.
  const [periodError, setPeriodError] = useState('');

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const query = Object.fromEntries(new URL(queryKey, 'https://report.invalid').searchParams);
    const date = queryText(query, 'as_at_date');
    const today = localISODate();
    setCostCentreId(queryText(query, 'cost_centre_id'));
    setBusinessUnitId(queryText(query, 'business_unit_id'));
    setPeriodError('');
    if (date) { setAsAtDate(date); setResolvedKey(queryKey); return; }
    apiFetch('/api/accounting/fiscal-periods?open_period=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the open period - try again'); return r.json(); })
      .then(json => {
        if (cancelled) return;
        const end = json.data?.endDate as string | undefined;
        setAsAtDate(end && end < today ? end : today);
      })
      .catch((err) => {
        log.warn('Balance sheet: the open period did not load', { error: err }, 'balance-sheet');
        if (cancelled) return;
        setAsAtDate('');
        const why = apiErrorMessage(err, 'Could not load the open period - try again');
        setPeriodError(`${why.replace(/[.!?\s]+$/, '')}. Pick the date to report as at.`);
      })
      .finally(() => { if (!cancelled) setResolvedKey(queryKey); });
    return () => { cancelled = true; };
  }, [ready, queryKey]);

  const pickDate = (d: string) => { setPeriodError(''); setAsAtDate(d); };
  return { asAtDate, setAsAtDate: pickDate, periodError, costCentreId, setCostCentreId,
    businessUnitId, setBusinessUnitId, queryKey,
    periodResolved: ready && resolvedKey === queryKey };
}
