/**
 * useBankTxRefData — Loads all reference/lookup data needed by the bank transactions page
 * (bank accounts, chart of accounts, suppliers, customers, cost centres, business units).
 * All requests fire in parallel via Promise.all.
 */

import { useState, useEffect } from 'react';
import { apiFetch } from '@/lib/apiFetch';
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
};

export function useBankTxRefData(setters: Setters): void {
  const {
    setBankAccounts, setGlAccounts, setSuppliers, setCustomers,
    setCc1Options, setCc2Options, setBuOptions, setSelectedBank,
  } = setters;

  useEffect(() => {
    Promise.all([
      apiFetch('/api/accounting/bank-accounts').then(r => r.json()),
      apiFetch('/api/accounting/chart-of-accounts').then(r => r.json()),
      apiFetch('/api/accounting/suppliers-list?status=active').then(r => r.json()),
      apiFetch('/api/accounting/customers').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?cc_type=cc1&active=true').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?cc_type=cc2&active=true').then(r => r.json()),
      apiFetch('/api/accounting/cost-centres?active=true').then(r => r.json()),
    ]).then(([bankJson, coaJson, suppJson, clientJson, cc1Json, cc2Json, deptJson]) => {
      const bankList: BankAcct[] = Array.isArray(bankJson.data || bankJson) ? (bankJson.data || bankJson) : [];
      setBankAccounts(bankList);
      if (bankList.length > 0) setSelectedBank(prev => prev || bankList[0]!.id);

      const coaList = Array.isArray(coaJson.data || coaJson) ? (coaJson.data || coaJson) : [];
      setGlAccounts(coaList
        .filter((a: SelectOption & { accountSubtype?: string }) => a.accountSubtype !== 'bank')
        .map((a: SelectOption & { accountCode?: string; accountName?: string; defaultVatCode?: string }) => ({
          id: a.id, code: a.accountCode || a.code, name: a.accountName || a.name, defaultVatCode: a.defaultVatCode,
        }))
      );

      const suppList = Array.isArray(suppJson.data) ? suppJson.data : [];
      setSuppliers(suppList.map((s: { id: number | string; name: string; code?: string }) => ({
        id: String(s.id), name: s.name, code: s.code,
      })));

      const clientList = Array.isArray(clientJson.data) ? clientJson.data : [];
      setCustomers(clientList.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name || '' })));

      const cc1List = Array.isArray(cc1Json.data?.items) ? cc1Json.data.items : [];
      setCc1Options(cc1List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const cc2List = Array.isArray(cc2Json.data?.items) ? cc2Json.data.items : [];
      setCc2Options(cc2List.map((c: { id: string; code: string; name: string }) => ({ id: c.id, code: c.code, name: c.name })));

      const deptList = Array.isArray(deptJson.data || deptJson) ? (deptJson.data || deptJson) : [];
      setBuOptions(deptList
        .filter((d: { is_active?: boolean; isActive?: boolean }) => d.is_active !== false && d.isActive !== false)
        .map((d: { id: string; name: string; code?: string }) => ({ id: d.id, name: d.name, code: d.code })));
    }).catch(() => { /* non-critical: UI handles empty lists */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export type { RefData };
