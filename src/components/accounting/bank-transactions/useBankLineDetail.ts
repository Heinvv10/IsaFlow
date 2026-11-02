/**
 * Which line the bank line drawer has open. Cleared, not just hidden, when the line leaves the list: a line that came
 * back (an Undo, a reload, another tab) would otherwise reopen a drawer nobody asked for.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useBankLineDetail(transactions: BankTx[]) {
  const [detailTxId, setDetailTxId] = useState<string | null>(null);
  const detailTx = transactions.find((t) => t.id === detailTxId);
  useEffect(() => {
    if (detailTxId !== null && !detailTx) setDetailTxId(null);
  }, [detailTxId, detailTx]);
  const closeDetail = useCallback(() => setDetailTxId(null), []);
  return { detailTx, openDetail: setDetailTxId, closeDetail };
}
