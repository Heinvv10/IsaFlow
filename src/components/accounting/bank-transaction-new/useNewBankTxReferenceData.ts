/**
 * The Spend / Receive Money form's reference data — bank accounts, GL accounts (bank accounts left out), suppliers and
 * customers — loaded once on mount. Moved out of pages/accounting/bank-transactions/new.tsx for its line cap, unchanged:
 * the first bank account is set on the page's form (`setForm`, stable, so the effect still runs once on mount).
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { notify } from '@/utils/toast';
import { log } from '@/lib/logger';
import { apiFetch, apiJson, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { fetchAllSuppliers } from '@/lib/fetchAllSuppliers';
import { isBankSubtype } from '@/modules/accounting/services/gl/accountSubtypes';
import { asArray, type BankAcct, type EntityOption, type FormState, type GlAccountOption, type SelectOption } from './newBankTxForm';

export function useNewBankTxReferenceData(setForm: Dispatch<SetStateAction<FormState>>) {
  const [bankAccounts, setBankAccounts] = useState<BankAcct[]>([]);
  const [glAccounts, setGlAccounts] = useState<SelectOption[]>([]);
  const [suppliers, setSuppliers] = useState<SelectOption[]>([]);
  const [suppliersFailed, setSuppliersFailed] = useState(false);
  const [suppliersTruncated, setSuppliersTruncated] = useState(false);
  const [customers, setCustomers] = useState<SelectOption[]>([]);
  const [isLoadingRef, setIsLoadingRef] = useState(true);

  useEffect(() => {
    let mounted = true;
    const promises = [
      apiJson('/api/accounting/bank-accounts', undefined, 'Could not load the bank accounts - try again').then(data => {
        if (!mounted) return;
        const list: BankAcct[] = Array.isArray(data) ? data : [];
        setBankAccounts(list);
        if (list.length > 0) setForm(prev => ({ ...prev, bankAccountId: list[0]!.id }));
      }).catch((err) => {
        log.error('Failed to load bank accounts', { error: err }, 'accounting-ui');
        if (mounted) notify.error('Could not load bank accounts — reload the page to try again');
      }),
      apiFetch('/api/accounting/chart-of-accounts').then(async r => { await assertOk(r, 'Could not load accounts - try again'); return r.json(); }).then(json => {
        if (!mounted) return;
        const list = asArray<GlAccountOption>(json.data ?? json);
        setGlAccounts(list
          .filter(a => !isBankSubtype(a.accountSubtype))
          .map(a => ({ id: a.id, code: a.accountCode ?? a.code ?? undefined, name: a.accountName ?? a.name ?? '' })));
      }).catch((err) => { log.error('Failed to load accounts', { error: err }, 'accounting-ui'); if (mounted) notify.error(apiErrorMessage(err, 'Could not load accounts - try again')); }),
      fetchAllSuppliers().then(({ suppliers: list, truncated }) => {
        if (!mounted) return;
        setSuppliers(list.map(s => ({ id: String(s.id), name: s.name ?? '', code: s.code ?? undefined })));
        if (truncated) setSuppliersTruncated(true);
      }).catch(err => {
        log.warn('Failed to load suppliers for new bank transaction', { error: err }, 'accounting-ui');
        if (mounted) setSuppliersFailed(true);
      }),
      apiFetch('/api/accounting/customers').then(async r => { await assertOk(r, 'Could not load customers - try again'); return r.json(); }).then(json => {
        if (!mounted) return;
        const list = asArray<EntityOption>(json.data);
        setCustomers(list.map(c => ({ id: String(c.id), name: c.company_name ?? c.companyName ?? c.name ?? '' })));
      }).catch((err) => { log.error('Failed to load customers', { error: err }, 'accounting-ui'); if (mounted) notify.error(apiErrorMessage(err, 'Could not load customers - try again')); }),
    ];
    void Promise.allSettled(promises).finally(() => { if (mounted) setIsLoadingRef(false); });
    return () => { mounted = false; };
  }, [setForm]);

  return { bankAccounts, glAccounts, suppliers, suppliersFailed, suppliersTruncated, customers, isLoadingRef };
}
