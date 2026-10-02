/**
 * Reference-data hook for the bank rules page: chart of accounts, bank
 * accounts, suppliers, customers. Extracted from rules.tsx so the page
 * itself stays under the 300-line file budget.
 */

import { useEffect, useState } from 'react';
import { apiFetch, apiJson, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import { log } from '@/lib/logger';

export interface RefAccount {
  id: string;
  accountCode: string;
  accountName: string;
  defaultVatCode?: string;
  /** VAT Act s17(2)(a): input tax on this account is denied (entertainment). */
  vatInputDenied?: boolean;
  /**
   * `bank` means a rule pointing here moves money between the company's own
   * accounts. The form needs it because no NAME classifier can tell: "FNB
   * Cheque Account" reads like any other account.
   */
  accountSubtype?: string;
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
  /** The supplier walk hit its cap, so the supplier picker is missing some suppliers. */
  suppliersTruncated: boolean;
  /** Names of reference-data fetches that failed, surfaced for the UI to flag. */
  errors: string[];
}

const COA_FAILED = 'Could not load the chart of accounts - try again';
const BANKS_FAILED = 'Could not load the bank accounts - try again';
const SUPPLIERS_FAILED = 'Could not load the suppliers - try again';
const CUSTOMERS_FAILED = 'Could not load the customers - try again';

/**
 * Wraps a fetcher with named error handling. We log the failure and add
 * the resource name to the returned `errors` array so the page can render
 * a banner instead of silently leaving an empty dropdown — silently
 * swallowing the rejection is exactly what CLAUDE.md "no empty catch"
 * forbids.
 */
async function loadWithLog<T>(
  resource: string,
  failure: string,
  loader: () => Promise<T>,
  onError: (msg: string) => void,
): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    log.error('Bank rules ref-data fetch failed', { resource, error: err instanceof Error ? err.message : String(err) }, 'bankRules');
    onError(apiErrorMessage(err, failure));
    return null;
  }
}

export function useBankRuleRefData(): BankRuleRefData {
  const [accounts, setAccounts] = useState<RefAccount[]>([]);
  const [bankAccounts, setBankAccounts] = useState<RefBankAccount[]>([]);
  const [suppliers, setSuppliers] = useState<RefNamed[]>([]);
  const [clients, setClients] = useState<RefNamed[]>([]);
  const [suppliersTruncated, setSuppliersTruncated] = useState(false);
  const [defaultBankId, setDefaultBankId] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const pushErr = (msg: string) => setErrors(prev => [...prev, msg]);

    void loadWithLog('Chart of accounts', COA_FAILED, async () => {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' });
      await assertOk(res, COA_FAILED);
      const json = await res.json();
      const d = json.data || json;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list.map((a: Record<string, unknown>) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || a.account_code || ''),
        accountName: String(a.accountName || a.account_name || ''),
        defaultVatCode: String(a.defaultVatCode || a.default_vat_code || 'none'),
        vatInputDenied: Boolean(a.vatInputDenied ?? a.vat_input_denied),
        accountSubtype: String(a.accountSubtype || a.account_subtype || ''),
      })));
    }, pushErr);

    void loadWithLog('Bank accounts', BANKS_FAILED, async () => {
      const data = await apiJson('/api/accounting/bank-accounts', undefined, BANKS_FAILED);
      const list = Array.isArray(data) ? data : [];
      const mapped: RefBankAccount[] = list.map((a) => ({
        id: String(a.id),
        accountCode: String(a.accountCode || ''),
        accountName: String(a.accountName || ''),
      }));
      setBankAccounts(mapped);
      if (mapped[0]) setDefaultBankId(mapped[0].id);
    }, pushErr);

    void loadWithLog('Suppliers', SUPPLIERS_FAILED, async () => {
      const { suppliers: list, truncated } = await fetchAllSuppliers();
      setSuppliers(list.map(s => ({ id: String(s.id), name: s.name })));
      setSuppliersTruncated(truncated);
    }, pushErr);

    void loadWithLog('Customers', CUSTOMERS_FAILED, async () => {
      const res = await apiFetch('/api/accounting/customers', { credentials: 'include' });
      await assertOk(res, CUSTOMERS_FAILED);
      const json = await res.json();
      const list = Array.isArray(json.data) ? json.data : [];
      setClients(list.map((c: { id: string; name?: string; company_name?: string; companyName?: string }) => ({
        id: c.id,
        name: c.company_name || c.companyName || c.name || '',
      })));
    }, pushErr);
  }, []);

  return { accounts, bankAccounts, suppliers, clients, defaultBankId, suppliersTruncated, errors };
}
