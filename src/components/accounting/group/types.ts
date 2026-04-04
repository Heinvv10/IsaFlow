/**
 * Shared types and constants for Group Setup components
 */

export interface CompanyGroup {
  id: string;
  name: string;
  holding_company_id: string | null;
  default_currency: string;
  financial_year_start: number;
  created_at: string;
}

export interface GroupMember {
  id: string;
  company_id: string;
  company_name: string;
  ownership_pct: number;
  consolidation_method: 'full' | 'proportionate' | 'equity';
  joined_at: string;
}

export interface GroupAccount {
  id: string;
  code: string;
  name: string;
  account_type: string;
  sub_type: string | null;
  level: number;
}

export interface AccountMapping {
  company_account_id: string;
  company_account_code: string;
  company_account_name: string;
  group_account_id: string | null;
  group_account_code: string | null;
  group_account_name: string | null;
}

export interface SimpleCompany {
  id: string;
  name: string;
}

export type GroupSetupTab = 'details' | 'coa' | 'mapping';

export const INPUT_CLS =
  'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none';
export const LABEL_CLS = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';
export const BTN_PRIMARY =
  'flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50';
export const BTN_SECONDARY =
  'flex items-center gap-2 px-3 py-1.5 border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg text-sm transition-colors disabled:opacity-50';
export const SECTION_CLS =
  'bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl p-6';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const CONSOLIDATION_METHODS = [
  { value: 'full', label: 'Full Consolidation' },
  { value: 'proportionate', label: 'Proportionate' },
  { value: 'equity', label: 'Equity Method' },
];
