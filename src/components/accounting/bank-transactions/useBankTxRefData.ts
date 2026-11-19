/**
 * useBankTxRefData — Loads all reference/lookup data needed by the bank transactions page
 * (chart of accounts, suppliers, customers, cost centres, business units).
 * All requests fire in parallel via Promise.all.
 */

import { useEffect } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import { isBankSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import type { SelectOption } from '@/components/accounting/BankTxTable';

interface RefData {
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  cc1Options: SelectOption[];
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
}

type Setters = {
  setGlAccounts: (v: SelectOption[]) => void;
  setSuppliers: (v: SelectOption[]) => void;
  setCustomers: (v: SelectOption[]) => void;
  setCc1Options: (v: SelectOption[]) => void;
  setCc2Options: (v: SelectOption[]) => void;
  setBuOptions: (v: SelectOption[]) => void;
  /** Reports the supplier list state so the page can say so: loaded, failed, or cut at the cap. */
  setSuppliersStatus?: (v: 'ok' | 'failed' | 'truncated') => void;
};

/** The bank accounts are not here: useBankTxSummary owns them (and the default selection). */
export function useBankTxRefData(setters: Setters): void {
  const {
    setGlAccounts, setSuppliers, setCustomers, setCc1Options, setCc2Options, setBuOptions, setSuppliersStatus,
  } = setters;

  // Suppliers page through the whole list, so they load on their own: a slow or
  // failing supplier walk must not hold back bank accounts and the chart.
  useEffect(() => {
    let live = true;
    fetchAllSuppliers().then(({ suppliers, truncated }) => {
      if (!live) return;
      setSuppliers(suppliers.map(s => ({ id: String(s.id), name: s.name, code: s.code })));
      setSuppliersStatus?.(truncated ? 'truncated' : 'ok');
    }).catch((err) => {
      log.warn('Failed to load suppliers for bank transactions', { error: err }, 'accounting-ui');
      if (live) setSuppliersStatus?.('failed');
    });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // allSettled, not all: a 500 on a single ref-data endpoint (e.g.
    // cost-centres when its schema is mid-migration) used to short-circuit
    // the whole chain and leave the page stuck on "Loading…" with no bank
    // accounts surfaced. Each fetch is now unwrapped independently.
    const LISTS_FAILED = 'Could not load some lists - reload the page';
    const json = async (r: PromiseSettledResult<Response>) => {
      if (r.status !== 'fulfilled') {
        log.warn('A bank-transactions reference list did not load', { error: r.reason }, 'accounting-ui');
        return null;
      }
      const res = r.value;
      try {
        await assertOk(res, LISTS_FAILED);
        return await res.json();
      } catch (err) {
        log.warn('A bank-transactions reference list did not load', { error: err }, 'accounting-ui');
        return null;
      }
    };

    // An unmounted page sets nothing and raises nothing: its fetches are aborted and their results dropped.
    let live = true;
    const controller = new AbortController();
    const get = (url: string) => apiFetch(url, { signal: controller.signal });
    const CC1_URL = '/api/accounting/cost-centres?cc_type=cc1&active=true';
    // The dimension rows carry each CC2's fnoCode and parentId, which the row's CC1 -> CC2 filter keys on (#1653).
    const CC2_URL = '/api/accounting/cost-centres?detail=dimensions&cc_type=cc2&active=true';
    const BU_URL = '/api/accounting/business-units?active=true';

    Promise.allSettled([
      get('/api/accounting/chart-of-accounts'), get('/api/accounting/customers'), get(CC1_URL), get(CC2_URL), get(BU_URL),
    ]).then(async ([coaRes, clientRes, cc1Res, cc2Res, buRes]) => {
      if (!live) return;
      const [coaJson, clientJson, cc1Json, cc2Json, buJson] = await Promise.all([
        json(coaRes), json(clientRes), json(cc1Res), json(cc2Res), json(buRes),
      ]);
      if (!live) return;

      let failed = [coaJson, clientJson, cc1Json, cc2Json, buJson].some(j => j === null);
      // A loaded list whose rows are not an array at data.items failed too: say so, never show it as empty.
      const items = (body: { data?: { items?: unknown } } | null, url: string): Array<Record<string, unknown>> => {
        if (body === null) return [];
        const rows = body.data?.items;
        if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
        log.warn('A bank-transactions reference list came back in the wrong shape', { url }, 'accounting-ui');
        failed = true;
        return [];
      };

      const coaRaw = coaJson?.data ?? coaJson;
      const coaList: Array<SelectOption & { accountSubtype?: string; accountCode?: string; accountName?: string; defaultVatCode?: string; vatInputDenied?: boolean }> = Array.isArray(coaRaw) ? coaRaw : [];
      setGlAccounts(coaList
        .filter(a => !isBankSubtype(a.accountSubtype))
        .map(a => ({ id: a.id, code: a.accountCode || a.code, name: a.accountName || a.name, defaultVatCode: a.defaultVatCode, vatInputDenied: a.vatInputDenied }))
      );

      const clientList = Array.isArray(clientJson?.data) ? clientJson.data : [];
      setCustomers(clientList.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name || '' })));

      const cc1List = items(cc1Json, CC1_URL) as Array<{ id: string; code: string; name: string }>;
      setCc1Options(cc1List.map(c => ({ id: c.id, code: c.code, name: c.name })));

      const cc2List = items(cc2Json, CC2_URL) as Array<{ id: string; code: string; name: string; fnoCode?: string | null; parentId?: string | null }>;
      setCc2Options(cc2List.map(c => ({ id: c.id, code: c.code, name: c.name, fnoCode: c.fnoCode ?? null, parentId: c.parentId ?? null })));

      // Business units, not cost centres: this list read cost-centres and an array under `data`, so it was always empty.
      const buList = items(buJson, BU_URL) as Array<{ id: string; name: string; code?: string; isActive?: boolean }>;
      setBuOptions(buList.filter(b => b.isActive !== false).map(b => ({ id: b.id, name: b.name, code: b.code })));

      if (failed) notify.error(LISTS_FAILED);
    }).catch((err) => {
      if (!live) return;
      log.error('Failed to load bank transaction reference data', { error: err }, 'accounting-ui');
      notify.error(LISTS_FAILED);
    });
    return () => { live = false; controller.abort(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export type { RefData };
