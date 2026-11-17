/**
 * Spend / Receive Money (pages/accounting/bank-transactions/new.tsx): its form types, options and class names — moved
 * out of the page for its line cap, unchanged.
 */
import { localISODate } from '@/lib/dateUtils';

export type TxType = 'spend' | 'receive';
export type AllocType = 'account' | 'supplier' | 'customer';
export type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

export interface SelectOption { id: string; name: string; code?: string }
export interface BankAcct { id: string; accountCode: string; accountName: string; bankAccountNumber?: string | null }
export interface GlAccountOption {
  id: string;
  accountCode?: string | null;
  code?: string | null;
  accountName?: string | null;
  name?: string | null;
  accountSubtype?: string | null;
}
export interface EntityOption {
  id: string;
  name?: string | null;
  code?: string | null;
  company_name?: string | null;
  companyName?: string | null;
}
export interface FormState {
  bankAccountId: string; date: string; reference: string; description: string;
  amount: string; allocationType: AllocType; contraAccountId: string; entityId: string; vatCode: VatCode;
}

export const todayISO = () => localISODate();
export const VAT_OPTIONS: { value: VatCode; label: string }[] = [
  { value: 'none', label: 'No VAT' }, { value: 'standard', label: 'Standard 15%' },
  { value: 'zero_rated', label: 'Zero Rated' }, { value: 'exempt', label: 'Exempt' },
];
export const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
export const lbl = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5';
export const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export const asArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
