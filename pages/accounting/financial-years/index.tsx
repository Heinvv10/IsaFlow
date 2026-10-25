/**
 * Financial Year Management
 * View all fiscal years, lock/unlock periods, and close the year-end.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { CalendarRange, Plus, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { apiFetch, apiJson, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { groupStoredYears } from '@/components/accounting/financialYears/types';
import { YearCard } from '@/components/accounting/financialYears/YearCard';
import { AddYearModal } from '@/components/accounting/financialYears/AddYearModal';
import { CloseYearModal } from '@/components/accounting/financialYears/CloseYearModal';
import { log } from '@/lib/logger';

function loadYears() {
  return apiJson('/api/accounting/fiscal-years', undefined, 'Could not load fiscal periods - try again');
}

export default function FinancialYearsPage() {
  const { activeCompany } = useCompany();

  const [years, setYears] = useState<Awaited<ReturnType<typeof loadYears>>>([]);
  const [jeCounts, setJeCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingPeriodId, setLoadingPeriodId] = useState<string | null>(null);
  const [closingYear, setClosingYear] = useState<number | null>(null);

  // Modals
  const [showAddYear, setShowAddYear] = useState(false);
  const [closeYearTarget, setCloseYearTarget] = useState<number | null>(null);
  const [closingYearSaving, setClosingYearSaving] = useState(false);

  const groups = groupStoredYears(years);
  const existingYears = groups.map(g => g.year);

  // ── Data fetch ───────────────────────────────────────────────────────────

  const fetchPeriods = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setYears(await loadYears());
    } catch (err) {
      log.error('Failed to fetch fiscal periods', { error: err }, 'financial-years-page');
      setYears([]);
      setError(apiErrorMessage(err, 'Could not load fiscal periods - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJeCounts = useCallback(async (year: number) => {
    try {
      const res = await apiFetch(`/api/accounting/fiscal-periods?jeCounts=true&year=${year}`);
      await assertOk(res, 'Could not load the journal counts');
      const json = await res.json() as { data?: Record<string, number> };
      if (json.data) {
        setJeCounts(prev => ({ ...prev, ...json.data }));
      }
    } catch (err) {
      // Secondary badge counts: a miss only hides the badge, the periods themselves still load
      log.warn('Failed to fetch JE counts', { year, error: err }, 'financial-years-page');
    }
  }, []);

  useEffect(() => {
    if (activeCompany?.id) void fetchPeriods();
  }, [activeCompany?.id, fetchPeriods]);

  useEffect(() => {
    for (const g of groups) void fetchJeCounts(g.year);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years, fetchJeCounts]);

  // ── Period actions ────────────────────────────────────────────────────────

  const handlePeriodAction = useCallback(async (id: string, action: 'close' | 'lock' | 'reopen') => {
    setLoadingPeriodId(id);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      await assertOk(res, 'Could not update that period - try again');
      await fetchPeriods();
    } catch (err) {
      log.error('Period action failed', { id, action, error: err }, 'financial-years-page');
      setError(apiErrorMessage(err, 'Could not update that period - try again'));
    } finally {
      setLoadingPeriodId(null);
    }
  }, [fetchPeriods]);

  // ── Close year ────────────────────────────────────────────────────────────

  const handleCloseYearClick = useCallback((year: number) => {
    setCloseYearTarget(year);
  }, []);

  const handleCloseYearConfirm = useCallback(async () => {
    if (closeYearTarget === null) return;
    setClosingYearSaving(true);
    setClosingYear(closeYearTarget);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close_year', fiscalYear: closeYearTarget }),
      });
      await assertOk(res, 'Could not close the year - try again');
      setCloseYearTarget(null);
      await fetchPeriods();
    } catch (err) {
      log.error('Close year failed', { year: closeYearTarget, error: err }, 'financial-years-page');
      setError(apiErrorMessage(err, 'Could not close the year - try again'));
      setCloseYearTarget(null);
    } finally {
      setClosingYearSaving(false);
      setClosingYear(null);
    }
  }, [closeYearTarget, fetchPeriods]);

  // ── Add year ──────────────────────────────────────────────────────────────

  const handleAddYear = useCallback(async (year: number) => {
    const res = await apiFetch('/api/accounting/fiscal-periods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year }),
    });
    // AddYearModal turns the thrown ApiRequestError into its message (apiErrorMessage).
    await assertOk(res, 'Could not create the financial year - try again');
    await fetchPeriods();
  }, [fetchPeriods]);

  // ── Close year modal data ─────────────────────────────────────────────────

  const closeYearGroup = closeYearTarget !== null
    ? groups.find(g => g.year === closeYearTarget) ?? null
    : null;
  const openCountForCloseYear = closeYearGroup?.periods.filter(p => p.status === 'open').length ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-5xl">

        {/* Page header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <CalendarRange className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Financial Years</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Manage fiscal periods, lock months, and close year-end</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void fetchPeriods()} disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors disabled:opacity-50">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <Link href="/accounting/financial-year-end-change" data-testid="change-year-end-link"
              className="px-3 py-2 text-sm rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
              Change year end
            </Link>
            <button onClick={() => setShowAddYear(true)}
              className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="h-4 w-4" /> Add New Year
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-auto text-red-400 hover:text-red-300">Dismiss</button>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
          </div>
        )}

        {/* Empty state */}
        {!loading && groups.length === 0 && (
          <div className="text-center py-16 space-y-3">
            <div className="mx-auto p-3 rounded-xl bg-teal-500/10 w-fit">
              <CalendarRange className="h-8 w-8 text-teal-500" />
            </div>
            <p className="text-[var(--ff-text-primary)] font-medium">No fiscal years configured</p>
            <p className="text-sm text-[var(--ff-text-secondary)]">Create your first fiscal year to start tracking periods</p>
            <button onClick={() => setShowAddYear(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="h-4 w-4" /> Add First Year
            </button>
          </div>
        )}

        {/* Year cards */}
        {!loading && groups.length > 0 && (
          <div className="space-y-4">
            {groups.map(group => (
              <YearCard key={group.year} group={group} jeCounts={jeCounts}
                loadingId={loadingPeriodId} onPeriodAction={handlePeriodAction}
                onCloseYear={handleCloseYearClick} closingYear={closingYear} />
            ))}
          </div>
        )}

      </div>

      {/* Modals */}
      {showAddYear && (
        <AddYearModal existingYears={existingYears}
          onConfirm={handleAddYear}
          onClose={() => setShowAddYear(false)} />
      )}

      {closeYearTarget !== null && (
        <CloseYearModal year={closeYearTarget} openCount={openCountForCloseYear}
          onConfirm={() => void handleCloseYearConfirm()}
          onCancel={() => setCloseYearTarget(null)}
          saving={closingYearSaving} />
      )}
    </AppLayout>
  );
}
