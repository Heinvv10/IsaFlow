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
 * Residual (accepted): the early clear of `written` (a router that collapsed X -> Y -> X into one render) keys on the owned
 * query alone, so an UNRELATED query change (e.g. `line` added) that lands while the newest written key is the one on screen
 * also clears it. The cost is one own write mistaken for navigation at most, never a lost view; telling the two apart would
 * need the router's own transition events.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankTxTab } from './BankTxTabs';
import type { BankAccountSummary } from './useBankTxSummary';
import type { BankTxFilterState } from './useBankTxFilters';
import {
  DEFAULT_FILTERS, mergeOwnedQuery, ownedQueryKey, parseUrlView, serializeUrlView, type UrlFilters,
} from './bankTxUrlState';
import { readPageSizePref } from './bankTxPageSizePref';

/** The view's query, measured against the size the plain page would open with (the remembered one, else 25). */
const ser = (v: Parameters<typeof serializeUrlView>[0]) => serializeUrlView(v, readPageSizePref() ?? DEFAULT_FILTERS.pageSize);

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
  // Compared with the value last seen, not with "is this the first run": React StrictMode runs every effect twice on mount,
  // and a first-run flag would let the second run reset what the URL had just restored.
  const prevBank = useRef(selectedBank), prevTab = useRef(tab);
  useEffect(() => {
    const before = prevBank.current; prevBank.current = selectedBank;
    if (before === selectedBank || before === '') return; // unchanged, or the first pick: not a switch
    if (handledBank.current === selectedBank) { handledBank.current = null; return; }
    live.current.f.resetForAccount(); setPage(1); live.current.clearSelection();
  }, [selectedBank, setPage]);
  useEffect(() => {
    const before = prevTab.current; prevTab.current = tab;
    if (before === tab) return;
    if (handledTab.current === tab) { handledTab.current = null; return; }
    live.current.f.resetSelects(); setPage(1); live.current.clearSelection();
  }, [tab, setPage]);

  // ---- the URL ----
  const [restored, setRestored] = useState(false);
  const seen = useRef('');                       // the owned query last looked at
  const written = useRef<string[]>([]);          // keys we wrote and have not yet seen come back (the newest few)
  const urlKey = useRef('');                     // what the URL is, or is about to be: the last key we wrote or saw - NOT router.query, which lags a write
  const lastSent = useRef<{ account: string; tab: BankTxTab; page: number } | null>(null);
  const replaceNext = useRef(false);             // the next URL write REPLACES the entry: a clamp, or tidying a link we were sent to

  const apply = useCallback((q: RouterLike['query'], withAccount: boolean) => {
    const p = parseUrlView(q);
    // The page size: the URL's, else the one remembered in this browser, else 25.
    const filters: UrlFilters = { ...DEFAULT_FILTERS, pageSize: readPageSizePref() ?? DEFAULT_FILTERS.pageSize, ...p.filters };
    const account = withAccount && p.account && p.account !== live.current.selectedBank
      && live.current.bankAccounts.some(b => b.id === p.account && b.isActive) ? p.account : null;
    const nextTab = p.tab ?? 'new';
    if (account) handledBank.current = account;
    if (nextTab !== tab) handledTab.current = nextTab;
    live.current.f.apply(filters); setPage(p.page ?? 1); setTab(nextTab); live.current.clearSelection();
    if (account) setSelectedBank(account);
    return ser({ account: account ?? live.current.selectedBank, tab: nextTab, page: p.page ?? 1, filters }); // the canonical form of what was applied
  }, [tab, setPage, setTab, setSelectedBank]);
  // Back/Forward/a link took us to this URL. If it is not the canonical form of the view it shows (junk parameters, an account
  // that is not available), the correction REPLACES that entry: pushing one would leave the junk URL one Back away, forever.
  const applyExternal = useCallback((q: RouterLike['query'], incomingKey: string) => {
    const canonical = apply(q, true);
    const key = ownedQueryKey(canonical);
    // A view that looks the same as before (junk dropped, an unavailable account refused) changes no state, so no write would
    // follow by itself: tidy the entry here.
    if (key !== incomingKey && canonical.account_id) {
      const r = routerRef.current;
      urlKey.current = key; written.current.push(key);
      void r.replace({ pathname: r.pathname, query: mergeOwnedQuery(r.query, canonical) }, undefined, { shallow: true, scroll: false });
    }
  }, [apply]);

  useEffect(() => { // restore once, as soon as the router can say what the URL is
    if (!router.isReady || restored) return;
    seen.current = urlKey.current = ownedQueryKey(router.query);
    apply(router.query, false);
    setRestored(true);
  }, [router.isReady, router.query, restored, apply]);

  const view = { account: selectedBank, tab, page, filters: f.values };
  const viewKey = ownedQueryKey(ser(view));
  useEffect(() => { // write the view
    if (!restored || !selectedBank) return;
    const r = routerRef.current;
    const owned = ser(view);
    const key = ownedQueryKey(owned);
    const prev = lastSent.current;
    lastSent.current = { account: selectedBank, tab, page };
    if (key === urlKey.current) return; // already the URL, or already on its way (router.query may not show it yet)
    const push = prev !== null && (prev.account !== selectedBank || prev.tab !== tab || prev.page !== page) && !replaceNext.current;
    urlKey.current = key;
    written.current.push(key);
    if (written.current.length > 8) written.current.shift(); // a write the router never reports back (a duplicate URL) must not pile up
    void (push ? r.push : r.replace)({ pathname: r.pathname, query: mergeOwnedQuery(r.query, owned) }, undefined, { shallow: true, scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, viewKey]);

  useEffect(() => { replaceNext.current = false; }); // after the write above, every commit

  /**
   * For usePageClamp: the list is shorter than the page asked for, so the page is MOVED, not navigated to. It rewrites the
   * current history entry; pushing one would make Back return to the page that no longer exists, clamp again, and loop.
   */
  const clampPage = useCallback((n: number) => { replaceNext.current = true; setPage(n); }, [setPage]);

  const incoming = ownedQueryKey(router.query);
  // A quick X -> Y -> X can reach the router as ONE render (Y never shows): the key it reports is the newest we wrote, and
  // every older entry (Y) is stale - kept, a later Back to Y would be taken for our own write and ignored.
  useEffect(() => {
    if (restored && written.current.length > 0 && written.current[written.current.length - 1] === incoming) written.current = [];
  }, [restored, router.query, incoming]);
  useEffect(() => { // Back / Forward / a link to this page: show what the URL says
    if (!restored || incoming === seen.current) return;
    seen.current = incoming;
    const own = written.current.indexOf(incoming);
    if (own >= 0) { written.current.splice(0, own + 1); return; } // our own write coming back
    if (incoming === viewKey) return;
    written.current = []; urlKey.current = incoming;
    applyExternal(routerRef.current.query, incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, incoming]);

  // The query as the page means it to be right now: other code that rewrites the URL (the drawer link dropping `line`) must
  // start from this, not from router.query, which does not show a write still on its way.
  const viewNow = useRef(view);
  useEffect(() => { viewNow.current = view; });
  const latestQuery = useCallback(() => (restored && viewNow.current.account
    ? mergeOwnedQuery(routerRef.current.query, ser(viewNow.current)) : routerRef.current.query), [restored]);

  return { selectBank, changeTab, clampPage, latestQuery, restored };
}
