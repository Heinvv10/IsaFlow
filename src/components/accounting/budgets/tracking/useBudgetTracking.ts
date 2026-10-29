/**
 * The Budget vs Actual page's state: the controls (read from and written to the
 * page URL, so Back and a shared link reopen the same report), the tracking
 * report they load, and the pickers' lists (versions of FY*, cost centres,
 * business units). The report is the engine's
 * (`/api/accounting/reports-budget-tracking`); nothing here computes a figure,
 * and whether the window spans two years is the response's (`versionsByFy`).
 *
 * A response that arrives after a newer request is dropped, so a slow
 * earlier window never overwrites a later one. A failed load clears the
 * report, so the export buttons cannot export the previous window; `retry`
 * re-sends the same request (a 429 says how long to wait). Control changes
 * are coalesced: a request goes out once they have been still for
 * COALESCE_MS, so a run of clicks costs the company's report limit one
 * request. Controls the client can judge wrong (an inverted custom range)
 * send nothing and say why (`problem`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { ApiRequestError, apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { BudgetTrackingReport, TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import {
  controlsFromQuery, controlsProblem, controlsToQuery, DEFAULT_CONTROLS, quarterHolding, trackingSearch, withPatch,
  type TrackingControls,
} from './trackingControls';

export interface DimensionOption { id: string; code: string; name: string; ccType?: string }

export const BVA_PATH = '/accounting/reports/budget-vs-actual';
const LOAD_FAILED = 'Could not load the budget report - try again';

/**
 * A refusal says how long to wait. The route's own cap sends Retry-After; the shared per-company
 * reports limiter in withAuth (60 a minute) does not, so its 429 reads "about a minute": adding the
 * header there is not additive (every test that mocks @/lib/rateLimit would need chargeRateLimit).
 */
function loadError(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 429) {
    const s = err.retryAfterSecs;
    const wait = s === undefined ? 'about a minute'
      : s < 60 ? `${s} second${s === 1 ? '' : 's'}` : `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? '' : 's'}`;
    return `Too many report requests: try again in ${wait}.`;
  }
  return apiErrorMessage(err, LOAD_FAILED);
}
const COALESCE_MS = 350;

async function listOf(url: string, failure: string): Promise<DimensionOption[]> {
  const res = await apiFetch(url, { credentials: 'include' });
  await assertOk(res, failure);
  const json = await res.json();
  const items = json.data?.items ?? json.data ?? [];
  return Array.isArray(items) ? items : [];
}

