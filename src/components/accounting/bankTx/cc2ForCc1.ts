/**
 * The CC1 -> CC2 ladder on a bank row (#1653). A CC2 (project) belongs to the CC1 (FNO) its parent chain reaches.
 * Two keys say so, and either is enough:
 *  - `fnoCode`, which the server derives from the chain (`listDimensionCostCentres`), matched on the CC1's code
 *    (unique per company): a project under a programme CC2 belongs to the programme's FNO;
 *  - `parentId`, walked up through the CC2 options, so a CC2 linked to its CC1 by parent still lists when the
 *    derivation reached no FNO for it.
 * Posting derives CC1 from CC2 and refuses a CC2 whose FNO is another CC1, so the row offers only the chosen CC1's
 * CC2s and drops a CC2 of another CC1 when the CC1 changes.
 */
import type { SelectOption } from './bankTxTypes';

/** Deeper than any real ladder (FNO > programme > project); also stops a parent cycle. */
const MAX_DEPTH = 16;

/** Whether `cc2` files under the CC1 `cc1` by its fnoCode or by its parent chain. */
function belongsTo(cc2: SelectOption, cc1: SelectOption, byId: ReadonlyMap<string, SelectOption>): boolean {
  if (cc1.code && cc2.fnoCode === cc1.code) return true;
  const seen = new Set<string>([cc2.id]);
  let cursor = cc2.parentId ?? null;
  for (let depth = 0; cursor && depth < MAX_DEPTH && !seen.has(cursor); depth++) {
    if (cursor === cc1.id) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

const indexById = (cc2Options: readonly SelectOption[]) => new Map(cc2Options.map(o => [o.id, o]));

/** The chosen CC1, or undefined when there is none or it is not among the (active) options. */
function chosenCc1(cc1Options: readonly SelectOption[], cc1Id: string | undefined): SelectOption | undefined {
  return cc1Id ? cc1Options.find(o => o.id === cc1Id) : undefined;
}

/**
 * The CC2 options for a CC1: all of them when no known CC1 is chosen (never an empty list for "no CC1"), else exactly
 * the CC2s under it. `keepId` (the row's current CC2) stays listed so its trigger keeps its own label rather than
 * reading as inactive.
 */
export function cc2OptionsForCc1(
  cc2Options: readonly SelectOption[], cc1Options: readonly SelectOption[], cc1Id: string | undefined, keepId?: string,
): SelectOption[] {
  const cc1 = chosenCc1(cc1Options, cc1Id);
  if (!cc1) return [...cc2Options];
  const byId = indexById(cc2Options);
  return cc2Options.filter(o => belongsTo(o, cc1, byId) || (!!keepId && o.id === keepId));
}

/**
 * The CC2 a row keeps when its CC1 becomes `cc1Id`: cleared when it is a known CC2 under another CC1; kept when it
 * is under the new CC1, when no known CC1 is chosen, or when it is a stored id the active options lack.
 */
export function cc2AfterCc1Change(
  cc2Id: string, cc1Id: string, cc2Options: readonly SelectOption[], cc1Options: readonly SelectOption[],
): string {
  if (!cc2Id) return '';
  const cc1 = chosenCc1(cc1Options, cc1Id);
  const byId = indexById(cc2Options);
  const cc2 = byId.get(cc2Id);
  if (!cc1 || !cc2) return cc2Id;
  return belongsTo(cc2, cc1, byId) ? cc2Id : '';
}
