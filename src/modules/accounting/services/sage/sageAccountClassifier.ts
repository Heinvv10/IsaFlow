/**
 * Which IsaFlow account type, normal balance and subtype a Sage account takes.
 *
 * Classified by the category DESCRIPTION, never its id. Category ids differ per
 * Sage installation: on a live company (2026-10-21) id 7 was "Non-Current
 * Liabilities" and id 9 "Owners Equity", the reverse of what the older admin
 * importer's id table assumed, so loans came in as equity.
 *
 * Never returns a reserved system subtype (vat_*, receivable, payable,
 * retained_earnings, default_*, admin_expense, depreciation…): those are roles,
 * and only the take-on's system account map may place a role.
 */
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import type { SystemAccountMap } from '../core/migrationCoaService';
import type { SageAccount } from './sageApiTypes';

export type SageClassification =
  | { ok: true; accountType: GLAccountType; normalBalance: 'debit' | 'credit'; accountSubtype: string }
  | { ok: false; reason: string };

interface CategoryRule { type: GLAccountType; subtype: string }

const CATEGORY_RULES: Record<string, CategoryRule> = {
  'sales': { type: 'revenue', subtype: 'revenue' },
  'revenue': { type: 'revenue', subtype: 'revenue' },
  'other income': { type: 'revenue', subtype: 'other' },
  'cost of sales': { type: 'expense', subtype: 'cost_of_sales' },
  'expenses': { type: 'expense', subtype: 'operating_expense' },
  'income tax': { type: 'expense', subtype: 'other' },
  'non current assets': { type: 'asset', subtype: 'fixed_asset' },
  'fixed assets': { type: 'asset', subtype: 'fixed_asset' },
  'current assets': { type: 'asset', subtype: 'other_current_asset' },
  'non current liabilities': { type: 'liability', subtype: 'long_term_liability' },
  'long term liabilities': { type: 'liability', subtype: 'long_term_liability' },
  'current liabilities': { type: 'liability', subtype: 'other_current_liability' },
  'owners equity': { type: 'equity', subtype: 'equity' },
  'equity': { type: 'equity', subtype: 'equity' },
};

const NORMAL: Record<GLAccountType, 'debit' | 'credit'> = {
  asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit',
};

function normaliseCategory(raw: string): string {
  return raw.toLowerCase().replace(/['’]/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A finer subtype from the account name, within the type the category gave. */
function refineByName(name: string, rule: CategoryRule): string {
  const n = name.toLowerCase();
  if (rule.type === 'expense' && /\b(bank charges|interest)\b/.test(n)) return 'finance_cost';
  if (rule.type === 'asset') {
    if (/accumulated depreciation|acc\.? dep/.test(n)) return 'other';
    if (/\b(inventory|stock)\b/.test(n)) return 'inventory';
    if (/\b(petty cash|cash on hand|cash float)\b/.test(n)) return 'cash';
  }
  if (rule.type === 'liability' && /\b(paye|uif|sdl|sars|income tax|provisional tax)\b/.test(n)) return 'tax';
  return rule.subtype;
}

export function classifySageAccount(account: SageAccount): SageClassification {
  if (account.AccountType === 3) {
    return { ok: true, accountType: 'asset', normalBalance: 'debit', accountSubtype: 'bank' };
  }
  const description = account.Category?.Description;
  if (!description || !description.trim()) return { ok: false, reason: 'Sage gave no account category' };
  const rule = CATEGORY_RULES[normaliseCategory(description)];
  if (!rule) return { ok: false, reason: `Unknown Sage account category "${description.trim()}"` };
  return {
    ok: true,
    accountType: rule.type,
    normalBalance: NORMAL[rule.type],
    accountSubtype: refineByName(account.Name, rule),
  };
}

/** Sage's own system accounts (negative ids) that hold an IsaFlow role. */
const SYSTEM_ROLES: Record<number, keyof SystemAccountMap> = {
  [-1]: 'default_revenue',
  [-2]: 'default_expense',
  [-7]: 'receivable',
  [-8]: 'payable',
  [-9]: 'vat_output',
  [-11]: 'retained_earnings',
};

export function sageSystemRole(sageAccountId: number): keyof SystemAccountMap | null {
  return SYSTEM_ROLES[sageAccountId] ?? null;
}
