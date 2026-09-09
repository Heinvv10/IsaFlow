import { VAT_TAX_SUBTYPES } from '../reports/vatBoxBasis';
import { BALANCE_SHEET_TYPES, VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES } from '../reports/vatBalanceSheetExceptions';
type Row = Record<string, unknown>;

/** Mirrors the VAT201 journal population, including its unclassified exceptions. */
export function journalAffectsVatReturn(lines: readonly Row[], accounts: readonly Row[]): boolean {
  const byId = new Map(accounts.map(account => [account.id, account]));
  return lines.some(line => {
    const account = byId.get(line.gl_account_id);
    if (!account) throw new Error('VAT journal account is unavailable');
    const subtype = String(account.account_subtype ?? '');
    if ((VAT_TAX_SUBTYPES as readonly string[]).includes(subtype)) return true;
    if (line.vat_type === null || line.vat_type === undefined || line.vat_type === 'no_vat') return false;
    return subtype === 'tax' || (BALANCE_SHEET_TYPES.includes(String(account.account_type))
      && !VAT_LEGITIMATE_BALANCE_SHEET_SUBTYPES.includes(subtype));
  });
}
