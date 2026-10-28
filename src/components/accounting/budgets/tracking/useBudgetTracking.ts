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
 * report, so the export buttons cannot export the previous window.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { BudgetTrackingReport, TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import {
  controlsFromQuery, controlsToQuery, DEFAULT_CONTROLS, trackingSearch, withPatch, type TrackingControls,
} from './trackingControls';

export interface DimensionOption { id: string; code: string; name: string; ccType?: string }

export const BVA_PATH = '/accounting/reports/budget-vs-actual';
const LOAD_FAILED = 'Could not load the budget report - try again';

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

  const query = trackingSearch(controls, { bullets: true }).toString();
  const exportQuery = trackingSearch(controls, { bullets: false }).toString();
  const urlQuery = new URLSearchParams(controlsToQuery(controls)).toString();
  const returnTo = `${BVA_PATH}?${urlQuery}`;

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

  useEffect(() => {
    if (!hydrated) return;
    const request = ++latest.current;
    setIsLoading(true);
    setError('');
    apiJson(`/api/accounting/reports-budget-tracking?${query}`, undefined, LOAD_FAILED)
      .then((data) => {
        if (request !== latest.current) return;
        setReport(data);
        setYears(data.years);
      })
      .catch((err) => {
        if (request !== latest.current) return;
        setReport(null);
        setError(apiErrorMessage(err, LOAD_FAILED));
      })
      .finally(() => { if (request === latest.current) setIsLoading(false); });
  }, [hydrated, query]);

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
      if (period !== 'custom' || (c.from && c.to)) return withPatch(c, { period });
      const months = report?.window.months ?? [];
      return withPatch(c, { period, from: months[0] ?? today, to: months[months.length - 1] ?? today });
    });
  }, [report, today]);

  const clearFilter = useCallback(() => update({ cc1Id: '', cc2Id: '', buId: '' }), [update]);

  return {
    controls, update, setPeriod, clearFilter, report, years, isLoading, error,
    versions, versionsError, centres, units, refError, today, exportQuery, returnTo,
  };
}
