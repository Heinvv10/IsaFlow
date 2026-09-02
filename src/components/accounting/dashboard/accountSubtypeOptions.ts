/**
 * Subtype options for the Chart of Accounts pickers, derived from the same
 * runtime map the server validates against.
 *
 * The previous list was a private const inside ChartOfAccountsTab, reachable
 * only from the Add Account dialog. Deriving it means a dropdown can never
 * offer a value the API will refuse, and adding a subtype to the domain map
 * makes it selectable everywhere at once — the two lists cannot drift because
 * there is only one list.
 *
 * Reserved subtypes are filtered out: `subtypeErrorFor` refuses them, so
 * offering them would be a menu of guaranteed failures.
 */

import {
  GL_ACCOUNT_SUBTYPES_BY_TYPE,
  SYSTEM_RESERVED_SUBTYPES,
  type GLAccountSubtype,
  type GLAccountType,
} from '@/modules/accounting/types/gl.types';

const LABEL_OVERRIDES: Partial<Record<GLAccountSubtype, string>> = {
  accumulated_depreciation: 'Accum. Depreciation',
  vat_input: 'VAT Input',
  vat_output: 'VAT Output',
};

function toLabel(value: string): string {
  return (
    LABEL_OVERRIDES[value as GLAccountSubtype] ??
    value.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  );
}

export interface SubtypeOption {
  value: string;
  label: string;
}

export function subtypeOptionsFor(accountType: GLAccountType | string): SubtypeOption[] {
  const all = GL_ACCOUNT_SUBTYPES_BY_TYPE[accountType as GLAccountType] as
    | readonly GLAccountSubtype[]
    | undefined;
  if (!all) return [];
  return all
    .filter(s => !SYSTEM_RESERVED_SUBTYPES.includes(s))
    .map(s => ({ value: s, label: toLabel(s) }));
}
