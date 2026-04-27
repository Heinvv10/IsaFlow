/**
 * Reference-data hook for the bank rules page: chart of accounts, bank
 * accounts, suppliers, customers. Extracted from rules.tsx so the page
 * itself stays under the 300-line file budget.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export interface RefAccount {
  id: string;
  accountCode: string;
  accountName: string;
  defaultVatCode?: string;
}

export interface RefBankAccount {
  id: string;
  accountCode: string;
  accountName: string;
}

export interface RefNamed {
  id: string;
  name: string;
}

export interface BankRuleRefData {
  accounts: RefAccount[];
  bankAccounts: RefBankAccount[];
  suppliers: RefNamed[];
  clients: RefNamed[];
  defaultBankId: string;
  /** Names of reference-data fetches that failed, surfaced for the UI to flag. */
  errors: string[];
}

/**
 * Wraps a fetcher with named error handling. We log the failure and add
 * the resource name to the returned `errors` array so the page can render
 * a banner instead of silently leaving an empty dropdown — silently
 * swallowing the rejection is exactly what CLAUDE.md "no empty catch"
 * forbids.
 */
async function loadWithLog<T>(
  resource: string,
  loader: () => Promise<T>,
  onError: (msg: string) => void,
): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Bank rules ref-data fetch failed', { resource, error: msg }, 'bankRules');
    onError(`${resource} (${msg})`);
    return null;
  }
}

export function useBankRuleRefData(): BankRuleRefData {
  const [accounts, setAccounts] = useState<RefAccount[]>([]);
  const [bankAccounts, setBankAccounts] = useState<RefBankAccount[]>([]);
  const [suppliers, setSuppliers] = useState<RefNamed[]>([]);
  const [clients, setClients] = useState<RefNamed[]>([]);
  const [defaultBankId, setDefaultBankId] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const pushErr = (msg: string) => setErrors(prev => [...prev, msg]);

    void loadWithLog('chart-of-accounts', async () => {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json.data || json;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || a.account_code || ''),
        accountName: String(a.accountName || a.account_name || ''),
        defaultVatCode: String(a.defaultVatCode || a.default_vat_code || 'none'),
      })));
    }, pushErr);

    void loadWithLog('bank-accounts', async () => {
      const res = await apiFetch('/api/accounting/bank-accounts', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : [];
      const mapped: RefBankAccount[] = list.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || ''),
        accountName: String(a.accountName || ''),
      }));
      setBankAccounts(mapped);
      if (mapped[0]) setDefaultBankId(mapped[0].id);
    }, pushErr);

    void loadWithLog('suppliers', async () => {
      const res = await apiFetch('/api/accounting/suppliers-list?status=active', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = json.data ?? json;
      const list: { id: number | string; name: string }[] = Array.isArray(d) ? d : (d.suppliers ?? []);
      setSuppliers(list.map(s => ({ id: String(s.id), name: s.name })));
    }, pushErr);

    void loadWithLog('customers', async () => {
      const res = await apiFetch('/api/accounting/customers', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : [];
      setClients(list.map((c: { id: string; name?: string; company_name?: string; companyName?: string }) => ({
        id: c.id,
        name: c.company_name || c.companyName || c.name || '',
      })));
    }, pushErr);
  }, []);

  return { accounts, bankAccounts, suppliers, clients, defaultBankId, errors };
}
