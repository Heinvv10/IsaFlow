/**
 * URL-driven state hook for the Supplier Invoices list page.
 *
 * Single source of truth: hydrate once from `router.query` when the router
 * becomes ready, then update state imperatively from event handlers. Each
 * setter pushes the next URL via `router.replace({shallow:true})` only when
 * the resulting query string actually changes — no reactive sync effect, no
 * push-on-every-keystroke flood.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import {
  SUPPLIER_INVOICE_TABS,
  PER_PAGE_OPTIONS,
  DATE_PRESETS,
  type SupplierInvoiceTab,
  type SupplierInvoiceListFilters,
  type DatePreset,
  type SortKey,
  type SortOrder,
  type PerPage,
} from './listTypes';
import { presetToRange } from './datePresets';

const SORT_KEYS: readonly SortKey[] = [
  'invoice_number', 'supplier_name', 'reference', 'invoice_date',
  'total_amount', 'balance', 'status',
];

const DEFAULTS: SupplierInvoiceListFilters = {
  tab: 'all',
  search: '',
  supplierId: '',
  supplierLabel: '',
  datePreset: 'all',
  fromDate: '',
  toDate: '',
  fromAmount: '',
  toAmount: '',
  fromBalance: '',
  toBalance: '',
  sort: 'invoice_date',
  sortOrder: 'desc',
  page: 1,
  perPage: 50,
};

function pickStr(q: Record<string, string | string[] | undefined>, k: string): string {
  return typeof q[k] === 'string' ? (q[k] as string) : '';
}

function hydrateFromQuery(query: Record<string, string | string[] | undefined>): SupplierInvoiceListFilters {
  const tabParam = pickStr(query, 'status');
  const tab = (SUPPLIER_INVOICE_TABS as readonly string[]).includes(tabParam)
    ? tabParam as SupplierInvoiceTab
    : 'all';

  const sortParam = pickStr(query, 'sort');
  const sort = (SORT_KEYS as readonly string[]).includes(sortParam)
    ? sortParam as SortKey
    : 'invoice_date';

  const sortOrderParam = pickStr(query, 'sort_order');
  const sortOrder: SortOrder = sortOrderParam === 'asc' ? 'asc' : 'desc';

  const datePresetParam = pickStr(query, 'date_preset');
  const datePreset = (DATE_PRESETS as readonly string[]).includes(datePresetParam)
    ? datePresetParam as DatePreset
    : 'all';

  const pageRaw = Number(pickStr(query, 'page')) || 1;
  const page = Math.max(1, pageRaw);

  const perPageRaw = Number(pickStr(query, 'per_page')) || 50;
  const perPage: PerPage = (PER_PAGE_OPTIONS as readonly number[]).includes(perPageRaw)
    ? perPageRaw as PerPage
    : 50;

  return {
    tab,
    search: pickStr(query, 'search'),
    supplierId: pickStr(query, 'supplier_id'),
    supplierLabel: pickStr(query, 'supplier_label'),
    datePreset,
    fromDate: pickStr(query, 'from_date'),
    toDate: pickStr(query, 'to_date'),
    fromAmount: pickStr(query, 'from_amount'),
    toAmount: pickStr(query, 'to_amount'),
    fromBalance: pickStr(query, 'from_balance'),
    toBalance: pickStr(query, 'to_balance'),
    sort,
    sortOrder,
    page,
    perPage,
  };
}

function filtersToQuery(f: SupplierInvoiceListFilters): Record<string, string> {
  const q: Record<string, string> = {};
  if (f.tab !== 'all') q.status = f.tab;
  if (f.search) q.search = f.search;
  if (f.supplierId) {
    q.supplier_id = f.supplierId;
    if (f.supplierLabel) q.supplier_label = f.supplierLabel;
  }
  if (f.datePreset !== 'all') q.date_preset = f.datePreset;
  if (f.fromDate) q.from_date = f.fromDate;
  if (f.toDate) q.to_date = f.toDate;
  if (f.fromAmount) q.from_amount = f.fromAmount;
  if (f.toAmount) q.to_amount = f.toAmount;
  if (f.fromBalance) q.from_balance = f.fromBalance;
  if (f.toBalance) q.to_balance = f.toBalance;
  if (f.sort !== 'invoice_date') q.sort = f.sort;
  if (f.sortOrder !== 'desc') q.sort_order = f.sortOrder;
  if (f.page !== 1) q.page = String(f.page);
  if (f.perPage !== 50) q.per_page = String(f.perPage);
  return q;
}

function queryEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

export interface SupplierInvoiceListState {
  filters: SupplierInvoiceListFilters;
  hydrated: boolean;
  update: (patch: Partial<SupplierInvoiceListFilters>) => void;
  setTab: (t: SupplierInvoiceTab) => void;
  setSearch: (s: string) => void;
  selectSupplier: (id: string, label: string) => void;
  clearSupplier: () => void;
  setDatePreset: (p: DatePreset) => void;
  setCustomDate: (key: 'fromDate' | 'toDate', value: string) => void;
  setAmountRange: (key: 'fromAmount' | 'toAmount' | 'fromBalance' | 'toBalance', value: string) => void;
  toggleSort: (col: SortKey) => void;
  setPage: (p: number) => void;
  setPerPage: (n: PerPage) => void;
  resetFilters: () => void;
  filtersActive: boolean;
}

export function useSupplierInvoiceListState(): SupplierInvoiceListState {
  const router = useRouter();
  const [filters, setFilters] = useState<SupplierInvoiceListFilters>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const lastQueryRef = useRef<Record<string, string>>({});

  // Hydrate exactly once when the router becomes ready.
  useEffect(() => {
    if (!router.isReady || hydrated) return;
    const next = hydrateFromQuery(router.query as Record<string, string | string[] | undefined>);
    setFilters(next);
    lastQueryRef.current = filtersToQuery(next);
    setHydrated(true);
  }, [router.isReady, router.query, hydrated]);

  // Imperative setter — applies a patch then pushes the URL only when the
  // resulting query string differs from the last one we pushed.
  const update = useCallback((patch: Partial<SupplierInvoiceListFilters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      if (!router.isReady) return next;
      const nextQuery = filtersToQuery(next);
      if (!queryEqual(nextQuery, lastQueryRef.current)) {
        lastQueryRef.current = nextQuery;
        void router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
      }
      return next;
    });
  }, [router]);

  const setTab = useCallback((t: SupplierInvoiceTab) => update({ tab: t, page: 1 }), [update]);
  const setSearch = useCallback((s: string) => update({ search: s, page: 1 }), [update]);
  const selectSupplier = useCallback((id: string, label: string) => {
    update({ supplierId: id, supplierLabel: label, page: 1 });
  }, [update]);
  const clearSupplier = useCallback(() => {
    update({ supplierId: '', supplierLabel: '', page: 1 });
  }, [update]);

  const setDatePreset = useCallback((p: DatePreset) => {
    if (p === 'all') return update({ datePreset: 'all', fromDate: '', toDate: '', page: 1 });
    if (p === 'custom') return update({ datePreset: 'custom', page: 1 });
    const r = presetToRange(p);
    update({ datePreset: p, fromDate: r.from || '', toDate: r.to || '', page: 1 });
  }, [update]);

  const setCustomDate = useCallback((key: 'fromDate' | 'toDate', value: string) => {
    update({ [key]: value, datePreset: 'custom', page: 1 } as Partial<SupplierInvoiceListFilters>);
  }, [update]);

  const setAmountRange = useCallback((
    key: 'fromAmount' | 'toAmount' | 'fromBalance' | 'toBalance',
    value: string,
  ) => {
    update({ [key]: value, page: 1 } as Partial<SupplierInvoiceListFilters>);
  }, [update]);

  const toggleSort = useCallback((col: SortKey) => {
    setFilters((prev) => {
      const nextSortOrder: SortOrder = prev.sort === col
        ? (prev.sortOrder === 'asc' ? 'desc' : 'asc')
        : (col === 'invoice_date' ? 'desc' : 'asc');
      const next = { ...prev, sort: col, sortOrder: nextSortOrder, page: 1 };
      if (router.isReady) {
        const nextQuery = filtersToQuery(next);
        if (!queryEqual(nextQuery, lastQueryRef.current)) {
          lastQueryRef.current = nextQuery;
          void router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
        }
      }
      return next;
    });
  }, [router]);

  const setPage = useCallback((p: number) => update({ page: Math.max(1, p) }), [update]);
  const setPerPage = useCallback((n: PerPage) => update({ perPage: n, page: 1 }), [update]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULTS);
    if (router.isReady) {
      lastQueryRef.current = {};
      void router.replace({ pathname: router.pathname, query: {} }, undefined, { shallow: true });
    }
  }, [router]);

  const filtersActive = useMemo(() => (
    filters.tab !== 'all'
    || !!filters.search
    || !!filters.supplierId
    || filters.datePreset !== 'all'
    || !!filters.fromAmount
    || !!filters.toAmount
    || !!filters.fromBalance
    || !!filters.toBalance
  ), [filters]);

  return {
    filters, hydrated, update,
    setTab, setSearch,
    selectSupplier, clearSupplier,
    setDatePreset, setCustomDate, setAmountRange,
    toggleSort, setPage, setPerPage, resetFilters,
    filtersActive,
  };
}
