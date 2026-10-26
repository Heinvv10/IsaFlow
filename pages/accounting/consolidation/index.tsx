/**
 * Group Consolidation Page
 * Manage subsidiary relationships and run consolidated trial balances.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertCircle, Loader2, ChevronRight, BarChart3 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { AddSubsidiaryModal } from '@/components/accounting/consolidation/AddSubsidiaryModal';
import { GroupCompaniesSection } from '@/components/accounting/consolidation/GroupCompaniesSection';
import { ConsolidatedTBTable } from '@/components/accounting/consolidation/ConsolidatedTBTable';
import type {
  GroupCompany,
  ConsolidatedTrialBalance,
} from '@/modules/accounting/services/reports/consolidationTypes';
import { localISODate } from '@/lib/dateUtils';
import { DateField } from '@/components/ui/DateField';

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultRange() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return {
    start: localISODate(start),
    end:   localISODate(end),
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConsolidationPage() {
  const range = defaultRange();
  const [periodStart, setPeriodStart] = useState(range.start);
  const [periodEnd,   setPeriodEnd]   = useState(range.end);

  const [groupCompanies, setGroupCompanies]     = useState<GroupCompany[]>([]);
  const [loadingCompanies, setLoadingCompanies] = useState(true);
  const [report, setReport]                     = useState<ConsolidatedTrialBalance | null>(null);
  const [loadingReport, setLoadingReport]       = useState(false);
  const [reportError, setReportError]           = useState('');
  const [showModal, setShowModal]               = useState(false);
  const [companiesError, setCompaniesError]     = useState('');

  const loadGroupCompanies = useCallback(async () => {
    setLoadingCompanies(true);
    setCompaniesError('');
    try {
      const res  = await apiFetch('/api/accounting/consolidation/companies');
      await assertOk(res, 'Could not load group companies - try again');
      const json = await res.json();
      setGroupCompanies((json.data?.items ?? []) as GroupCompany[]);
    } catch (err) {
      setGroupCompanies([]);
      setCompaniesError(apiErrorMessage(err, 'Could not load group companies - try again'));
    } finally {
      setLoadingCompanies(false);
    }
  }, []);

  useEffect(() => { void loadGroupCompanies(); }, [loadGroupCompanies]);

  async function runReport() {
    if (!periodStart || !periodEnd) return;
    setLoadingReport(true);
    setReportError('');
    setReport(null);
    try {
      const params = new URLSearchParams({ periodStart, periodEnd });
      const res  = await apiFetch(`/api/accounting/consolidation/trial-balance?${params}`);
      await assertOk(res, 'Could not load the report - try again');
      const json = await res.json();
      if (!json.success) {
        setReportError(json.error?.message ?? 'Could not load the report - try again');
        return;
      }
      setReport(json.data as ConsolidatedTrialBalance);
    } catch (err) {
      setReport(null);
      setReportError(apiErrorMessage(err, 'Could not load the report - try again'));
    } finally {
      setLoadingReport(false);
    }
  }

  return (
    <AppLayout>
      <div className="space-y-8 p-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Group Consolidation</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Manage subsidiary relationships and view consolidated financials
          </p>
        </div>

        {companiesError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" /> {companiesError}
          </div>
        )}
        <GroupCompaniesSection
          items={groupCompanies}
          loading={loadingCompanies}
          onRefresh={loadGroupCompanies}
          onAdd={() => setShowModal(true)}
        />

        {/* ── Consolidated Trial Balance ─────────────────────────────────────── */}
        <section className="rounded-2xl border border-white/10 bg-[#1a1f2e]">
          <div className="border-b border-white/10 px-6 py-4">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white">
              <BarChart3 className="h-5 w-5 text-indigo-400" />
              <span className="font-semibold">Consolidated Trial Balance</span>
            </div>
          </div>

          {/* Date controls */}
          <div className="flex flex-wrap items-end gap-4 px-6 py-4">
            <DateField
              label="Period Start"
              name="periodStart"
              required
              value={periodStart || null}
              onChange={(iso, v) => { if (v.valid && iso) setPeriodStart(iso); }}
            />
            <DateField
              label="Period End"
              name="periodEnd"
              required
              value={periodEnd || null}
              onChange={(iso, v) => { if (v.valid && iso) setPeriodEnd(iso); }}
            />
            <button
              onClick={runReport}
              disabled={loadingReport || groupCompanies.length === 0}
              className="flex items-center gap-2 rounded-lg bg-indigo-500/90 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
            >
              {loadingReport
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Running…</>
                : <><ChevronRight className="h-4 w-4" /> Run</>}
            </button>
          </div>

          {reportError && (
            <div className="mx-6 mb-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" /> {reportError}
            </div>
          )}

          {report && <ConsolidatedTBTable report={report} />}

          {!report && !loadingReport && !reportError && (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-gray-500">
              <BarChart3 className="h-10 w-10 text-gray-700" />
              <p className="text-sm">Select a date range and click Run to generate the report.</p>
            </div>
          )}
        </section>
      </div>

      {showModal && (
        <AddSubsidiaryModal
          onClose={() => setShowModal(false)}
          onSaved={(items) => setGroupCompanies(items)}
        />
      )}
    </AppLayout>
  );
}