export function useBudgetTracking() {
  const router = useRouter();
  const [controls, setControls] = useState<TrackingControls>(DEFAULT_CONTROLS);
  // The URL is read once, when the router has it; nothing loads before that.
  const [hydrated, setHydrated] = useState(false);
  const [report, setReport] = useState<BudgetTrackingReport | null>(null);
  const [years, setYears] = useState<ReportYearOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [versions, setVersions] = useState<BudgetVersion[]>([]);
  const [versionsError, setVersionsError] = useState('');
  const [centres, setCentres] = useState<DimensionOption[]>([]);
  const [units, setUnits] = useState<DimensionOption[]>([]);
  const [refError, setRefError] = useState<Record<string, string>>({});
  const [today] = useState(() => localISODate().slice(0, 7));
  const latest = useRef(0);
  // The query actually requested (after coalescing) and a counter Retry bumps to send it again.
  const [requested, setRequested] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const query = trackingSearch(controls, { bullets: true }).toString();
  const exportQuery = trackingSearch(controls, { bullets: false }).toString();
  const urlQuery = new URLSearchParams(controlsToQuery(controls)).toString();
  const problem = controlsProblem(controls);

  useEffect(() => {
    if (hydrated || !router.isReady) return;
    setControls(controlsFromQuery(router.query));
    setHydrated(true);
  }, [hydrated, router.isReady, router.query]);

  useEffect(() => {
    if (!hydrated) return;
    void router.replace(`${BVA_PATH}?${urlQuery}`, undefined, { shallow: true, scroll: false });
    // The router object changes identity per render; the URL follows the controls only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, urlQuery]);

  // The first request goes at once; later control changes wait until they have been still.
  useEffect(() => {
    if (!hydrated) return;
    if (problem) {
      latest.current += 1;
      setRequested(null);
      setReport(null);
      setIsLoading(false);
      return;
    }
    if (requested === null && latest.current === 0) { setRequested(query); return; }
    const timer = setTimeout(() => setRequested(query), COALESCE_MS);
    return () => clearTimeout(timer);
    // `requested` is read only to tell the first request apart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, query, problem]);

  useEffect(() => {
    if (requested === null) return;
    const request = ++latest.current;
    setIsLoading(true);
    setError('');
    apiJson(`/api/accounting/reports-budget-tracking?${requested}`, undefined, LOAD_FAILED)
      .then((data) => {
        if (request !== latest.current) return;
        setReport(data);
        setYears(data.years);
      })
      .catch((err) => {
        if (request !== latest.current) return;
        setReport(null);
        setError(loadError(err));
      })
      .finally(() => { if (request === latest.current) setIsLoading(false); });
  }, [requested, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  // The version picker lists FY*'s versions, primary first.
  const fy = report?.window.fiscalYear ?? null;
  useEffect(() => {
    if (fy === null) return;
    let cancelled = false;
    apiJson(`/api/accounting/budget-versions?fiscalYear=${fy}`, undefined, 'Could not load the budget versions')
      .then((data) => {
        if (cancelled) return;
        const items = 'items' in data ? data.items : [];
        setVersions([...items].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name)));
        setVersionsError('');
      })
      .catch((err) => {
        if (cancelled) return;
        setVersions([]);
        setVersionsError(apiErrorMessage(err, 'Could not load the budget versions'));
        log.warn('Failed to load budget versions', { err }, 'budget-vs-actual');
      });
    return () => { cancelled = true; };
  }, [fy]);

  useEffect(() => {
    const fail = (key: string, message: string) => (err: unknown) => {
      log.warn(message, { err }, 'budget-vs-actual');
      setRefError((p) => ({ ...p, [key]: apiErrorMessage(err, `${message} - try again`) }));
    };
    listOf('/api/accounting/cost-centres?active_only=true', 'Could not load the cost centres')
      .then(setCentres).catch(fail('cc', 'Could not load the cost centres'));
    listOf('/api/accounting/business-units?active=true', 'Could not load the business units')
      .then(setUnits).catch(fail('bu', 'Could not load the business units'));
  }, []);

  const update = useCallback((patch: Partial<TrackingControls>) => setControls((c) => withPatch(c, patch)), []);

  /** A custom window opens on the months on screen, so switching to it changes nothing until edited. */
  const setPeriod = useCallback((period: TrackingPeriod) => {
    setControls((c) => {
      if (period === 'quarter') {
        // The chosen year, or (none chosen) the year holding today.
        const year = c.fiscalYear === null
          ? years.find((y) => y.startDate.slice(0, 7) <= today && today <= y.endDate.slice(0, 7))
          : years.find((y) => y.fiscalYear === c.fiscalYear);
        return withPatch(c, { period, quarter: quarterHolding(year, today) });
      }
      if (period !== 'custom' || (c.from && c.to)) return withPatch(c, { period });
      const months = report?.window.months ?? [];
      return withPatch(c, { period, from: months[0] ?? today, to: months[months.length - 1] ?? today });
    });
  }, [report, today, years]);

  /** Another financial year: a Quarter view opens on that year's quarter holding today (Q1 if none). */
  const setFiscalYear = useCallback((fiscalYear: number) => {
    setControls((c) => withPatch(c, { fiscalYear, quarter: quarterHolding(years.find((y) => y.fiscalYear === fiscalYear), today) }));
  }, [years, today]);

  const clearFilter = useCallback(() => update({ cc1Id: '', cc2Id: '', buId: '' }), [update]);

  return {
    controls, update, setPeriod, setFiscalYear, clearFilter, retry, problem, report, years, isLoading, error,
    versions, versionsError, centres, units, refError, today, exportQuery,
  };
}
