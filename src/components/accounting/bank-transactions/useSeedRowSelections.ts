/**
 * Seed each row's selection from its DB suggestion fields (suggestedRowSelections) whenever the loaded
 * transactions change, never overwriting an entity the user already picked. Extracted from the bank
 * transactions page (300-line rule).
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';
import { suggestedRowSelections } from './suggestedRowSelections';

export function useSeedRowSelections(
  transactions: BankTx[], rowSelections: Record<string, RowSelection>,
  setRowSelections: Dispatch<SetStateAction<Record<string, RowSelection>>>,
): void {
  useEffect(() => {
    if (transactions.length === 0) return;
    const initial = suggestedRowSelections(transactions, rowSelections);
    if (Object.keys(initial).length > 0) {
      setRowSelections(prev => {
        const merged = { ...prev };
        for (const [id, sel] of Object.entries(initial)) { if (!merged[id]?.entityId) merged[id] = sel; }
        return merged;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);
}
