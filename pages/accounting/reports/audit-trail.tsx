/**
 * Audit Trail Report Page
 * Phase 3: Full GL journal entry audit trail
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Shield, Loader2, AlertCircle, Download } from 'lucide-react';

interface AuditRow {
  entryDate: string;
  entryNumber: string;
  description: string;
  source: string;
  status: string;
  totalDebit: number;
  totalCredit: number;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const SOURCE_BADGE: Record<string, string> = {
  manual: 'bg-gray-500/10 text-gray-400',
  auto_invoice: 'bg-blue-500/10 text-blue-400',
  auto_payment: 'bg-emerald-500/10 text-emerald-400',
  auto_grn: 'bg-orange-500/10 text-orange-400',
  auto_credit_note: 'bg-red-500/10 text-red-400',
  auto_purchase_order: 'bg-indigo-500/10 text-indigo-400',
  auto_depreciation: 'bg-purple-500/10 text-purple-400',
  auto_write_off: 'bg-amber-500/10 text-amber-400',
  auto_adjustment: 'bg-yellow-500/10 text-yellow-400',
  auto_vat_adjustment: 'bg-teal-500/10 text-teal-400',
  auto_batch_payment: 'bg-cyan-500/10 text-cyan-400',
  auto_recurring: 'bg-pink-500/10 text-pink-400',
};

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  posted: 'bg-emerald-500/10 text-emerald-400',
  reversed: 'bg-red-500/10 text-red-400',
};

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: start.toISOString().split('T')[0], periodEnd: now.toISOString().split('T')[0] };
}

export default function AuditTrailPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      const res = await fetch(`/api/accounting/reports-audit-trail?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setRows(json.data || []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd]);

  useEffect(() => { load(); }, [load]);

  const filteredRows = rows.filter(r => {
    if (sourceFilter && r.source !== sourceFilter) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    return true;
  });

  function handleExport() {
    const params = new URLSearchParams();
    params.set('period_start', periodStart ?? '');
    params.set('period_end', periodEnd ?? '');
    window.location.href = `/api/accounting/audit-trail-export?${params}`;
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><Shield className="h-6 w-6 text-amber-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Audit Trail</h1>
            </div>
            <button onClick={handleExport} disabled={rows.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-medium disabled:opacity-50">
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Source</label>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="ff-select text-sm">
                <option value="">All Sources</option>
                {Object.keys(SOURCE_BADGE).map(s => <option key={s} value={s}>{s.replace('auto_', '')}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Status</label>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
                <option value="">All Statuses</option>
                <option value="draft">Draft</option>
                <option value="posted">Posted</option>
                <option value="reversed">Reversed</option>
              </select>
            </div>
            <div className="ml-auto text-sm text-[var(--ff-text-secondary)] mt-4">
              {filteredRows.length} entries
            </div>
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-amber-500" /></div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Entry</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Debit</th>
                  <th className="px-4 py-3 text-right">Credit</th>
                  <th className="px-4 py-3">Created By</th>
                </tr></thead>
                <tbody>
                  {filteredRows.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No entries for period</td></tr>}
                  {filteredRows.map((r, i) => (
                    <tr key={i} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                      <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{r.entryDate}</td>
                      <td className="px-4 py-2 text-[var(--ff-text-primary)] font-mono text-xs">{r.entryNumber}</td>
                      <td className="px-4 py-2 text-[var(--ff-text-primary)] truncate max-w-[250px]">{r.description}</td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium ${SOURCE_BADGE[r.source] || 'bg-gray-500/10 text-gray-400'}`}>{r.source.replace('auto_', '')}</span></td>
                      <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[r.status] || ''}`}>{r.status}</span></td>
                      <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(r.totalDebit)}</td>
                      <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">{fmt(r.totalCredit)}</td>
                      <td className="px-4 py-2 text-[var(--ff-text-secondary)] text-xs truncate max-w-[120px]">{r.createdBy}</td>
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
