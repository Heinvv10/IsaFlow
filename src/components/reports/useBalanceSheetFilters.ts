import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { queryText, reportHref } from './reportReturnState';

export function useBalanceSheetFilters() {
  const router = useRouter();
  const queryKey = reportHref('bs', router.query);
  const ready = router.isReady !== false;
  const [asAtDate, setAsAtDate] = useState('');
  const [costCentreId, setCostCentreId] = useState('');
  const [resolvedKey, setResolvedKey] = useState('');

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const query = Object.fromEntries(new URL(queryKey, 'https://report.invalid').searchParams);
    const date = queryText(query, 'as_at_date');
    const today = new Date().toISOString().slice(0, 10);
    setCostCentreId(queryText(query, 'cost_centre_id'));
    if (date) { setAsAtDate(date); setResolvedKey(queryKey); return; }
    apiFetch('/api/accounting/fiscal-periods?open_period=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        const end = json.data?.endDate as string | undefined;
        setAsAtDate(end && end < today ? end : today);
      })
      .catch(() => { if (!cancelled) setAsAtDate(today); })
      .finally(() => { if (!cancelled) setResolvedKey(queryKey); });
    return () => { cancelled = true; };
  }, [ready, queryKey]);

  return { asAtDate, setAsAtDate, costCentreId, setCostCentreId, queryKey,
    periodResolved: ready && resolvedKey === queryKey };
}
