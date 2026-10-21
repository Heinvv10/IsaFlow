/**
 * Is a Sage contact or document in the home currency? Fail closed.
 *
 * Sage SA reports a contact's currency as `CurrencyId` (an id into
 * Currency/Get) and `CurrencySymbol`, and a document's as
 * `Customer_CurrencyId` / `Supplier_CurrencyId` with an exchange rate. The API
 * help pages name these fields but not what a HOME-currency contact carries:
 * null, 0, or the home currency's own id are all plausible. So:
 *   - a symbol that is not the home symbol is foreign;
 *   - no id (null / 0) is home;
 *   - an id Currency/Get resolves is foreign unless its code is the home code;
 *   - an id that cannot be resolved (not in the list, or the list could not be
 *     read) is treated as foreign: the import blocks rather than take a
 *     foreign balance on as rand.
 */
import type { SageCurrency } from './sageApiTypes';

export interface CurrencyRule {
  /** The IsaFlow company's functional currency, e.g. 'ZAR'. */
  homeCode: string;
  /** The symbol Sage shows for it, e.g. 'R'. */
  homeSymbol: string;
  /** Currency/Get by id; null when the pull could not read it. */
  byId: ReadonlyMap<number, SageCurrency> | null;
}

export function currencyRule(homeCode: string, homeSymbol: string, currencies: readonly SageCurrency[] | null): CurrencyRule {
  return { homeCode: homeCode.toUpperCase(), homeSymbol, byId: currencies ? new Map(currencies.map((c) => [c.ID, c])) : null };
}

/** What makes it foreign (for the message), or null when it is in the home currency. */
export function foreignCurrency(currencyId: number | null | undefined, symbol: string | null | undefined, rule: CurrencyRule): string | null {
  const s = symbol?.trim();
  if (s && s.toLowerCase() !== rule.homeSymbol.toLowerCase()) return s;
  if (currencyId == null || currencyId === 0) return null;
  const c = rule.byId?.get(currencyId);
  if (!c) return `Sage currency id ${currencyId}, which IsaFlow could not identify`;
  return c.Code.trim().toUpperCase() === rule.homeCode ? null : c.Code.trim();
}
