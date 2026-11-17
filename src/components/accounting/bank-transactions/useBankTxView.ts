/**
 * useBankTxView - what the bank-transactions page is looking at (account, tab, page, filters) and how it changes (WP4a).
 *
 *  - The view lives in the URL: it is written there on every change (a new history entry for account, tab and page; the
 *    typing of a search or a date only replaces the entry), restored from it on first load, and re-applied when the user
 *    goes Back/Forward. A deep link that only names an account still works (useBankTxSelection reads it).
 *  - A switch of account or tab happens in ONE batch (the new view, the filters back to defaults, the selection cleared):
 *    one render, so one list fetch. The reset used to be an effect that ran after the render that had already fetched.
 *  - A change made FROM the URL (restore, Back) must not be reset as if the user had switched: it carries its own filters.
 * The URL is never written before the account is known, or a deep link naming one would be lost.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankTxTab } from './BankTxTabs';
import type { BankAccountSummary } from './useBankTxSummary';
import type { BankTxFilterState } from './useBankTxFilters';
import {
  DEFAULT_FILTERS, mergeOwnedQuery, ownedQueryKey, parseUrlView, serializeUrlView, type UrlFilters,
} from './bankTxUrlState';

interface RouterLike {
  isReady: boolean; pathname: string; query: Record<string, string | string[] | undefined>;
  push: (url: { pathname: string; query: Record<string, string | string[] | undefined> }, as?: undefined, o?: { shallow?: boolean; scroll?: boolean }) => unknown;
  replace: (url: { pathname: string; query: Record<string, string | string[] | undefined> }, as?: undefined, o?: { shallow?: boolean; scroll?: boolean }) => unknown;
}
interface Args {
  router: RouterLike;
  bankAccounts: BankAccountSummary[];
  selectedBank: string;
  setSelectedBank: (id: string) => void;
  tab: BankTxTab; setTab: (t: BankTxTab) => void;
  page: number; setPage: (n: number) => void;
  f: BankTxFilterState;
  /** Clears what belongs to the old view: the ticked rows and the per-row choices. */
  clearSelection: () => void;
}

export function useBankTxView({ router, bankAccounts, selectedBank, setSelectedBank, tab, setTab, page, setPage, f, clearSelection }: Args) {
  const routerRef = useRef(router);
  const live = useRef({ bankAccounts, selectedBank, f, clearSelection });
  useEffect(() => { routerRef.current = router; live.current = { bankAccounts, selectedBank, f, clearSelection }; });
  // Changes we made ourselves, so the effects that react to the account/tab changing do not reset them a second time.
  const handledBank = useRef<string | null>(null), handledTab = useRef<BankTxTab | null>(null);

  // ---- user-driven switches: everything in one batch ----
  const selectBank = useCallback((id: string) => {
    if (id === live.current.selectedBank) return;
    handledBank.current = id;
    live.current.f.resetForAccount(); setPage(1); live.current.clearSelection();
    setSelectedBank(id);
  }, [setPage, setSelectedBank]);
  const changeTab = useCallback((t: BankTxTab) => {
    if (t === tab) return;
    handledTab.current = t;
    live.current.f.resetSelects(); setPage(1); live.current.clearSelection();
    setTab(t);
  }, [tab, setPage, setTab]);

  // ---- a change nobody asked for (the chosen account left the list): back to the defaults ----
  const prevBank = useRef('');
  useEffect(() => {
    const before = prevBank.current; prevBank.current = selectedBank;
    if (before === '') return; // the first pick is not a switch
    if (handledBank.current === selectedBank) { handledBank.current = null; return; }
    live.current.f.resetForAccount(); setPage(1); live.current.clearSelection();
  }, [selectedBank, setPage]);
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return; }
    if (handledTab.current === tab) { handledTab.current = null; return; }
    live.current.f.resetSelects(); setPage(1); live.current.clearSelection();
  }, [tab, setPage]);

  // ---- the URL ----
  const [restored, setRestored] = useState(false);
  const seen = useRef('');                       // the owned query last looked at
  const written = useRef<string[]>([]);          // keys we wrote and have not yet seen come back
  const lastSent = useRef<{ account: string; tab: BankTxTab; page: number } | null>(null);

  const apply = useCallback((q: RouterLike['query'], withAccount: boolean) => {
    const p = parseUrlView(q);
    const filters: UrlFilters = { ...DEFAULT_FILTERS, ...p.filters };
    const account = withAccount && p.account && p.account !== live.current.selectedBank
      && live.current.bankAccounts.some(b => b.id === p.account) ? p.account : null;
    const nextTab = p.tab ?? 'new';
    if (account) handledBank.current = account;
    if (nextTab !== tab) handledTab.current = nextTab;
    live.current.f.apply(filters); setPage(p.page ?? 1); setTab(nextTab); live.current.clearSelection();
    if (account) setSelectedBank(account);
  }, [tab, setPage, setTab, setSelectedBank]);

  useEffect(() => { // restore once, as soon as the router can say what the URL is
    if (!router.isReady || restored) return;
    seen.current = ownedQueryKey(router.query);
    apply(router.query, false);
    setRestored(true);
  }, [router.isReady, router.query, restored, apply]);

  const view = { account: selectedBank, tab, page, filters: f.values };
  const viewKey = ownedQueryKey(serializeUrlView(view));
  useEffect(() => { // write the view
    if (!restored || !selectedBank) return;
    const r = routerRef.current;
    const owned = serializeUrlView(view);
    const key = ownedQueryKey(owned);
    const prev = lastSent.current;
    lastSent.current = { account: selectedBank, tab, page };
    if (key === ownedQueryKey(r.query)) return;
    const push = prev !== null && (prev.account !== selectedBank || prev.tab !== tab || prev.page !== page);
    written.current.push(key);
    void (push ? r.push : r.replace)({ pathname: r.pathname, query: mergeOwnedQuery(r.query, owned) }, undefined, { shallow: true, scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, viewKey]);

  const incoming = ownedQueryKey(router.query);
  useEffect(() => { // Back / Forward / a link to this page: show what the URL says
    if (!restored || incoming === seen.current) return;
    seen.current = incoming;
    const own = written.current.indexOf(incoming);
    if (own >= 0) { written.current.splice(0, own + 1); return; } // our own write coming back
    if (incoming === viewKey) return;
    written.current = [];
    apply(routerRef.current.query, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, incoming]);

  return { selectBank, changeTab };
}
