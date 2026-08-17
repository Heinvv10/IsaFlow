/**
 * Shared types and constants for Group Setup components
 */

/**
 * The API's response types are RE-EXPORTED from the service layer, never
 * redeclared here.
 *
 * They used to be redeclared in snake_case (`company_id`, `ownership_pct`, …)
 * while every mapper in the service layer emits camelCase (`companyId`,
 * `ownershipPct`, …). Because the page fed `await res.json()` — typed `any` —
 * straight into these types, tsc saw a match that did not exist and the UI
 * silently rendered `undefined`: blank company pickers, a members table with no
 * names, and an "already a member" filter that never excluded anyone.
 *
 * Re-exporting means a field rename in the service is now a compile error here.
 * `import type` is erased at build time, so this pulls no service code into the
 * client bundle.
 */
export type { CompanyGroup, GroupMember } from '@/modules/accounting/services/reports/groupCrudService';
export type { GroupAccount, CoaMapping } from '@/modules/accounting/services/reports/groupCoaMappingService';

/** Company account with no group mapping yet — shape returned by `getUnmappedAccounts`. */
export interface UnmappedAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
}

export interface SimpleCompany {
  id: string;
  name: string;
}

/**
 * Row shape returned by GET /api/accounting/companies?action=user-companies —
 * i.e. `CompanyUser` from `companyMapper.ts`. Declared here so the mapping below
 * is a compile-time contract instead of an `any` from `res.json()`.
 */
export interface UserCompanyRow {
  companyId: string;
  companyName: string;
  role?: string;
  isDefault?: boolean;
}

/**
 * Adapts the API's camelCase rows to the `{ id, name }` shape the group
 * components render.
 *
 * The bug this exists to prevent: the page fed `res.json()` (typed `any`)
 * straight into `SimpleCompany[]`, so every `c.id` / `c.name` was `undefined`.
 * The Holding Company and add-member pickers rendered a list of blank options —
 * right number of entries, no labels and no values — and TypeScript could not
 * see it because the lie happened inside an untyped JSON parse.
 */
export function toSimpleCompanies(rows: readonly UserCompanyRow[]): SimpleCompany[] {
  return rows
    .filter(r => Boolean(r?.companyId))
    .map(r => ({ id: r.companyId, name: r.companyName }));
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
