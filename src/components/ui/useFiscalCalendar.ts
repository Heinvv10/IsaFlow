/**
 * useFiscalCalendar — the company's fiscal periods, for the date fields that choose a POSTING date. One request per
 * company serves every field on the page (shared promise, 60 s). Until it has answered, or if it fails, nothing is
 * blocked or warned: the server judges every save anyway (ClosedFiscalPeriodError), so the field only ever adds an
 * earlier, clearer refusal. `check` is the pure rule in `@/lib/fiscalDateCheck`.
 */
import { useEffect, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { DEFAULT_FY_START_MONTH } from '@/lib/fiscalRangePresets';
import {
  checkPostingDate, currentFiscalYear, type PeriodLite, type PostingDateCheck,
} from '@/lib/fiscalDateCheck';

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<PeriodLite[] | null> }>();

/** For tests, and after a period is closed or reopened on the same page. */
export function resetFiscalCalendarCache(): void { cache.clear(); }

function load(companyId: string): Promise<PeriodLite[] | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = (async (): Promise<PeriodLite[] | null> => {
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      await assertOk(res, 'Could not load the fiscal periods');
      const body = await res.json() as { data?: PeriodLite[] };
      return Array.isArray(body.data) ? body.data : null;
    } catch (e) {
      log.warn('Fiscal periods did not load; date fields will not pre-check them', { error: e }, 'ui');
      cache.delete(companyId);
      return null;
    }
  })();
  cache.set(companyId, { at: Date.now(), promise });
  return promise;
}

/** useCompany throws outside a CompanyProvider (a bare test render); a date field can do without it. */
function useCompanyLite(): { id: string | null; fyStartMonth: number } {
  try {
    const c = useCompany().activeCompany;
    return { id: c?.id ?? null, fyStartMonth: c?.financialYearStart ?? DEFAULT_FY_START_MONTH };
  } catch (e) {
    if (e instanceof Error && /CompanyProvider/.test(e.message)) return { id: null, fyStartMonth: DEFAULT_FY_START_MONTH };
    throw e;
  }
}

export interface FiscalCalendar {
  /** The periods have loaded. */
  ready: boolean;
  check: (iso: string, today: string) => PostingDateCheck;
  fiscalYear: (today: string) => { start: string; end: string };
}

/** `enabled` false: no request is made (the periods stay unknown) but `fiscalYear` still answers from the company's start month. */
export function useFiscalCalendar(enabled = true): FiscalCalendar {
  const { id: companyId, fyStartMonth } = useCompanyLite();
  const id = enabled ? companyId : null;
  const [loaded, setLoaded] = useState<{ id: string; periods: PeriodLite[] } | null>(null);
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    void load(id).then((periods) => { if (live && periods) setLoaded({ id, periods }); });
    return () => { live = false; };
  }, [id]);
  const periods = loaded && loaded.id === id ? loaded.periods : null;
  return {
    ready: periods !== null,
    check: (iso, today) => checkPostingDate(iso, periods, today, fyStartMonth),
    fiscalYear: (today) => currentFiscalYear(periods, today, fyStartMonth),
  };
}
