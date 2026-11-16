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

export function buildSaveActions(onSelectionSaved: () => void) {
  const saveSelection = (txId: string, type: AllocType, entityId: string, vatCode?: string) => {
    post({ action: 'save_selection', bankTransactionId: txId, selectionType: type, selectionEntityId: entityId || undefined, vatCode: vatCode || undefined })
      .then(r => assertOk(r, 'Could not save the selection - try again'))
      .then(() => onSelectionSaved())
      .catch(e => notify.error(apiErrorMessage(e, 'Could not save the selection - try again')));
  };

  const saveDimensions = (txId: string, cc1Id: string, cc2Id: string, buId: string) => {
    post({ action: 'save_dimensions', bankTransactionId: txId, cc1Id: cc1Id || null, cc2Id: cc2Id || null, buId: buId || null })
      .then(r => assertOk(r, 'Could not save the cost centres - try again'))
      .catch(e => notify.error(apiErrorMessage(e, 'Could not save the cost centres - try again')));
  };

  return { saveSelection, saveDimensions };
}
