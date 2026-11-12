/**
 * Loads one page of one VAT201 field's drill. The page belongs to the (field, period) it was chosen for, so a
 * change of either is page 1 in the same render and exactly one request goes out; an answer is shown only when
 * it is for the field, period and page now asked for.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, apiErrorMessage } from '@/lib/apiFetch';
import type { Vat201DrillResult } from '@/modules/accounting/services/reports/vat201FieldDrill';
import { fetchVat201Drill } from './returnDrillClient';

export interface DrillFailure { message: string; retryAfterSecs?: number }
interface Answer { key: string; page: number; result?: Vat201DrillResult; failure?: DrillFailure }

export function useVat201Drill(field: string | null, from: string, to: string) {
  const key = `${field}|${from}|${to}`;
  const [chosen, setChosen] = useState({ key, page: 1 });
  const page = chosen.key === key ? chosen.page : 1;
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (field === null) return undefined;
    const ctl = new AbortController();
    const mine = { key, page };
    fetchVat201Drill(field, from, to, page, ctl.signal)
      .then((result) => { if (!ctl.signal.aborted) setAnswer({ ...mine, result }); })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const retryAfterSecs = e instanceof ApiRequestError ? e.retryAfterSecs : undefined;
        setAnswer({ ...mine, failure: { message: apiErrorMessage(e, 'The lines behind this field could not be loaded.'), retryAfterSecs } });
      });
    return () => ctl.abort();
  }, [field, from, to, key, page, attempt]);

  const mine = answer && answer.key === key && answer.page === page ? answer : null;
  return {
    page,
    result: mine?.result ?? null,
    failure: mine?.failure ?? null,
    loading: field !== null && mine === null,
    /** Some page of this field and period has been answered: the pager stays (disabled) while the next one loads. */
    paged: answer !== null && answer.key === key,
    setPage: (p: number) => setChosen({ key, page: p }),
    retry: useCallback(() => { setAnswer(null); setAttempt((n) => n + 1); }, []),
  };
}
