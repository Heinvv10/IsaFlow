/**
 * Supplier Invoices List Page
 * PRD-060 Phase 2: Accounts Payable
 *
 * Server-side search, supplier filter, date / amount / balance ranges,
 * sortable URL-driven columns, pagination, bulk actions, CSV export.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  FileText, Plus, Loader2, AlertCircle, ChevronRight, ChevronLeft,
  ChevronsLeft, ChevronsRight, ArrowUp, ArrowDown, ArrowUpDown,
  Search, X, Download, RotateCcw,
} from 'lucide-react';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { StatusPill } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';

const TABS = ['all', 'draft', 'pending_approval', 'approved', 'partially_paid', 'paid', 'disputed', 'cancelled'] as const;
type Tab = typeof TABS[number];

type SortKey = 'invoice_number' | 'supplier_name' | 'reference' | 'invoice_date' | 'total_amount' | 'balance' | 'status';
type SortOrder = 'asc' | 'desc';
type DatePreset = 'all' | 'this_month' | 'last_month' | 'last_30_days' | 'this_fy' | 'last_fy' | 'custom';

const TAB_LABEL: Record<Tab, string> = {
  all: 'All',
  draft: 'Draft',
  pending_approval: 'Pending',
  approved: 'Approved',
  partially_paid: 'Partial',
  paid: 'Paid',
  disputed: 'Disputed',
  cancelled: 'Cancelled',
};

const PER_PAGE_OPTIONS = [25, 50, 100, 200];

interface SupplierOption {
  id: string;
  name: string;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function isoDate(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// SA fiscal year: 1 March – 28/29 February
function fyStart(forDate: Date): Date {
  const y = forDate.getMonth() < 2 ? forDate.getFullYear() - 1 : forDate.getFullYear();
  return new Date(y, 2, 1);
}
function fyEnd(forDate: Date): Date {
  const start = fyStart(forDate);
  return new Date(start.getFullYear() + 1, 1, 28); // 28 Feb of following year (Mar..Feb FY)
}

function presetToRange(preset: DatePreset): { from?: string; to?: string } {
  const now = new Date();
  switch (preset) {
    case 'this_month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { from: isoDate(from), to: isoDate(to) };
    }
    case 'last_month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: isoDate(from), to: isoDate(to) };
    }
    case 'last_30_days': {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);
      return { from: isoDate(from), to: isoDate(to) };
    }
    case 'this_fy': {
      return { from: isoDate(fyStart(now)), to: isoDate(fyEnd(now)) };
    }
    case 'last_fy': {
      const start = fyStart(now);
      start.setFullYear(start.getFullYear() - 1);
      const end = new Date(start.getFullYear() + 1, 1, 28);
      return { from: isoDate(start), to: isoDate(end) };
    }
    default:
      return {};
  }
}

function StatusBadge({ status }: { status: string }) {
  return <StatusPill status={status} />;
}

interface ListResult {
  invoices: SupplierInvoice[];
  total: number;
}

export default function SupplierInvoicesPage() {
  const router = useRouter();

  // ── URL-driven state ──
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [supplierId, setSupplierId] = useState<string>('');
  const [supplierLabel, setSupplierLabel] = useState<string>('');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [fromAmount, setFromAmount] = useState<string>('');
  const [toAmount, setToAmount] = useState<string>('');
  const [fromBalance, setFromBalance] = useState<string>('');
  const [toBalance, setToBalance] = useState<string>('');
  const [sort, setSort] = useState<SortKey>('invoice_date');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);

  // ── Data state ──
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  // Supplier typeahead
  const [supplierQuery, setSupplierQuery] = useState('');
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [showSupplierDropdown, setShowSupplierDropdown] = useState(false);
  const supplierBoxRef = useRef<HTMLDivElement | null>(null);

  // ── Hydrate from URL on mount / route change ──
  const urlReady = router.isReady;
  useEffect(() => {
    if (!urlReady) return;
    const q = router.query;
    const pickStr = (k: string): string => (typeof q[k] === 'string' ? (q[k] as string) : '');
    const tabParam = pickStr('status') as Tab;
    setTab(TABS.includes(tabParam) ? tabParam : 'all');
    setSearch(pickStr('search'));
    setSearchInput(pickStr('search'));
    setSupplierId(pickStr('supplier_id'));
    setSupplierLabel(pickStr('supplier_label'));
    setDatePreset((pickStr('date_preset') as DatePreset) || 'all');
    setFromDate(pickStr('from_date'));
    setToDate(pickStr('to_date'));
    setFromAmount(pickStr('from_amount'));
    setToAmount(pickStr('to_amount'));
    setFromBalance(pickStr('from_balance'));
    setToBalance(pickStr('to_balance'));
    const s = pickStr('sort');
    if (['invoice_number', 'supplier_name', 'reference', 'invoice_date', 'total_amount', 'balance', 'status'].includes(s)) {
      setSort(s as SortKey);
    }
    const so = pickStr('sort_order');
    setSortOrder(so === 'asc' ? 'asc' : 'desc');
    const p = Number(pickStr('page')) || 1;
    setPage(Math.max(1, p));
    const pp = Number(pickStr('per_page')) || 50;
    setPerPage(PER_PAGE_OPTIONS.includes(pp) ? pp : 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlReady]);

  // ── Push state back to URL whenever it changes ──
  const syncUrl = useCallback(() => {
    if (!urlReady) return;
    const params: Record<string, string> = {};
    if (tab !== 'all') params.status = tab;
    if (search) params.search = search;
    if (supplierId) {
      params.supplier_id = supplierId;
      if (supplierLabel) params.supplier_label = supplierLabel;
    }
    if (datePreset !== 'all') params.date_preset = datePreset;
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;
    if (fromAmount) params.from_amount = fromAmount;
    if (toAmount) params.to_amount = toAmount;
    if (fromBalance) params.from_balance = fromBalance;
    if (toBalance) params.to_balance = toBalance;
    if (sort !== 'invoice_date') params.sort = sort;
    if (sortOrder !== 'desc') params.sort_order = sortOrder;
    if (page !== 1) params.page = String(page);
    if (perPage !== 50) params.per_page = String(perPage);
    void router.replace({ pathname: router.pathname, query: params }, undefined, { shallow: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlReady, tab, search, supplierId, supplierLabel, datePreset, fromDate, toDate,
      fromAmount, toAmount, fromBalance, toBalance, sort, sortOrder, page, perPage]);

  useEffect(() => { syncUrl(); }, [syncUrl]);

  // ── Debounce search input → search ──
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ── Build query params for the list API ──
  const listParams = useMemo(() => {
    const p = new URLSearchParams();
    if (tab !== 'all') p.set('status', tab);
    if (search) p.set('search', search);
    if (supplierId) p.set('supplier_id', supplierId);
    if (fromDate) p.set('from_date', fromDate);
    if (toDate) p.set('to_date', toDate);
    if (fromAmount) p.set('from_amount', fromAmount);
    if (toAmount) p.set('to_amount', toAmount);
    if (fromBalance) p.set('from_balance', fromBalance);
    if (toBalance) p.set('to_balance', toBalance);
    p.set('sort', sort);
    p.set('sort_order', sortOrder);
    p.set('limit', String(perPage));
    p.set('offset', String((page - 1) * perPage));
    return p;
  }, [tab, search, supplierId, fromDate, toDate, fromAmount, toAmount,
      fromBalance, toBalance, sort, sortOrder, page, perPage]);

  // ── Load list ──
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
    } catch {
      setError('Failed to load supplier invoices');
    } finally {
      setIsLoading(false);
    }
  }, [listParams]);

  useEffect(() => { void loadInvoices(); }, [loadInvoices]);

  // ── Load tab counts (single call) ──
  const loadCounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices?status_counts=1');
      const json = await res.json();
      const data = (json.data || json) as { counts: Record<string, number> };
      setCounts(data.counts || {});
    } catch {
      // counts are nice-to-have; silent failure is fine
    }
  }, []);

  useEffect(() => { void loadCounts(); }, [loadCounts]);

  // ── Supplier typeahead ──
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = supplierQuery.trim();
      try {
        const url = q
          ? `/api/accounting/suppliers-list?q=${encodeURIComponent(q)}&limit=25`
          : '/api/accounting/suppliers-list?limit=25';
        const res = await apiFetch(url);
        const json = await res.json();
        const data = (json.data || json) as { suppliers?: { id: string; name: string }[] };
        if (!cancelled) {
          setSupplierOptions((data.suppliers || []).map((s) => ({ id: s.id, name: s.name })));
        }
      } catch {
        if (!cancelled) setSupplierOptions([]);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [supplierQuery]);

  // Close supplier dropdown on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (supplierBoxRef.current && !supplierBoxRef.current.contains(e.target as Node)) {
        setShowSupplierDropdown(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // ── Helpers ──
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const visibleStart = total === 0 ? 0 : (page - 1) * perPage + 1;
  const visibleEnd = Math.min(page * perPage, total);

  function applyDatePreset(preset: DatePreset) {
    setDatePreset(preset);
    setPage(1);
    if (preset === 'all') { setFromDate(''); setToDate(''); return; }
    if (preset === 'custom') return;
    const r = presetToRange(preset);
    setFromDate(r.from || '');
    setToDate(r.to || '');
  }

  function toggleSort(col: SortKey) {
    if (sort === col) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(col);
      setSortOrder(col === 'invoice_date' ? 'desc' : 'asc');
    }
    setPage(1);
  }

  function resetFilters() {
    setTab('all');
    setSearch('');
    setSearchInput('');
    setSupplierId('');
    setSupplierLabel('');
    setSupplierQuery('');
    setDatePreset('all');
    setFromDate('');
    setToDate('');
    setFromAmount('');
    setToAmount('');
    setFromBalance('');
    setToBalance('');
    setSort('invoice_date');
    setSortOrder('desc');
    setPage(1);
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      if (prev.size === invoices.length) return new Set();
      return new Set(invoices.map((i) => i.id));
    });
  }

  async function runBulkAction(action: 'approve' | 'post_gl' | 'cancel') {
    if (selected.size === 0) return;
    const verb = action === 'post_gl' ? 'post to GL' : action;
    if (!window.confirm(`${verb} ${selected.size} invoice(s)?`)) return;
    setBulkBusy(action);
    setError('');
    try {
      const ids = Array.from(selected);
      const results = await Promise.allSettled(ids.map((id) =>
        apiFetch('/api/accounting/supplier-invoices-action', {
          method: 'POST',
          body: JSON.stringify({ action, invoiceId: id }),
        }).then(async (r) => {
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            throw new Error(j.error || j.message || `${action} failed`);
          }
          return true;
        }),
      ));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        setError(`${failed} of ${ids.length} ${action}s failed`);
      }
      await loadInvoices();
      await loadCounts();
    } finally {
      setBulkBusy(null);
    }
  }

  function exportCsv() {
    const p = new URLSearchParams(listParams);
    p.delete('limit');
    p.delete('offset');
    const url = `/api/accounting/supplier-invoices-export?${p.toString()}`;
    window.open(url, '_blank');
  }

  const filtersActive = tab !== 'all' || !!search || !!supplierId || datePreset !== 'all'
    || !!fromAmount || !!toAmount || !!fromBalance || !!toBalance;

  // ── Render ──
  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Suppliers</p>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Supplier Invoices</h1>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
                {total} {total === 1 ? 'invoice' : 'invoices'}
                {filtersActive ? ' (filtered)' : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exportCsv}
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

        <div className="p-6 space-y-4">
          {/* Status tabs with counts */}
          <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
            {TABS.map((t) => {
              const c = counts[t];
              return (
                <button
                  key={t}
                  onClick={() => { setTab(t); setPage(1); }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex items-center gap-1.5 ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <span>{TAB_LABEL[t]}</span>
                  {typeof c === 'number' && (
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tab === t ? 'bg-white/25 text-white' : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400'}`}>
                      {c}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Filter bar */}
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              {/* Search */}
              <div className="relative flex-1 min-w-[240px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                <input
                  type="text"
                  name="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search invoice #, supplier, reference, notes…"
                  className="w-full pl-9 pr-9 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                />
                {searchInput && (
                  <button
                    onClick={() => { setSearchInput(''); setSearch(''); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Supplier typeahead */}
              <div ref={supplierBoxRef} className="relative w-64">
                <input
                  type="text"
                  name="supplier"
                  value={supplierLabel || supplierQuery}
                  onChange={(e) => {
                    setSupplierLabel('');
                    setSupplierId('');
                    setSupplierQuery(e.target.value);
                    setShowSupplierDropdown(true);
                  }}
                  onFocus={() => setShowSupplierDropdown(true)}
                  placeholder="Filter by supplier…"
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                />
                {supplierId && (
                  <button
                    onClick={() => { setSupplierId(''); setSupplierLabel(''); setSupplierQuery(''); setPage(1); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {showSupplierDropdown && supplierOptions.length > 0 && !supplierId && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl">
                    {supplierOptions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSupplierId(s.id);
                          setSupplierLabel(s.name);
                          setSupplierQuery('');
                          setShowSupplierDropdown(false);
                          setPage(1);
                        }}
                        className="block w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-amber-500/10"
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Date preset */}
              <select
                name="datePreset"
                value={datePreset}
                onChange={(e) => applyDatePreset(e.target.value as DatePreset)}
                className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
              >
                <option value="all">All dates</option>
                <option value="this_month">This month</option>
                <option value="last_month">Last month</option>
                <option value="last_30_days">Last 30 days</option>
                <option value="this_fy">This FY</option>
                <option value="last_fy">Last FY</option>
                <option value="custom">Custom</option>
              </select>

              {datePreset === 'custom' && (
                <>
                  <input
                    type="date"
                    name="fromDate"
                    value={fromDate}
                    onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
                    className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
                  />
                  <input
                    type="date"
                    name="toDate"
                    value={toDate}
                    onChange={(e) => { setToDate(e.target.value); setPage(1); }}
                    className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100"
                  />
                </>
              )}

              {filtersActive && (
                <button
                  onClick={resetFilters}
                  className="ml-auto flex items-center gap-1.5 px-3 py-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Reset filters
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="text-slate-500 dark:text-slate-400 font-medium">Total</span>
              <input
                type="number"
                name="fromAmount"
                value={fromAmount}
                onChange={(e) => { setFromAmount(e.target.value); setPage(1); }}
                placeholder="min"
                className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              />
              <span className="text-slate-400">–</span>
              <input
                type="number"
                name="toAmount"
                value={toAmount}
                onChange={(e) => { setToAmount(e.target.value); setPage(1); }}
                placeholder="max"
                className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              />
              <span className="text-slate-300 dark:text-slate-600">|</span>
              <span className="text-slate-500 dark:text-slate-400 font-medium">Outstanding</span>
              <input
                type="number"
                name="fromBalance"
                value={fromBalance}
                onChange={(e) => { setFromBalance(e.target.value); setPage(1); }}
                placeholder="min"
                className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              />
              <span className="text-slate-400">–</span>
              <input
                type="number"
                name="toBalance"
                value={toBalance}
                onChange={(e) => { setToBalance(e.target.value); setPage(1); }}
                placeholder="max"
                className="w-28 px-2 py-1.5 rounded-md bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-xl px-4 py-2.5">
              <span className="text-sm text-amber-700 dark:text-amber-300 font-medium">
                {selected.size} selected
              </span>
              <div className="flex gap-2 ml-auto">
                <button
                  onClick={() => runBulkAction('approve')}
                  disabled={bulkBusy !== null}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white transition-colors"
                >
                  {bulkBusy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
                <button
                  onClick={() => runBulkAction('post_gl')}
                  disabled={bulkBusy !== null}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors"
                >
                  {bulkBusy === 'post_gl' ? 'Posting…' : 'Post to GL'}
                </button>
                <button
                  onClick={() => runBulkAction('cancel')}
                  disabled={bulkBusy !== null}
                  className="px-3 py-1.5 text-xs font-semibold rounded-md bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white transition-colors"
                >
                  {bulkBusy === 'cancel' ? 'Cancelling…' : 'Cancel'}
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-md"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-16 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" />
              </div>
            ) : invoices.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <FileText className="w-7 h-7 text-slate-500 dark:text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No invoices found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  {filtersActive ? 'Try clearing some filters' : 'Record your first supplier invoice'}
                </p>
                {!filtersActive && (
                  <Link href="/accounting/supplier-invoices/new" className="inline-block mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">
                    New Invoice
                  </Link>
                )}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={selected.size === invoices.length && invoices.length > 0}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                      />
                    </th>
                    <SortHeader col="invoice_number" label="Invoice #" sort={sort} order={sortOrder} onClick={toggleSort} />
                    <SortHeader col="supplier_name" label="Supplier" sort={sort} order={sortOrder} onClick={toggleSort} />
                    <SortHeader col="reference" label="Reference" sort={sort} order={sortOrder} onClick={toggleSort} />
                    <SortHeader col="invoice_date" label="Date" sort={sort} order={sortOrder} onClick={toggleSort} />
                    <SortHeader col="total_amount" label="Total" sort={sort} order={sortOrder} onClick={toggleSort} align="right" />
                    <SortHeader col="balance" label="Outstanding" sort={sort} order={sortOrder} onClick={toggleSort} align="right" />
                    <SortHeader col="status" label="Status" sort={sort} order={sortOrder} onClick={toggleSort} />
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {invoices.map((inv) => {
                    const outstanding = inv.balance ?? (inv.totalAmount - (inv.amountPaid || 0));
                    const isSelected = selected.has(inv.id);
                    return (
                      <tr
                        key={inv.id}
                        className={`transition-colors ${isSelected ? 'bg-amber-500/5' : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'}`}
                      >
                        <td className="px-4 py-3.5">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(inv.id)}
                            className="h-4 w-4 rounded border-slate-300 dark:border-slate-600"
                          />
                        </td>
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="hover:underline">
                            {inv.invoiceNumber}
                          </Link>
                        </td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{inv.supplierName || '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title={inv.reference}>{inv.reference || '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{formatDate(inv.invoiceDate)}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{formatCurrency(inv.totalAmount)}</td>
                        <td className={`px-5 py-3.5 text-right font-mono font-semibold ${outstanding > 0 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {formatCurrency(outstanding)}
                        </td>
                        <td className="px-5 py-3.5"><StatusBadge status={inv.status} /></td>
                        <td className="px-4 py-3.5 text-right">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="text-slate-500 dark:text-slate-400 hover:text-amber-500 transition-colors">
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Pagination */}
            {!isLoading && total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/30 text-sm">
                <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
                  <span>Showing <span className="font-semibold text-slate-900 dark:text-white">{visibleStart}–{visibleEnd}</span> of <span className="font-semibold text-slate-900 dark:text-white">{total}</span></span>
                  <select
                    name="perPage"
                    value={perPage}
                    onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
                    className="px-2 py-1 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs"
                  >
                    {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} / page</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  <PaginationButton onClick={() => setPage(1)} disabled={page === 1}><ChevronsLeft className="h-4 w-4" /></PaginationButton>
                  <PaginationButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}><ChevronLeft className="h-4 w-4" /></PaginationButton>
                  <span className="px-3 text-xs text-slate-600 dark:text-slate-400">
                    Page <span className="font-semibold text-slate-900 dark:text-white">{page}</span> of <span className="font-semibold text-slate-900 dark:text-white">{totalPages}</span>
                  </span>
                  <PaginationButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}><ChevronRight className="h-4 w-4" /></PaginationButton>
                  <PaginationButton onClick={() => setPage(totalPages)} disabled={page >= totalPages}><ChevronsRight className="h-4 w-4" /></PaginationButton>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

interface SortHeaderProps {
  col: SortKey;
  label: string;
  sort: SortKey;
  order: SortOrder;
  onClick: (col: SortKey) => void;
  align?: 'left' | 'right';
}

function SortHeader({ col, label, sort, order, onClick, align = 'left' }: SortHeaderProps) {
  const active = sort === col;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`px-5 py-3 text-${align} text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider`}>
      <button
        type="button"
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-1.5 hover:text-slate-700 dark:hover:text-slate-200 transition-colors ${active ? 'text-amber-500 dark:text-amber-400' : ''}`}
      >
        <span>{label}</span>
        <Icon className="h-3 w-3" />
      </button>
    </th>
  );
}

interface PaginationButtonProps {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function PaginationButton({ onClick, disabled, children }: PaginationButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}
