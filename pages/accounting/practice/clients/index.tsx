/**
 * Practice Clients List Page
 * Shows all practice clients with search and status filter.
 * Route: /accounting/practice/clients
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Users, Loader2, AlertCircle, Plus, Search, Download, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';

type ClientStatus = 'prospect' | 'onboarding' | 'active' | 'inactive' | 'archived';
type BillingModel = 'hourly' | 'fixed' | 'retainer';
type StatusFilter = 'all' | ClientStatus;

interface PracticeClient {
  id: string;
  legalName: string;
  tradingName: string | null;
  registrationNo: string | null;
  taxNo: string | null;
  billingModel: BillingModel;
  status: ClientStatus;
}

const STATUS_LABELS: Record<ClientStatus, string> = {
  prospect: 'Prospect',
  onboarding: 'Onboarding',
  active: 'Active',
  inactive: 'Inactive',
  archived: 'Archived',
};

const STATUS_COLOURS: Record<ClientStatus, string> = {
  prospect: 'bg-blue-500/20 text-blue-400',
  onboarding: 'bg-yellow-500/20 text-yellow-400',
  active: 'bg-teal-500/20 text-teal-400',
  inactive: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  archived: 'bg-red-500/20 text-red-400',
};

const BILLING_LABELS: Record<BillingModel, string> = {
  hourly: 'Hourly',
  fixed: 'Fixed',
  retainer: 'Retainer',
};

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'archived', label: 'Archived' },
];

function StatusBadge({ status }: { status: ClientStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export default function PracticeClientsPage() {
  const router = useRouter();
  const [clients, setClients] = useState<PracticeClient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<
    | { created: number; skipped: number; errors: { rowNumber: number; message: string }[] }
    | null
  >(null);
  const [importError, setImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadClients = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('search', debouncedSearch);
      const res = await apiFetch(`/api/accounting/practice/clients?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const payload = json.data ?? json;
      setClients((payload?.clients ?? payload ?? []) as PracticeClient[]);
    } catch {
      setError('Failed to load clients');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  function handleRowClick(id: string) {
    void router.push(`/accounting/practice/clients/${id}`);
  }

  async function handleExport() {
    setExporting(true);
    try {
      const ids = clients.map((c) => c.id);
      const res = await apiFetch('/api/accounting/practice/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'export', ids }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'practice-clients-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to export');
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const csv = await file.text();
      const res = await apiFetch('/api/accounting/practice/clients/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'import', csv }),
      });
      const json = await res.json();
      if (!res.ok) {
        setImportError(json?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      const payload = json.data ?? json;
      setImportResult(payload);
      if (payload.created > 0) loadClients();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-5 w-5 text-teal-400" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Clients</h1>
                <p className="text-xs text-[var(--ff-text-tertiary)]">Practice client management</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleImportFile(f);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm font-medium transition-colors disabled:opacity-50"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import CSV
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={exporting || clients.length === 0}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm font-medium transition-colors disabled:opacity-50"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Export CSV
              </button>
              <Link
                href="/accounting/practice/clients/new"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add Client
              </Link>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-6">
          {/* Filters */}
          <div className="flex items-center gap-3 mb-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or reg no..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-72 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
            >
              {STATUS_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {clients.length} client{clients.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : clients.length === 0 ? (
            <div className="text-center py-16">
              <Users className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No clients found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                {search || statusFilter !== 'all'
                  ? 'Try adjusting your search or filter'
                  : 'Add your first practice client to get started'}
              </p>
              {!search && statusFilter === 'all' && (
                <Link
                  href="/accounting/practice/clients/new"
                  className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Add Client
                </Link>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Legal Name</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Reg No</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Tax No</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Billing</th>
                    <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => handleRowClick(c.id)}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-teal-500/[0.04] transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-4">
                        <span className="font-medium text-[var(--ff-text-primary)]">{c.legalName}</span>
                        {c.tradingName && (
                          <div className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">{c.tradingName}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.registrationNo ?? '—'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.taxNo ?? '—'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{BILLING_LABELS[c.billingModel]}</td>
                      <td className="py-3 px-4">
                        <StatusBadge status={c.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {(importResult || importError) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-primary)]">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">
                {importError ? 'Import failed' : 'Import results'}
              </h2>
              <button
                type="button"
                onClick={() => { setImportResult(null); setImportError(''); }}
                className="text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4 max-h-[60vh] overflow-y-auto text-sm">
              {importError && (
                <p className="text-red-400">{importError}</p>
              )}
              {importResult && (
                <>
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div className="rounded-md bg-[var(--ff-bg-tertiary)] p-3">
                      <div className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide">Created</div>
                      <div className="text-lg font-semibold text-teal-400">{importResult.created}</div>
                    </div>
                    <div className="rounded-md bg-[var(--ff-bg-tertiary)] p-3">
                      <div className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide">Skipped</div>
                      <div className="text-lg font-semibold text-yellow-400">{importResult.skipped}</div>
                    </div>
                    <div className="rounded-md bg-[var(--ff-bg-tertiary)] p-3">
                      <div className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide">Errors</div>
                      <div className="text-lg font-semibold text-red-400">{importResult.errors.length}</div>
                    </div>
                  </div>
                  {importResult.errors.length > 0 && (
                    <div>
                      <div className="text-xs text-[var(--ff-text-secondary)] mb-1">Errors</div>
                      <ul className="space-y-1 text-xs text-red-300">
                        {importResult.errors.map((e, idx) => (
                          <li key={idx}>
                            {e.rowNumber > 0 ? `Row ${e.rowNumber}: ` : ''}{e.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
