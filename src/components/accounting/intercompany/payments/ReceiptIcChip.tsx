/**
 * The receipt's intercompany chip (F, (l) LOW-2): when a payment message TARGETS this receipt (never by its `IC:` text alone), the
 * database's state word ("Intercompany: matched", "... payer voided or changed it"). Nothing otherwise, and nothing when it cannot be read.
 * Round 1: with the dark flag off for the company (the nav's answer) it asks nothing (B8); an ORPHAN F draft (stamped for an id that is no
 * payment message of this company, which Confirm refuses) says so and offers its discard (LOW-3).
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { useNavFlags } from '@/hooks/useNavFlags';
import type { PaymentState } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { CHIP_LABEL, STATE_TONE, TONE_CLASS } from './paymentLabels';
import { PaymentDiscardModal } from './PaymentDiscardModal';

const FLAG = 'intercompany_loan_clearing';
type Answer = { messageId: string; state: PaymentState; status: string };

export function ReceiptIcChip({ receiptId, paymentNumber, onChanged }: { receiptId: string; paymentNumber?: string; onChanged?: () => void }) {
  const enabled = useNavFlags().has(FLAG);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [discarding, setDiscarding] = useState(false);
  useEffect(() => {
    let current = true;
    setAnswer(null);
    if (!enabled) return () => { current = false; };
    apiJson(`/api/accounting/intercompany/payments/receipt-state?receiptId=${encodeURIComponent(receiptId)}`, undefined, '')
      .then((r) => { if (current) setAnswer((r as Answer | null) ?? null); })
      .catch(() => { if (current) setAnswer(null); });
    return () => { current = false; };
  }, [receiptId, enabled]);
  if (!enabled || !answer?.state) return null;
  const orphan = answer.status === 'orphan';
  const number = paymentNumber ?? receiptId.slice(0, 8);
  return (
    <>
      <span data-testid="receipt-ic-chip" className={`px-2.5 py-1 rounded-full text-xs font-medium border ${TONE_CLASS[orphan ? 'warn' : STATE_TONE[answer.state] ?? 'muted']}`}>
        Intercompany: {CHIP_LABEL[answer.state] ?? CHIP_LABEL.check_failed}
      </span>
      {orphan && (
        <button type="button" onClick={() => setDiscarding(true)}
          className="px-2.5 py-1 text-xs rounded-lg border border-line text-ink hover:bg-surface-sunken">Discard draft {number}</button>
      )}
      <PaymentDiscardModal open={discarding} messageId={answer.messageId}
        target={orphan ? { paymentId: receiptId, paymentNumber: number, status: 'draft', isDraft: true } : null}
        orphan onClose={() => setDiscarding(false)} onDone={() => { setDiscarding(false); setAnswer(null); onChanged?.(); }} />
    </>
  );
}
