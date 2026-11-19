/**
 * The CC1 -> CC2 ladder on a bank row (#1653). A CC2 (project) belongs to the CC1 (FNO) its parent chain reaches,
 * which the server derives and returns as `fnoCode` (`listDimensionCostCentres`): a project under a programme CC2
 * belongs to the programme's FNO, and an overhead CC2 under Head Office belongs to Head Office. Matched on the CC1's
 * code, which is unique per company. Posting derives CC1 from CC2 and refuses a CC2 whose FNO is another CC1, so the
 * row offers only the chosen CC1's CC2s and drops a CC2 of another CC1 when the CC1 changes.
 */
import type { SelectOption } from './bankTxTypes';

/** The chosen CC1's code, or null when there is no CC1 or it is not among the (active) options. */
function cc1Code(cc1Options: readonly SelectOption[], cc1Id: string | undefined): string | null {
  if (!cc1Id) return null;
  return cc1Options.find(o => o.id === cc1Id)?.code ?? null;
}

/**
 * The CC2 options for a CC1: all of them when no known CC1 is chosen, else exactly the CC2s under it. `keepId` (the
 * row's current CC2) stays listed so its trigger keeps its own label rather than reading as inactive.
 */
export function cc2OptionsForCc1(
  cc2Options: readonly SelectOption[], cc1Options: readonly SelectOption[], cc1Id: string | undefined, keepId?: string,
): SelectOption[] {
  const code = cc1Code(cc1Options, cc1Id);
  if (code === null) return [...cc2Options];
  return cc2Options.filter(o => o.fnoCode === code || (!!keepId && o.id === keepId));
}

/**
 * The CC2 a row keeps when its CC1 becomes `cc1Id`: cleared when it is a known CC2 under another CC1; kept when it
 * is under the new CC1, when no known CC1 is chosen, or when it is a stored id the active options lack.
 */
export function cc2AfterCc1Change(
  cc2Id: string, cc1Id: string, cc2Options: readonly SelectOption[], cc1Options: readonly SelectOption[],
): string {
  if (!cc2Id) return '';
  const code = cc1Code(cc1Options, cc1Id);
  const cc2 = cc2Options.find(o => o.id === cc2Id);
  if (code === null || !cc2) return cc2Id;
  return cc2.fnoCode === code ? cc2Id : '';
}
