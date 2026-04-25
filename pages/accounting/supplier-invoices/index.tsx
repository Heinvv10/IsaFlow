/**
 * Supplier Invoices List Page — coordinator.
 *
 * State + URL persistence: useSupplierInvoiceListState
 * Filter UI: <FilterBar />
 * Tabs:     <StatusTabs />
 * Bulk:     <BulkActionBar />
 * Table:    <InvoiceTable />
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Download, Loader2, Plus } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import { useSupplierInvoiceListState } from '@/components/accounting/supplier-invoices/useSupplierInvoiceListState';
import { FilterBar } from '@/components/accounting/supplier-invoices/FilterBar';
import { StatusTabs } from '@/components/accounting/supplier-invoices/StatusTabs';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';
import { InvoiceTable } from '@/components/accounting/supplier-invoices/InvoiceTable';

interface ListResult {
  invoices: SupplierInvoice[];
  total: number;
}

type BulkAction = 'approve' | 'post_gl' | 'cancel';

export default function SupplierInvoicesPage() {
  const state = useSupplierInvoiceListState();
  const { filters, hydrated, filtersActive } = state;

  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkAction | null>(null);

  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (filters.tab !== 'all') p.set('status', filters.tab);
    if (filters.search) p.set('search', filters.search);
    if (filters.supplierId) p.set('supplier_id', filters.supplierId);
    if (filters.fromDate) p.set('from_date', filters.fromDate);
    if (filters.toDate) p.set('to_date', filters.toDate);
    if (filters.fromAmount) p.set('from_amount', filters.fromAmount);
    if (filters.toAmount) p.set('to_amount', filters.toAmount);
    if (filters.fromBalance) p.set('from_balance', filters.fromBalance);
    if (filters.toBalance) p.set('to_balance', filters.toBalance);
    p.set('sort', filters.sort);
    p.set('sort_order', filters.sortOrder);
    p.set('limit', String(filters.perPage));
    p.set('offset', String((filters.page - 1) * filters.perPage));
    return p;
  }, [filters]);

  const loadInvoices = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices?${listParams}`);
      const json = await res.json();
      const payload = (json.data || json) as ListResult;
      setInvoices(payload.invoices || []);
      setTotal(payload.total || 0);
      setSelected(new Set());
    } catch (err) {
      log.warn('Failed to load supplier invoices', { error: err }, 'supplier-invoices');
      setError('Failed to load supplier invoices');
    } finally {
      setIsLoading(false);
    }
  }, [listParams]);

  const loadCounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices?status_counts=1');
      const json = await res.json();
      const data = (json.data || json) as { counts: Record<string, number> };
      setCounts(data.counts || {});
    } catch (err) {
      // Tab badges are nice-to-have — surface in logs but don't break the page.
      log.warn('Failed to load supplier invoice status counts', { error: err }, 'supplier-invoices');
    }
  }, []);

  useEffect(() => { if (hydrated) void loadInvoices(); }, [hydrated, loadInvoices]);
  useEffect(() => { void loadCounts(); }, [loadCounts]);

  const toggleRow = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => prev.size === invoices.length ? new Set() : new Set(invoices.map((i) => i.id)));
  }, [invoices]);

  const onBulkComplete = useCallback(async () => {
    await loadInvoices();
    await loadCounts();
  }, [loadInvoices, loadCounts]);

  function exportCsv() {
    const p = new URLSearchParams(listParams);
    p.delete('limit');
    p.delete('offset');
    window.open(`/api/accounting/supplier-invoices-export?${p.toString()}`, '_blank');
  }

  if (!hydrated) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <Header total={total} filtersActive={filtersActive} onExport={exportCsv} />

        <div className="p-6 space-y-4">
          <StatusTabs active={filters.tab} counts={counts} onChange={state.setTab} />

          <FilterBar
            filters={filters}
            filtersActive={filtersActive}
            setSearch={state.setSearch}
            selectSupplier={state.selectSupplier}
            clearSupplier={state.clearSupplier}
            setDatePreset={state.setDatePreset}
            setCustomDate={state.setCustomDate}
            setAmountRange={state.setAmountRange}
            resetFilters={state.resetFilters}
          />

          <BulkActionBar
            selected={selected}
            busy={bulkBusy}
            onBusyChange={setBulkBusy}
            onError={setError}
            onComplete={onBulkComplete}
            onClear={() => setSelected(new Set())}
          />

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-16 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" />
              </div>
            ) : (
              <InvoiceTable
                invoices={invoices}
                selected={selected}
                toggleRow={toggleRow}
                toggleAll={toggleAll}
                sort={filters.sort}
                sortOrder={filters.sortOrder}
                onSort={state.toggleSort}
                page={filters.page}
                perPage={filters.perPage}
                total={total}
                onPage={state.setPage}
                onPerPage={state.setPerPage}
                filtersActive={filtersActive}
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function Header({ total, filtersActive, onExport }: { total: number; filtersActive: boolean; onExport: () => void }) {
  return (
    <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
      <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
      <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="relative z-10 flex items-center justify-between">
        <div>
          <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Suppliers</p>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Supplier Invoices</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
            {total} {total === 1 ? 'invoice' : 'invoices'}{filtersActive ? ' (filtered)' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-2 px-3 py-2.5 bg-slate-800/70 hover:bg-slate-700 text-slate-200 rounded-xl text-sm font-medium transition-colors border border-slate-700"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          <Link
            href="/accounting/supplier-invoices/new"
            className="flex items-center gap-2 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-teal-500/25"
          >
            <Plus className="w-4 h-4" /> New Invoice
          </Link>
        </div>
      </div>
    </div>
  );
}
