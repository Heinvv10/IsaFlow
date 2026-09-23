/**
 * URL-driven state for the customer invoice list — mirrors
 * useSupplierInvoiceListState. The URL is the source of truth: state hydrates
 * from it when the router is ready and again whenever the URL changes under
 * us (back/forward, a deep link to the page we are on); setters write it back
 * with a shallow replace, and only when the query actually changes.
 *
 * The selected customer's display name is not in the URL (a URL-supplied
 * label could name a different customer than the id it filters on). It comes
 * from the typeahead pick, or from the rows once they load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import type { AgingFilterId } from '@/components/invoices/ARFilters';
import {
  AR_DEFAULTS, arFiltersToQuery, hydrateARFilters,
  type ARListFilters, type ARStatus,
} from './listQuery';

function sameQuery(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every(k => a[k] === b[k]);
}

export interface CustomerInvoiceListState {
  filters: ARListFilters;
  hydrated: boolean;
  customerLabel: string;
  /** Name the customer whose rows just loaded (cold deep link, no typeahead pick). */
  nameCustomer: (id: string, label: string) => void;
  setStatus: (s: ARStatus) => void;
  setSearch: (s: string) => void;
  selectCustomer: (id: string, label: string) => void;
  clearCustomer: () => void;
  setRange: (from: string, to: string) => void;
  setAging: (a: AgingFilterId[]) => void;
  setPage: (p: number) => void;
  clearAll: () => void;
}

export function useCustomerInvoiceListState(): CustomerInvoiceListState {
  const router = useRouter();
  const [filters, setFilters] = useState<ARListFilters>(AR_DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  // Keyed by id, so a URL change to another customer can never show this name.
  const [customerPick, setCustomerPick] = useState({ id: '', label: '' });
  const lastQueryRef = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const next = hydrateARFilters(router.query as Record<string, string | string[] | undefined>);
    const nextQuery = arFiltersToQuery(next);
    if (lastQueryRef.current && sameQuery(nextQuery, lastQueryRef.current)) return;
    lastQueryRef.current = nextQuery;
    setFilters(next);
    setHydrated(true);
  }, [router.isReady, router.query]);

  const update = useCallback((patch: Partial<ARListFilters>) => {
    setFilters(prev => {
      const next = { ...prev, page: 1, ...patch };
      const nextQuery = arFiltersToQuery(next);
      if (router.isReady && !sameQuery(nextQuery, lastQueryRef.current ?? {})) {
        lastQueryRef.current = nextQuery;
        void router.replace({ pathname: router.pathname, query: nextQuery }, undefined, { shallow: true });
      }
      return next;
    });
  }, [router]);

  return {
    filters,
    hydrated,
    customerLabel: customerPick.id === filters.customerId ? customerPick.label : '',
    nameCustomer: useCallback((id: string, label: string) => setCustomerPick({ id, label }), []),
    setStatus: useCallback((status: ARStatus) => update({ status }), [update]),
    setSearch: useCallback((search: string) => update({ search }), [update]),
    selectCustomer: useCallback((customerId: string, label: string) => {
      setCustomerPick({ id: customerId, label });
      update({ customerId });
    }, [update]),
    clearCustomer: useCallback(() => update({ customerId: '' }), [update]),
    setRange: useCallback((from: string, to: string) => update({ from, to }), [update]),
    setAging: useCallback((aging: AgingFilterId[]) => update({ aging }), [update]),
    setPage: useCallback((page: number) => update({ page: Math.max(1, page) }), [update]),
    clearAll: useCallback(() => update({ ...AR_DEFAULTS }), [update]),
  };
}
