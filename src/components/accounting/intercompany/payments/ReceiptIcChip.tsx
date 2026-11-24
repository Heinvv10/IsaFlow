/**
 * The receipt's intercompany chip (F, (l) LOW-2): when a payment message TARGETS this receipt (never by its `IC:` text alone), the
 * database's state word ("Intercompany: matched", "... payer voided or changed it"). Nothing otherwise, and nothing when it cannot be read.
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import type { PaymentState } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { CHIP_LABEL, STATE_TONE, TONE_CLASS } from './paymentLabels';

export function ReceiptIcChip({ receiptId }: { receiptId: string }) {
  const [state, setState] = useState<PaymentState | null>(null);
  useEffect(() => {
    let current = true;
    setState(null);
    apiJson(`/api/accounting/intercompany/payments/receipt-state?receiptId=${encodeURIComponent(receiptId)}`, undefined, '')
      .then((r) => { if (current) setState((r as { state?: PaymentState } | null)?.state ?? null); })
      .catch(() => { if (current) setState(null); });
    return () => { current = false; };
  }, [receiptId]);
  if (!state) return null;
  return (
    <span data-testid="receipt-ic-chip" className={`px-2.5 py-1 rounded-full text-xs font-medium border ${TONE_CLASS[STATE_TONE[state] ?? 'muted']}`}>
      Intercompany: {CHIP_LABEL[state] ?? CHIP_LABEL.check_failed}
    </span>
  );
}
