/**
 * Data Archiving & Retention Engine
 * WS-7.4 — Archive old financial data for DB performance.
 * SA Companies Act minimum retention: 5 years.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  Archive, Database, Clock, CheckCircle2, XCircle,
  AlertTriangle, Loader2, Eye, ChevronRight,
} from 'lucide-react';
import type {
  StorageStats, ArchivePreview, ArchiveValidation, ArchiveRun, ArchivedEntry,
} from '@/modules/accounting/services/dataArchivingService';

type ViewMode = 'dashboard' | 'archived-data';

const COMPONENT = 'data-archiving-page';
const ARCHIVE_LIMIT = 50;
const TABLE_LABELS: Record<string, string> = {
  gl_journal_entries: 'GL Journal Entries',
  gl_journal_lines: 'GL Journal Lines',
  bank_transactions: 'Bank Transactions',
  customer_invoices: 'Customer Invoices',
  supplier_invoices: 'Supplier Invoices',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-green-100 text-green-800 border-green-300',
    running: 'bg-blue-100 text-blue-800 border-blue-300',
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    failed: 'bg-red-100 text-red-800 border-red-300',
    posted: 'bg-green-100 text-green-800 border-green-300',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-800 border-gray-300';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function Section({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] overflow-hidden">
      <div className="flex items-center gap-2 px-6 py-4 border-b border-[var(--ff-border)] bg-[var(--ff-bg-primary)]">
        <span className="text-[var(--ff-text-muted)]">{icon}</span>
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(url, options);
  const json = await res.json() as { data: T };
  return json.data;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DataArchivingPage() {
  const { activeCompany } = useCompany();
  const [view, setView] = useState<ViewMode>('dashboard');

  // Storage stats
  const [stats, setStats] = useState<StorageStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);

  // Archive wizard
  const [cutoffDate, setCutoffDate] = useState('');
  const [validation, setValidation] = useState<ArchiveValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSuccess, setArchiveSuccess] = useState(false);

  // Archive history
  const [runs, setRuns] = useState<ArchiveRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);

  // Archived data viewer
  const [archivedItems, setArchivedItems] = useState<ArchivedEntry[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archiveDateFrom, setArchiveDateFrom] = useState('');
  const [archiveDateTo, setArchiveDateTo] = useState('');
  const [archivePage, setArchivePage] = useState(0);

  // Maximum cutoff date: today minus 5 years
  const maxCutoff = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().split('T')[0] ?? '';
  })();

  const loadStats = useCallback(async () => {
    if (!activeCompany) return;
    setStatsLoading(true);
    try {
      const data = await fetchJson<{ stats: StorageStats[] }>('/api/accounting/data-archiving');
      setStats(data.stats);
    } catch (err) {
      log.error('Failed to load storage stats', { error: err }, COMPONENT);
    } finally {
      setStatsLoading(false);
    }
  }, [activeCompany]);

  const loadRuns = useCallback(async () => {
    if (!activeCompany) return;
    setRunsLoading(true);
    try {
      const data = await fetchJson<{ runs: ArchiveRun[] }>('/api/accounting/archive-runs');
      setRuns(data.runs);
    } catch (err) {
      log.error('Failed to load archive runs', { error: err }, COMPONENT);
    } finally {
      setRunsLoading(false);
    }
  }, [activeCompany]);

  const loadArchivedData = useCallback(async () => {
    if (!activeCompany) return;
    setArchivedLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(ARCHIVE_LIMIT),
        offset: String(archivePage * ARCHIVE_LIMIT),
      });
      if (archiveDateFrom) params.set('date_from', archiveDateFrom);
      if (archiveDateTo) params.set('date_to', archiveDateTo);
      const data = await fetchJson<{ items: ArchivedEntry[]; total: number }>(
        `/api/accounting/archived-data?${params.toString()}`
      );
      setArchivedItems(data.items);
      setArchivedTotal(data.total);
    } catch (err) {
      log.error('Failed to load archived data', { error: err }, COMPONENT);
    } finally {
      setArchivedLoading(false);
    }
  }, [activeCompany, archivePage, archiveDateFrom, archiveDateTo]);

  useEffect(() => { void loadStats(); void loadRuns(); }, [loadStats, loadRuns]);
  useEffect(() => {
    if (view === 'archived-data') void loadArchivedData();
  }, [view, loadArchivedData]);

  const handleValidate = async () => {
    if (!cutoffDate) return;
    setValidating(true);
    setValidation(null);
    setPreview(null);
    try {
      const data = await fetchJson<{ validation: ArchiveValidation }>(
        `/api/accounting/data-archiving?action=validate&cutoff=${cutoffDate}`
      );
      setValidation(data.validation);
    } catch (err) {
      log.error('Validation request failed', { error: err }, COMPONENT);
    } finally {
      setValidating(false);
    }
  };

  const handlePreview = async () => {
    if (!cutoffDate) return;
    setPreviewing(true);
    setPreview(null);
    try {
      const data = await fetchJson<{ preview: ArchivePreview }>(
        `/api/accounting/data-archiving?action=preview&cutoff=${cutoffDate}`
      );
      setPreview(data.preview);
    } catch (err) {
      log.error('Preview request failed', { error: err }, COMPONENT);
    } finally {
      setPreviewing(false);
    }
  };

  const handleArchive = async () => {
    setShowConfirm(false);
    setArchiving(true);
    setArchiveError(null);
    setArchiveSuccess(false);
    try {
      await apiFetch('/api/accounting/data-archiving', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoffDate }),
      });
      setArchiveSuccess(true);
      setCutoffDate('');
      setValidation(null);
      setPreview(null);
      await loadStats();
      await loadRuns();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Archive failed. All changes have been rolled back.';
      setArchiveError(msg);
      log.error('Archive execution failed', { error: err }, COMPONENT);
    } finally {
      setArchiving(false);
    }
  };

  const totalRows = stats.reduce((sum, s) => sum + s.rowCount, 0);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">

        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] flex items-center gap-2">
              <Archive className="h-6 w-6 text-teal-600" />
              Data Archiving
            </h1>
            <p className="text-sm text-[var(--ff-text-muted)] mt-1">
              Move old financial records to archive tables to maintain database performance.
              SA Companies Act requires minimum 5-year retention.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setView('dashboard')}
              className={`text-sm px-4 py-2 rounded-lg border transition-colors ${
                view === 'dashboard'
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'border-[var(--ff-border)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-secondary)]'
              }`}
            >
              Dashboard
            </button>
            <button
              onClick={() => setView('archived-data')}
              className={`flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border transition-colors ${
                view === 'archived-data'
                  ? 'bg-teal-600 text-white border-teal-600'
                  : 'border-[var(--ff-border)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-secondary)]'
              }`}
            >
              <Eye className="h-4 w-4" />
              View Archived Data
            </button>
          </div>
        </div>

        {/* ── Dashboard View ── */}
        {view === 'dashboard' && (
          <>
            {/* Storage Stats */}
            <Section title="Storage Dashboard" icon={<Database className="h-4 w-4" />}>
              {statsLoading ? (
                <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading statistics...
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border)]">
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Table</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Row Count</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Oldest Record</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Newest Record</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ff-border)]">
                      {stats.map((s) => (
                        <tr key={s.tableName}>
                          <td className="py-2.5 font-medium text-[var(--ff-text-primary)]">
                            {TABLE_LABELS[s.tableName] ?? s.tableName}
                          </td>
                          <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">
                            {s.rowCount.toLocaleString()}
                          </td>
                          <td className="py-2.5 text-right text-[var(--ff-text-muted)]">
                            {s.oldestDate ?? '—'}
                          </td>
                          <td className="py-2.5 text-right text-[var(--ff-text-muted)]">
                            {s.newestDate ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-[var(--ff-border)]">
                        <td className="pt-3 font-bold text-[var(--ff-text-primary)]">Total</td>
                        <td className="pt-3 text-right font-bold text-[var(--ff-text-primary)]">
                          {totalRows.toLocaleString()}
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </Section>

            {/* Archive Wizard */}
            <Section title="Archive Wizard" icon={<Archive className="h-4 w-4" />}>
              <div className="space-y-6">
                {/* Date picker */}
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5">
                    Cutoff Date
                  </label>
                  <p className="text-xs text-[var(--ff-text-muted)] mb-2">
                    Records before this date (that are fully finalised) will be moved to archive tables.
                    Maximum allowed cutoff: <strong>{maxCutoff}</strong> (5-year minimum retention).
                  </p>
                  <input
                    type="date"
                    value={cutoffDate}
                    max={maxCutoff}
                    onChange={(e) => {
                      setCutoffDate(e.target.value);
                      setValidation(null);
                      setPreview(null);
                      setArchiveError(null);
                      setArchiveSuccess(false);
                    }}
                    className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-teal-500"
                  />
                </div>

                {/* Buttons */}
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => void handleValidate()}
                    disabled={!cutoffDate || validating}
                    className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {validating ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Validate
                  </button>
                  <button
                    onClick={() => void handlePreview()}
                    disabled={!cutoffDate || previewing}
                    className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                    Preview
                  </button>
                  <button
                    onClick={() => setShowConfirm(true)}
                    disabled={!validation?.valid || archiving}
                    className="flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {archiving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                    Archive Now
                  </button>
                </div>

                {/* Validation result */}
                {validation && (
                  <div className={`rounded-lg border p-4 ${
                    validation.valid
                      ? 'border-green-300 bg-green-50'
                      : 'border-red-300 bg-red-50'
                  }`}>
                    <div className="flex items-center gap-2 mb-2">
                      {validation.valid
                        ? <CheckCircle2 className="h-5 w-5 text-green-600" />
                        : <XCircle className="h-5 w-5 text-red-600" />}
                      <span className={`text-sm font-semibold ${validation.valid ? 'text-green-800' : 'text-red-800'}`}>
                        {validation.valid ? 'Validation Passed' : 'Validation Failed'}
                      </span>
                    </div>
                    {validation.errors.length > 0 && (
                      <ul className="list-disc list-inside space-y-1">
                        {validation.errors.map((e, i) => (
                          <li key={i} className="text-sm text-red-700">{e}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Preview result */}
                {preview && (
                  <div className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] p-4">
                    <p className="text-sm font-semibold text-[var(--ff-text-primary)] mb-3">
                      Records that would be archived before {cutoffDate}:
                    </p>
                    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {[
                        { label: 'Journal Entries', value: preview.journalEntries },
                        { label: 'Journal Lines', value: preview.journalLines },
                        { label: 'Bank Transactions', value: preview.bankTransactions },
                        { label: 'Customer Invoices', value: preview.customerInvoices },
                        { label: 'Supplier Invoices', value: preview.supplierInvoices },
                      ].map((item) => (
                        <div key={item.label} className="rounded-lg bg-[var(--ff-bg-secondary)] p-3">
                          <dt className="text-xs text-[var(--ff-text-muted)]">{item.label}</dt>
                          <dd className="text-lg font-bold text-[var(--ff-text-primary)]">
                            {item.value.toLocaleString()}
                          </dd>
                        </div>
                      ))}
                      <div className="rounded-lg bg-teal-50 border border-teal-200 p-3">
                        <dt className="text-xs text-teal-700 font-medium">Total Records</dt>
                        <dd className="text-lg font-bold text-teal-800">
                          {preview.totalRecords.toLocaleString()}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}

                {/* Success / error banners */}
                {archiveSuccess && (
                  <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
                    <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0" />
                    Archive completed successfully. Data has been moved to archive tables.
                  </div>
                )}
                {archiveError && (
                  <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                    <XCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
                    {archiveError}
                  </div>
                )}
              </div>
            </Section>

            {/* Archive History */}
            <Section title="Archive History" icon={<Clock className="h-4 w-4" />}>
              {runsLoading ? (
                <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading history...
                </div>
              ) : runs.length === 0 ? (
                <p className="text-sm text-[var(--ff-text-muted)]">No archive runs yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border)]">
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Date Run</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Cutoff</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Status</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Entries</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Transactions</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Invoices</th>
                        <th className="pb-2 text-right font-semibold text-[var(--ff-text-muted)]">Duration</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ff-border)]">
                      {runs.map((run) => {
                        const duration = run.startedAt && run.completedAt
                          ? Math.round(
                              (new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000
                            )
                          : null;
                        return (
                          <tr key={run.id}>
                            <td className="py-2.5 text-[var(--ff-text-secondary)]">
                              {new Date(run.createdAt).toLocaleDateString('en-ZA')}
                            </td>
                            <td className="py-2.5 text-[var(--ff-text-primary)] font-medium">
                              {run.cutoffDate}
                            </td>
                            <td className="py-2.5"><StatusBadge status={run.status} /></td>
                            <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">
                              {run.entriesArchived.toLocaleString()}
                            </td>
                            <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">
                              {run.transactionsArchived.toLocaleString()}
                            </td>
                            <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">
                              {(run.invoicesArchived + run.supplierInvoicesArchived).toLocaleString()}
                            </td>
                            <td className="py-2.5 text-right text-[var(--ff-text-muted)]">
                              {duration !== null ? `${duration}s` : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>
          </>
        )}

        {/* ── Archived Data View ── */}
        {view === 'archived-data' && (
          <Section title="Archived Journal Entries (Read-Only)" icon={<Eye className="h-4 w-4" />}>
            {/* Filters */}
            <div className="flex flex-wrap gap-3 mb-6">
              <div>
                <label className="block text-xs text-[var(--ff-text-muted)] mb-1">Date From</label>
                <input
                  type="date"
                  value={archiveDateFrom}
                  onChange={(e) => { setArchiveDateFrom(e.target.value); setArchivePage(0); }}
                  className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--ff-text-muted)] mb-1">Date To</label>
                <input
                  type="date"
                  value={archiveDateTo}
                  onChange={(e) => { setArchiveDateTo(e.target.value); setArchivePage(0); }}
                  className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={() => void loadArchivedData()}
                  disabled={archivedLoading}
                  className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50 transition-colors"
                >
                  {archivedLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                  Search
                </button>
              </div>
            </div>

            {archivedLoading ? (
              <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading archived data...
              </div>
            ) : archivedItems.length === 0 ? (
              <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
                <AlertTriangle className="h-4 w-4" />
                No archived journal entries found for the selected date range.
              </div>
            ) : (
              <>
                <p className="text-xs text-[var(--ff-text-muted)] mb-3">
                  Showing {archivePage * ARCHIVE_LIMIT + 1}–{Math.min((archivePage + 1) * ARCHIVE_LIMIT, archivedTotal)} of {archivedTotal.toLocaleString()} archived entries
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border)]">
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Entry #</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Date</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Description</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Source</th>
                        <th className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ff-border)]">
                      {archivedItems.map((item) => (
                        <tr key={item.id}>
                          <td className="py-2.5 font-mono text-xs text-[var(--ff-text-secondary)]">
                            {item.entryNumber ?? '—'}
                          </td>
                          <td className="py-2.5 text-[var(--ff-text-primary)]">{item.entryDate}</td>
                          <td className="py-2.5 text-[var(--ff-text-secondary)] max-w-xs truncate">
                            {item.description ?? '—'}
                          </td>
                          <td className="py-2.5 text-[var(--ff-text-muted)] capitalize">{item.source ?? '—'}</td>
                          <td className="py-2.5">
                            <StatusBadge status={item.status ?? 'unknown'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                {archivedTotal > ARCHIVE_LIMIT && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--ff-border)]">
                    <button
                      onClick={() => setArchivePage((p) => Math.max(0, p - 1))}
                      disabled={archivePage === 0}
                      className="text-sm px-3 py-1.5 rounded-lg border border-[var(--ff-border)] disabled:opacity-40 hover:bg-[var(--ff-bg-secondary)] transition-colors"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-[var(--ff-text-muted)]">
                      Page {archivePage + 1} of {Math.ceil(archivedTotal / ARCHIVE_LIMIT)}
                    </span>
                    <button
                      onClick={() => setArchivePage((p) => p + 1)}
                      disabled={(archivePage + 1) * ARCHIVE_LIMIT >= archivedTotal}
                      className="text-sm px-3 py-1.5 rounded-lg border border-[var(--ff-border)] disabled:opacity-40 hover:bg-[var(--ff-bg-secondary)] transition-colors"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </Section>
        )}
      </div>

      {/* Confirm Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-[var(--ff-bg-primary)] rounded-xl border border-[var(--ff-border)] p-6 max-w-md w-full space-y-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">
                  Confirm Archive Operation
                </h3>
                <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                  This will permanently move all eligible records before{' '}
                  <strong>{cutoffDate}</strong> to the archive tables and delete them from
                  active tables. This operation cannot be undone from the UI.
                </p>
                {preview && (
                  <p className="text-sm text-[var(--ff-text-muted)] mt-2">
                    <strong>{preview.totalRecords.toLocaleString()}</strong> total records will be archived.
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleArchive()}
                className="text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors"
              >
                Yes, Archive Now
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
