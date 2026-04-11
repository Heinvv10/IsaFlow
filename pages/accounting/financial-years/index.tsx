/**
 * Financial Year Management
 * View all fiscal years, lock/unlock periods, and close the year-end.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { CalendarRange, Plus, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import { groupPeriodsIntoYears } from '@/components/accounting/financialYears/types';
import { YearCard } from '@/components/accounting/financialYears/YearCard';
import { AddYearModal } from '@/components/accounting/financialYears/AddYearModal';
import { CloseYearModal } from '@/components/accounting/financialYears/CloseYearModal';
import { log } from '@/lib/logger';

export default function FinancialYearsPage() {
  const { activeCompany } = useCompany();

  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [jeCounts, setJeCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingPeriodId, setLoadingPeriodId] = useState<string | null>(null);
  const [closingYear, setClosingYear] = useState<number | null>(null);

  // Modals
  const [showAddYear, setShowAddYear] = useState(false);
  const [closeYearTarget, setCloseYearTarget] = useState<number | null>(null);
  const [closingYearSaving, setClosingYearSaving] = useState(false);

  const groups = groupPeriodsIntoYears(periods);
  const existingYears = groups.map(g => g.year);

  // ── Data fetch ───────────────────────────────────────────────────────────

  const fetchPeriods = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods');
      const json = await res.json() as { data?: FiscalPeriod[] };
      if (!res.ok) throw new Error('Failed to load fiscal periods');
      setPeriods(json.data ?? []);
    } catch (err) {
      log.error('Failed to fetch fiscal periods', { error: err }, 'financial-years-page');
      setError('Failed to load fiscal periods');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJeCounts = useCallback(async (year: number) => {
    try {
      const res = await apiFetch(`/api/accounting/fiscal-periods?jeCounts=true&year=${year}`);
      const json = await res.json() as { data?: Record<string, number> };
      if (res.ok && json.data) {
        setJeCounts(prev => ({ ...prev, ...json.data }));
      }
    } catch (err) {
      log.error('Failed to fetch JE counts', { year, error: err }, 'financial-years-page');
    }
  }, []);

  useEffect(() => {
    if (activeCompany?.id) void fetchPeriods();
  }, [activeCompany?.id, fetchPeriods]);

  useEffect(() => {
    for (const g of groups) void fetchJeCounts(g.year);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, fetchJeCounts]);

  // ── Period actions ────────────────────────────────────────────────────────

  const handlePeriodAction = useCallback(async (id: string, action: 'close' | 'lock' | 'reopen') => {
    setLoadingPeriodId(id);
    try {
      const res = await apiFetch('/api/accounting/fiscal-periods-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(json.message ?? 'Action failed');
      await fetchPeriods();
    } catch (err) {
      log.error('Period action failed', { id, action, error: err }, 'financial-years-page');
      setError(err instanceof Error ? err.message : 'Action failed');
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
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(json.message ?? 'Failed to close year');
      setCloseYearTarget(null);
      await fetchPeriods();
    } catch (err) {
      log.error('Close year failed', { year: closeYearTarget, error: err }, 'financial-years-page');
      setError(err instanceof Error ? err.message : 'Failed to close year');
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
    const json = await res.json() as { message?: string };
    if (!res.ok) throw new Error(json.message ?? 'Failed to create year');
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
