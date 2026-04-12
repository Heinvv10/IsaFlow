/**
 * Supplier Credit Notes — List Page
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FileText, Plus, Loader2, AlertCircle, Download } from 'lucide-react';
import type { CreditNote } from '@/modules/accounting/types/ar.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

const TABS = ['all', 'draft', 'approved', 'applied', 'cancelled'] as const;
type Tab = typeof TABS[number];

const STATUS_CLS: Record<string, string> = {
  draft:     'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  approved:  'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  applied:   'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  cancelled: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_CLS[status] ?? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
      {status}
    </span>
  );
}

export default function SupplierCreditNotesPage() {
  const router = useRouter();
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<Tab>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadCreditNotes = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      const res = await apiFetch(`/api/accounting/supplier-credit-notes?${params.toString()}`);
      const json = await res.json() as { data?: { creditNotes?: CreditNote[]; total?: number } };
      const payload = json.data ?? {};
      setCreditNotes(payload.creditNotes ?? []);
      setTotal(payload.total ?? 0);
    } catch {
      setError('Failed to load supplier credit notes');
    } finally {
      setIsLoading(false);
    }
  }, [tab]);

  useEffect(() => { void loadCreditNotes(); }, [loadCreditNotes]);

  const exportCSV = () => {
    const headers = ['CN #', 'Supplier', 'Invoice', 'Date', 'Amount', 'Status'];
    const rows = creditNotes.map(cn => [
      cn.creditNoteNumber, cn.supplierName ?? '',
      cn.invoiceNumber ?? '',
      new Date(cn.creditDate).toLocaleDateString('en-ZA'),
      cn.totalAmount, cn.status,
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `supplier-credit-notes-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Hero header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Suppliers</p>
              <h1 className="text-2xl font-bold text-white">Supplier Credit Notes</h1>
              <p className="text-slate-400 text-sm mt-0.5">{total} credit note{total !== 1 ? 's' : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              {creditNotes.length > 0 && (
                <button onClick={exportCSV} className="flex items-center gap-2 px-3 py-2.5 bg-white/10 hover:bg-white/15 text-white rounded-xl text-sm font-medium transition-colors">
                  <Download className="w-4 h-4" /> CSV
                </button>
              )}
              <Link href="/accounting/supplier-credit-notes/new" className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25">
                <Plus className="w-4 h-4" /> New Credit Note
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filter tabs */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{t}</button>
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-16 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : creditNotes.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <FileText className="w-7 h-7 text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No credit notes found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first supplier credit note</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['CN #', 'Supplier', 'Invoice', 'Date', 'Amount', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {creditNotes.map(cn => (
                    <tr
                      key={cn.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer"
                      onClick={() => { void router.push(`/accounting/supplier-credit-notes/${cn.id}`); }}
                    >
                      <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{cn.creditNoteNumber}</td>
                      <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{cn.supplierName ?? '—'}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 font-mono text-xs">{cn.invoiceNumber ?? '—'}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">
                        {new Date(cn.creditDate).toLocaleDateString('en-ZA')}
                      </td>
                      <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">
                        {formatCurrency(cn.totalAmount)}
                      </td>
                      <td className="px-5 py-3.5"><StatusBadge status={cn.status} /></td>
                      <td className="px-4 py-3.5 text-right text-slate-400">›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
