/**
 * The Budget vs Actual page's state: the controls, the tracking report they
 * load, and the pickers' lists (versions of FY*, cost centres, business
 * units). The report is the engine's (`/api/accounting/reports-budget-tracking`);
 * nothing here computes a figure.
 *
 * A response that arrives after a newer request is dropped, so a slow
 * earlier window never overwrites a later one. A failed load clears the
 * report, so the export buttons cannot export the previous window.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';
import type { BudgetVersion } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { BudgetTrackingReport, TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import {
  controlsWindowYear, DEFAULT_CONTROLS, trackingSearch, versionApplies, yearOfMonth, type TrackingControls,
} from './trackingControls';

export interface DimensionOption { id: string; code: string; name: string; ccType?: string }

const LOAD_FAILED = 'Could not load the budget report - try again';

async function listOf(url: string, failure: string): Promise<DimensionOption[]> {
  const res = await apiFetch(url, { credentials: 'include' });
  await assertOk(res, failure);
  const json = await res.json();
  const items = json.data?.items ?? json.data ?? [];
  return Array.isArray(items) ? items : [];
}

export function useBudgetTracking() {
  const [controls, setControls] = useState<TrackingControls>(DEFAULT_CONTROLS);
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

  const windowYear = controlsWindowYear(controls, years, today, yearOfMonth(today, years));
  const sendVersion = versionApplies(controls, windowYear);
  const query = trackingSearch(controls, { sendVersion, bullets: true }).toString();
  const exportQuery = trackingSearch(controls, { sendVersion, bullets: false }).toString();

  useEffect(() => {
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
  }, [query]);

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

  const update = useCallback((patch: Partial<TrackingControls>) => setControls((c) => ({ ...c, ...patch })), []);

  /** A custom window opens on the months on screen, so switching to it changes nothing until edited. */
  const setPeriod = useCallback((period: TrackingPeriod) => {
    setControls((c) => {
      if (period !== 'custom' || (c.from && c.to)) return { ...c, period };
      const months = report?.window.months ?? [];
      return { ...c, period, from: months[0] ?? today, to: months[months.length - 1] ?? today };
    });
  }, [report, today]);

  const setVersion = useCallback((versionId: string) => {
    setControls((c) => ({ ...c, versionId, versionFy: versionId ? fy : null }));
  }, [fy]);

  const clearFilter = useCallback(() => update({ cc1Id: '', cc2Id: '', buId: '' }), [update]);

  return {
    controls, update, setPeriod, setVersion, clearFilter, report, years, isLoading, error,
    versions, versionsError, centres, units, refError, today, windowYear, sendVersion, exportQuery,
  };
}
