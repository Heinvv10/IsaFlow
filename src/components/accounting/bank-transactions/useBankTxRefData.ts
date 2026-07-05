/**
 * useBankTxRefData — Loads all reference/lookup data needed by the bank transactions page
 * (bank accounts, chart of accounts, suppliers, customers, cost centres, business units).
 * All requests fire in parallel via Promise.all.
 */

import { useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SelectOption } from '@/components/accounting/BankTxTable';
import type { BankAcct } from './BankTxBankCards';

interface RefData {
  bankAccounts: BankAcct[];
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  cc1Options: SelectOption[];
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
}

type Setters = {
  setBankAccounts: (v: BankAcct[]) => void;
  setGlAccounts: (v: SelectOption[]) => void;
  setSuppliers: (v: SelectOption[]) => void;
  setCustomers: (v: SelectOption[]) => void;
  setCc1Options: (v: SelectOption[]) => void;
  setCc2Options: (v: SelectOption[]) => void;
  setBuOptions: (v: SelectOption[]) => void;
  setSelectedBank: (fn: (prev: string) => string) => void;
  setRefDataLoaded?: (v: boolean) => void;
};

export function useBankTxRefData(setters: Setters): { refreshBankAccounts: () => void } {
  const {
    setBankAccounts, setGlAccounts, setSuppliers, setCustomers,
    setCc1Options, setCc2Options, setBuOptions, setSelectedBank, setRefDataLoaded,
  } = setters;

  const refreshBankAccounts = useCallback(() => {
    apiFetch('/api/accounting/bank-accounts').then(r => r.json()).then(bankJson => {
      const bankList: BankAcct[] = Array.isArray(bankJson.data || bankJson) ? (bankJson.data || bankJson) : [];
      setBankAccounts(bankList);
    }).catch(() => { /* non-critical */ });
  }, [setBankAccounts]);

  useEffect(() => {
    // allSettled, not all: a 500 on a single ref-data endpoint (e.g.
    // cost-centres when its schema is mid-migration) used to short-circuit
    // the whole chain and leave the page stuck on "Loading…" with no bank
    // accounts surfaced. Each fetch is now unwrapped independently.
    const json = (r: PromiseSettledResult<Response>) =>
      r.status === 'fulfilled' && r.value.ok
        ? r.value.json().catch(() => null)
        : Promise.resolve(null);

    Promise.allSettled([
      apiFetch('/api/accounting/bank-accounts'),
      apiFetch('/api/accounting/chart-of-accounts'),
      apiFetch('/api/accounting/suppliers-list?status=active'),
      apiFetch('/api/accounting/customers'),
      apiFetch('/api/accounting/cost-centres?cc_type=cc1&active=true'),
      apiFetch('/api/accounting/cost-centres?cc_type=cc2&active=true'),
      apiFetch('/api/accounting/cost-centres?active=true'),
    ]).then(async ([bankRes, coaRes, suppRes, clientRes, cc1Res, cc2Res, deptRes]) => {
      const [bankJson, coaJson, suppJson, clientJson, cc1Json, cc2Json, deptJson] = await Promise.all([
        json(bankRes), json(coaRes), json(suppRes), json(clientRes), json(cc1Res), json(cc2Res), json(deptRes),
      ]);

      const bankRaw = bankJson?.data ?? bankJson;
      const bankList: BankAcct[] = Array.isArray(bankRaw) ? bankRaw : [];
      setBankAccounts(bankList);
      if (bankList.length > 0) setSelectedBank(prev => prev || bankList[0]!.id);

      const coaRaw = coaJson?.data ?? coaJson;
      const coaList: Array<SelectOption & { accountSubtype?: string; accountCode?: string; accountName?: string; defaultVatCode?: string }> = Array.isArray(coaRaw) ? coaRaw : [];
      setGlAccounts(coaList
        .filter(a => a.accountSubtype !== 'bank')
        .map(a => ({ id: a.id, code: a.accountCode || a.code, name: a.accountName || a.name, defaultVatCode: a.defaultVatCode }))
      );

      const suppD = suppJson?.data ?? suppJson;
      const suppList: { id: number | string; name: string; code?: string }[] = Array.isArray(suppD) ? suppD : (suppD?.suppliers ?? []);
      setSuppliers(suppList.map(s => ({ id: String(s.id), name: s.name, code: s.code })));

      const clientList = Array.isArray(clientJson?.data) ? clientJson.data : [];
      setCustomers(clientList.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name || '' })));

      const cc1List = Array.isArray(cc1Json?.data?.items) ? cc1Json.data.items : [];
      setCc1Options(cc1List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const cc2List = Array.isArray(cc2Json?.data?.items) ? cc2Json.data.items : [];
      setCc2Options(cc2List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const deptRaw = deptJson?.data ?? deptJson;
      const deptList = Array.isArray(deptRaw) ? deptRaw : [];
      setBuOptions(deptList
        .filter((d: { is_active?: boolean; isActive?: boolean }) => d.is_active !== false && d.isActive !== false)
        .map((d: { id: string; name: string; code?: string }) => ({ id: d.id, name: d.name, code: d.code })));
    }).catch((err) => {
      log.error('Failed to load bank transaction reference data', { error: err }, 'accounting-ui');
    }).finally(() => { setRefDataLoaded?.(true); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { refreshBankAccounts };
}

export type { RefData };
