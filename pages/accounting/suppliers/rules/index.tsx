/**
 * Company-wide Supplier Coding Rules — PRD-05 Phase 3
 * Lists all configured supplier rules. Click a row to edit.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2, AlertCircle, Search, ChevronRight, Settings2 } from 'lucide-react';

interface SupplierRule {
  id: string;
  supplierId: string;
  supplierName?: string;
  defaultGlAccountId: string | null;
  defaultGlAccountName?: string | null;
  defaultVatCode: string | null;
  autoPublish: boolean;
  autoPublishMaxAmount: number | null;
  autoPublishMinConfidence: number;
  learnedSampleCount: number;
  updatedAt: string;
}

function fmtDate(val: string | Date | null): string {
  if (!val) return '—';
  try { return new Date(val).toLocaleDateString('en-ZA'); } catch { return String(val); }
}

function fmtZAR(val: number | null): string {
  if (val == null) return '—';
  return `R ${val.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function VatBadge({ code }: { code: string | null }) {
  if (!code) return <span className="text-[var(--ff-text-tertiary)]">—</span>;
  const map: Record<string, string> = {
    STD_RATE:   'bg-blue-900/40 text-blue-300',
    ZERO_RATED: 'bg-slate-700 text-slate-300',
    EXEMPT:     'bg-slate-800 text-slate-400',
  };
  const label: Record<string, string> = { STD_RATE: 'Std', ZERO_RATED: 'Zero', EXEMPT: 'Exempt' };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${map[code] ?? 'bg-slate-700 text-slate-300'}`}>
      {label[code] ?? code}
    </span>
  );
}

export default function SupplierRulesIndexPage() {
  const [rules, setRules]       = useState<SupplierRule[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [search, setSearch]     = useState('');
  const [autoOnly, setAutoOnly] = useState(false);

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-rules');
      const json = await res.json() as { data?: SupplierRule[]; error?: string };
      if (!res.ok) { setError(json.error ?? 'Failed to load rules'); return; }
      setRules(json.data ?? []);
      setError('');
    } catch {
      setError('Network error loading rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRules(); }, [loadRules]);

  const filtered = rules.filter(r => {
    if (autoOnly && !r.autoPublish) return false;
    if (search) {
      const s = search.toLowerCase();
      return (r.supplierName ?? '').toLowerCase().includes(s);
    }
    return true;
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-5">
          <div className="flex items-center gap-3 mb-1">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Settings2 className="h-5 w-5 text-blue-500" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Coding Rules</h1>
          </div>
          <p className="text-sm text-[var(--ff-text-secondary)] ml-12">
            Default GL accounts, VAT codes, and auto-publish settings per supplier.
          </p>
        </div>

        <div className="px-6 py-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search supplier…"
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-slate-600 focus:outline-none focus:border-blue-500" />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={autoOnly} onChange={e => setAutoOnly(e.target.checked)}
                className="accent-teal-500 w-4 h-4" />
              <span className="text-sm text-[var(--ff-text-secondary)]">Auto-publish only</span>
            </label>
            <span className="ml-auto text-xs text-[var(--ff-text-tertiary)]">{filtered.length} rule{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/30 text-red-400 text-sm mb-4">
              <AlertCircle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20 text-[var(--ff-text-tertiary)]">
              {rules.length === 0 ? 'No coding rules configured yet.' : 'No rules match the current filter.'}
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-[var(--ff-text-tertiary)] text-xs uppercase">
                    <th className="px-4 py-3 text-left font-medium">Supplier</th>
                    <th className="px-4 py-3 text-left font-medium">GL Account</th>
                    <th className="px-4 py-3 text-left font-medium">VAT</th>
                    <th className="px-4 py-3 text-left font-medium">Auto-publish</th>
                    <th className="px-4 py-3 text-left font-medium">Cap</th>
                    <th className="px-4 py-3 text-left font-medium">Min Conf.</th>
                    <th className="px-4 py-3 text-left font-medium">Samples</th>
                    <th className="px-4 py-3 text-left font-medium">Updated</th>
                    <th className="px-2 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={r.id}
                      className="border-b border-[var(--ff-border-light)] last:border-0 hover:bg-white/5 transition-colors cursor-pointer"
                      onClick={() => void (window.location.href = `/accounting/suppliers/${r.supplierId}/rules`)}>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                        {r.supplierName ?? r.supplierId}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        {r.defaultGlAccountName ?? (r.defaultGlAccountId ? r.defaultGlAccountId.slice(0, 8) + '…' : '—')}
                      </td>
                      <td className="px-4 py-3"><VatBadge code={r.defaultVatCode} /></td>
                      <td className="px-4 py-3">
                        {r.autoPublish
                          ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-teal-500/20 text-teal-400">Yes</span>
                          : <span className="text-[var(--ff-text-tertiary)]">No</span>}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{fmtZAR(r.autoPublishMaxAmount)}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        {Math.round(r.autoPublishMinConfidence * 100)}%
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.learnedSampleCount}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{fmtDate(r.updatedAt)}</td>
                      <td className="px-2 py-3 text-slate-600">
                        <Link href={`/accounting/suppliers/${r.supplierId}/rules`}
                          onClick={e => e.stopPropagation()}
                          className="hover:text-blue-400 transition-colors">
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
