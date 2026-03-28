/**
 * Supplier Statements List
 * AP equivalent of Customer Statements — shows balances by supplier
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ClipboardList, Loader2, AlertCircle, Download, ChevronRight, Search } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface SupplierBalance {
  entityId: string;
  entityName: string;
  current: number;
  days30: number;
  days60: number;
  days90: number;
  days120Plus: number;
  total: number;
}

export default function SupplierStatementsPage() {
  const [suppliers, setSuppliers] = useState<SupplierBalance[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0]);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (asAtDate) params.set('as_at_date', asAtDate);
      const res = await apiFetch(`/api/accounting/ap-aging?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setSuppliers(Array.isArray(data) ? data : []);
    } catch {
      setError('Failed to load supplier balances');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate]);

  useEffect(() => { load(); }, [load]);

  function handleExportAll() {
    if (suppliers.length === 0) return;
    const header = 'Supplier,Current,1-30,31-60,61-90,90+,Total';
    const rows = suppliers.map(s =>
      [`"${s.entityName}"`, s.current.toFixed(2), s.days30.toFixed(2), s.days60.toFixed(2),
       s.days90.toFixed(2), s.days120Plus.toFixed(2), s.total.toFixed(2)].join(',')
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supplier-statements-${asAtDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const filteredSuppliers = useMemo(() => {
    if (!search.trim()) return suppliers;
    const q = search.toLowerCase();
    return suppliers.filter(s => s.entityName.toLowerCase().includes(q));
  }, [suppliers, search]);

  const totals = filteredSuppliers.reduce(
    (acc, s) => ({
      current: acc.current + s.current,
      days30: acc.days30 + s.days30,
      days60: acc.days60 + s.days60,
      days90: acc.days90 + s.days90,
      days120Plus: acc.days120Plus + s.days120Plus,
      total: acc.total + s.total,
    }),
    { current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 0 }
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <ClipboardList className="h-6 w-6 text-orange-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Statements</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Accounts payable balances and transaction history
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-4 flex-wrap">
            <label htmlFor="asAtDate" className="text-sm text-[var(--ff-text-secondary)]">As at:</label>
            <input id="asAtDate" type="date" value={asAtDate} onChange={e => setAsAtDate(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              aria-label="Statement date" />
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search supplier..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 pr-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm placeholder:text-[var(--ff-text-tertiary)] w-48"
              />
            </div>
            {suppliers.length > 0 && (
              <button onClick={handleExportAll}
                className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-sm font-medium">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
            </div>
          ) : filteredSuppliers.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)]">
              No outstanding supplier balances
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Supplier</th>
                    <th className="text-right px-4 py-3 text-teal-400 font-medium">Current</th>
                    <th className="text-right px-4 py-3 text-amber-400 font-medium">1-30</th>
                    <th className="text-right px-4 py-3 text-orange-400 font-medium">31-60</th>
                    <th className="text-right px-4 py-3 text-red-400 font-medium">61-90</th>
                    <th className="text-right px-4 py-3 text-purple-400 font-medium">90+</th>
                    <th className="text-right px-4 py-3 text-[var(--ff-text-secondary)] font-medium">Total</th>
                    <th className="text-center px-4 py-3 w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSuppliers.map(s => (
                    <tr key={s.entityId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                        <Link href={`/accounting/supplier-statements/${s.entityId}`} className="hover:text-orange-400 transition-colors">
                          {s.entityName}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(s.current)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-400">{formatCurrency(s.days30)}</td>
                      <td className="px-4 py-3 text-right font-mono text-orange-400">{formatCurrency(s.days60)}</td>
                      <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(s.days90)}</td>
                      <td className="px-4 py-3 text-right font-mono text-purple-400">{formatCurrency(s.days120Plus)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-[var(--ff-text-primary)]">{formatCurrency(s.total)}</td>
                      <td className="px-4 py-3 text-center">
                        <Link href={`/accounting/supplier-statements/${s.entityId}`}
                          className="inline-flex items-center justify-center px-4 py-3 rounded-lg text-orange-400 hover:bg-orange-500/10 hover:text-orange-300 transition-colors"
                          title={`View ${s.entityName} statement`}>
                          <ChevronRight className="h-5 w-5" />
                          <span className="sr-only">View details</span>
                        </Link>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-[var(--ff-bg-primary)] font-bold">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                    <td className="px-4 py-3 text-right font-mono text-teal-400">{formatCurrency(totals.current)}</td>
                    <td className="px-4 py-3 text-right font-mono text-amber-400">{formatCurrency(totals.days30)}</td>
                    <td className="px-4 py-3 text-right font-mono text-orange-400">{formatCurrency(totals.days60)}</td>
                    <td className="px-4 py-3 text-right font-mono text-red-400">{formatCurrency(totals.days90)}</td>
                    <td className="px-4 py-3 text-right font-mono text-purple-400">{formatCurrency(totals.days120Plus)}</td>
                    <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(totals.total)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
