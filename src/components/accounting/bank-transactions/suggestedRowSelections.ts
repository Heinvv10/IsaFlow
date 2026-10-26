/**
 * suggestedRowSelections — the row selections the DB's suggestion fields imply
 * (supplier, then customer, then GL account), for rows the user has not
 * already picked an entity on.
 */

import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

export function suggestedRowSelections(
  transactions: BankTx[], current: Record<string, RowSelection>,
): Record<string, RowSelection> {
  const initial: Record<string, RowSelection> = {};
  for (const tx of transactions) {
    if (current[tx.id]?.entityId) continue;
    const dim = { cc1Id: tx.cc1Id, cc2Id: tx.cc2Id, buId: tx.buId };
    if (tx.suggestedSupplierId) {
      initial[tx.id] = { type: 'supplier', entityId: tx.suggestedSupplierId, label: tx.suggestedSupplierName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
    } else if (tx.suggestedClientId) {
      initial[tx.id] = { type: 'customer', entityId: tx.suggestedClientId, label: tx.suggestedClientName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
    } else if (tx.suggestedGlAccountId) {
      initial[tx.id] = { type: 'account', entityId: tx.suggestedGlAccountId, vatCode: (tx.suggestedVatCode || 'none') as RowSelection['vatCode'], ...dim,
        label: tx.suggestedGlAccountCode ? `${tx.suggestedGlAccountCode} ${tx.suggestedGlAccountName || ''}` : tx.suggestedGlAccountName || tx.suggestedCategory || '' };
    }
  }
  return initial;
}
