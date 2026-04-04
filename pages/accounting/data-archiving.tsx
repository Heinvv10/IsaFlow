/**
 * Data Archiving & Retention Engine — thin shell
 * WS-7.4 — Archive old financial data for DB performance.
 * SA Companies Act minimum retention: 5 years.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Archive, Database, Clock, AlertTriangle, Eye } from 'lucide-react';
import type {
  StorageStats, ArchivePreview, ArchiveValidation, ArchiveRun, ArchivedEntry,
} from '@/modules/accounting/services/dataArchivingService';
import { ArchiveStorageStats } from '@/components/accounting/ArchiveStorageStats';
import { ArchiveWizardSection } from '@/components/accounting/ArchiveWizardSection';
import { ArchiveHistoryTable } from '@/components/accounting/ArchiveHistoryTable';
import { ArchivedDataViewer } from '@/components/accounting/ArchivedDataViewer';

const COMPONENT = 'data-archiving-page';
const ARCHIVE_LIMIT = 50;

type ViewMode = 'dashboard' | 'archived-data';

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
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

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(url, options);
  const json = await res.json() as { data: T };
  return json.data;
}

export default function DataArchivingPage() {
  const { activeCompany } = useCompany();
  const [view, setView] = useState<ViewMode>('dashboard');
  const [stats, setStats] = useState<StorageStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [cutoffDate, setCutoffDate] = useState('');
  const [validation, setValidation] = useState<ArchiveValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveSuccess, setArchiveSuccess] = useState(false);
  const [runs, setRuns] = useState<ArchiveRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [archivedItems, setArchivedItems] = useState<ArchivedEntry[]>([]);
  const [archivedTotal, setArchivedTotal] = useState(0);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archiveDateFrom, setArchiveDateFrom] = useState('');
  const [archiveDateTo, setArchiveDateTo] = useState('');
  const [archivePage, setArchivePage] = useState(0);

  const maxCutoff = (() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 5);
    return d.toISOString().split('T')[0] ?? '';
  })();

  const loadStats = useCallback(async () => {
    if (!activeCompany) return;
    setStatsLoading(true);
    try {
      const data = await fetchJson<{ stats: StorageStats[] }>('/api/accounting/data-archiving');
      setStats(data.stats);
    } catch (err) { log.error('Failed to load storage stats', { error: err }, COMPONENT); }
    finally { setStatsLoading(false); }
  }, [activeCompany]);

  const loadRuns = useCallback(async () => {
    if (!activeCompany) return;
    setRunsLoading(true);
    try {
      const data = await fetchJson<{ runs: ArchiveRun[] }>('/api/accounting/archive-runs');
      setRuns(data.runs);
    } catch (err) { log.error('Failed to load archive runs', { error: err }, COMPONENT); }
    finally { setRunsLoading(false); }
  }, [activeCompany]);

  const loadArchivedData = useCallback(async () => {
    if (!activeCompany) return;
    setArchivedLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(ARCHIVE_LIMIT), offset: String(archivePage * ARCHIVE_LIMIT) });
      if (archiveDateFrom) params.set('date_from', archiveDateFrom);
      if (archiveDateTo) params.set('date_to', archiveDateTo);
      const data = await fetchJson<{ items: ArchivedEntry[]; total: number }>(`/api/accounting/archived-data?${params.toString()}`);
      setArchivedItems(data.items);
      setArchivedTotal(data.total);
    } catch (err) { log.error('Failed to load archived data', { error: err }, COMPONENT); }
    finally { setArchivedLoading(false); }
  }, [activeCompany, archivePage, archiveDateFrom, archiveDateTo]);

  useEffect(() => { void loadStats(); void loadRuns(); }, [loadStats, loadRuns]);
  useEffect(() => { if (view === 'archived-data') void loadArchivedData(); }, [view, loadArchivedData]);

  const handleValidate = async () => {
    if (!cutoffDate) return;
    setValidating(true); setValidation(null); setPreview(null);
    try {
      const data = await fetchJson<{ validation: ArchiveValidation }>(`/api/accounting/data-archiving?action=validate&cutoff=${cutoffDate}`);
      setValidation(data.validation);
    } catch (err) { log.error('Validation request failed', { error: err }, COMPONENT); }
    finally { setValidating(false); }
  };

  const handlePreview = async () => {
    if (!cutoffDate) return;
    setPreviewing(true); setPreview(null);
    try {
      const data = await fetchJson<{ preview: ArchivePreview }>(`/api/accounting/data-archiving?action=preview&cutoff=${cutoffDate}`);
      setPreview(data.preview);
    } catch (err) { log.error('Preview request failed', { error: err }, COMPONENT); }
    finally { setPreviewing(false); }
  };

  const handleArchive = async () => {
    setShowConfirm(false); setArchiving(true); setArchiveError(null); setArchiveSuccess(false);
    try {
      await apiFetch('/api/accounting/data-archiving', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoffDate }),
      });
      setArchiveSuccess(true); setCutoffDate(''); setValidation(null); setPreview(null);
      await loadStats(); await loadRuns();
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Archive failed. All changes have been rolled back.');
      log.error('Archive execution failed', { error: err }, COMPONENT);
    } finally { setArchiving(false); }
  };

  const handleCutoffChange = (v: string) => {
    setCutoffDate(v); setValidation(null); setPreview(null);
    setArchiveError(null); setArchiveSuccess(false);
  };

  const totalRows = stats.reduce((sum, s) => sum + s.rowCount, 0);

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] flex items-center gap-2">
              <Archive className="h-6 w-6 text-teal-600" /> Data Archiving
            </h1>
            <p className="text-sm text-[var(--ff-text-muted)] mt-1">
              Move old financial records to archive tables. SA Companies Act requires minimum 5-year retention.
            </p>
          </div>
          <div className="flex gap-2">
            {(['dashboard', 'archived-data'] as ViewMode[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg border transition-colors ${
                  view === v ? 'bg-teal-600 text-white border-teal-600' : 'border-[var(--ff-border)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-secondary)]'
                }`}>
                {v === 'archived-data' && <Eye className="h-4 w-4" />}
                {v === 'dashboard' ? 'Dashboard' : 'View Archived Data'}
              </button>
            ))}
          </div>
        </div>

        {view === 'dashboard' && (
          <>
            <Section title="Storage Dashboard" icon={<Database className="h-4 w-4" />}>
              <ArchiveStorageStats stats={stats} loading={statsLoading} totalRows={totalRows} />
            </Section>

            <Section title="Archive Wizard" icon={<Archive className="h-4 w-4" />}>
              <ArchiveWizardSection
                cutoffDate={cutoffDate} maxCutoff={maxCutoff}
                validation={validation} validating={validating}
                preview={preview} previewing={previewing}
                archiving={archiving} archiveError={archiveError} archiveSuccess={archiveSuccess}
                onCutoffChange={handleCutoffChange}
                onValidate={() => void handleValidate()}
                onPreview={() => void handlePreview()}
                onRequestArchive={() => setShowConfirm(true)}
              />
            </Section>

            <Section title="Archive History" icon={<Clock className="h-4 w-4" />}>
              <ArchiveHistoryTable runs={runs} loading={runsLoading} />
            </Section>
          </>
        )}

        {view === 'archived-data' && (
          <Section title="Archived Journal Entries (Read-Only)" icon={<Eye className="h-4 w-4" />}>
            <ArchivedDataViewer
              items={archivedItems} total={archivedTotal} loading={archivedLoading}
              dateFrom={archiveDateFrom} dateTo={archiveDateTo} page={archivePage}
              onDateFromChange={(v) => { setArchiveDateFrom(v); setArchivePage(0); }}
              onDateToChange={(v) => { setArchiveDateTo(v); setArchivePage(0); }}
              onSearch={() => void loadArchivedData()}
              onPageChange={setArchivePage}
            />
          </Section>
        )}
      </div>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-[var(--ff-bg-primary)] rounded-xl border border-[var(--ff-border)] p-6 max-w-md w-full space-y-4 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-6 w-6 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-[var(--ff-text-primary)]">Confirm Archive Operation</h3>
                <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                  This will permanently move all eligible records before <strong>{cutoffDate}</strong> to the archive tables. This operation cannot be undone from the UI.
                </p>
                {preview && <p className="text-sm text-[var(--ff-text-muted)] mt-2"><strong>{preview.totalRecords.toLocaleString()}</strong> total records will be archived.</p>}
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowConfirm(false)} className="text-sm px-4 py-2 rounded-lg border border-[var(--ff-border)] hover:bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)] transition-colors">Cancel</button>
              <button onClick={() => void handleArchive()} className="text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors">Yes, Archive Now</button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
