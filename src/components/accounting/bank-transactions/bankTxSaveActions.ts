/**
 * The two fire-and-forget row saves of the bank-transactions page, split out of useBankTxActions (300-line rule).
 * saveSelection moves a line between Unallocated and Suggested, so a successful save asks for a summary refresh
 * (`onSelectionSaved`; the page hands a debounced one, since coding by keyboard saves on every edit); the list is not
 * reloaded because the row on screen already shows the choice. saveDimensions changes no count.
 */

import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import type { AllocType } from '@/components/accounting/BankTxTable';

const ACTION_URL = '/api/accounting/bank-transactions-action';
const post = (body: Record<string, unknown>) => apiFetch(ACTION_URL, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
});

/**
 * `onFailure` puts the row back as it was before the edit (WP3): the grid shows an edit the moment it is made, so a save
 * the server refused must not leave the row showing a choice that was never stored.
 */
export function buildSaveActions(onSelectionSaved: () => void) {
  /** Resolves true when stored. `silent`: the caller reports failures itself (a Batch Edit says it once, not once per row). */
  const saveSelection = (txId: string, type: AllocType, entityId: string, vatCode?: string, onFailure?: () => void, silent = false): Promise<boolean> =>
    post({ action: 'save_selection', bankTransactionId: txId, selectionType: type, selectionEntityId: entityId || undefined, vatCode: vatCode || undefined })
      .then(r => assertOk(r, 'Could not save the selection - try again'))
      .then(() => { onSelectionSaved(); return true; })
      .catch(e => { onFailure?.(); if (!silent) notify.error(apiErrorMessage(e, 'Could not save the selection - try again')); return false; });

  const saveDimensions = (txId: string, cc1Id: string, cc2Id: string, buId: string, onFailure?: () => void) => {
    post({ action: 'save_dimensions', bankTransactionId: txId, cc1Id: cc1Id || null, cc2Id: cc2Id || null, buId: buId || null })
      .then(r => assertOk(r, 'Could not save the cost centres - try again'))
      .catch(e => { onFailure?.(); notify.error(apiErrorMessage(e, 'Could not save the cost centres - try again')); });
  };

  return { saveSelection, saveDimensions };
}
