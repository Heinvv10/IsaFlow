/**
 * The receipt's intercompany chip (F, (l) LOW-2): when a payment message TARGETS this receipt (never by its `IC:` text alone), the
 * database's state word ("Intercompany: matched", "... payer voided or changed it"). Nothing otherwise, and nothing when it cannot be read.
 * Round 1: with the dark flag off for the company (the nav's answer) it asks nothing (B8); an ORPHAN F draft (stamped for an id that is no
 * payment message of this company, which Confirm refuses) says so and offers its discard (LOW-3).
 * Round 2 (LOW-R3): a receipt STAMPED `IC:<uuid>` (not a contra: P4-D stamps its contra receipts) asks whatever the flag, and a stamped
 * draft offers its Discard (of the message that targets it, or the orphan's): with the flag off Confirm refuses an F draft and the
 * intercompany page is hidden, so this is its only exit. The flag decides only for a receipt with no stamp (the extra request).
 */
import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
import { useNavFlags } from '@/hooks/useNavFlags';
import type { PaymentState } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { CHIP_LABEL, STATE_TONE, TONE_CLASS } from './paymentLabels';
import { PaymentDiscardModal } from './PaymentDiscardModal';

const FLAG = 'intercompany_loan_clearing';
/** icDraftConfirmGate's stamp: `IC:<message id>` */
const STAMP = /^IC:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
type Answer = { messageId: string; state: PaymentState; status: string };

interface Props {
  receiptId: string;
  paymentNumber?: string;
  bankReference?: string | null;
  paymentMethod?: string;
  receiptStatus?: string;
  onChanged?: () => void;
}

export function ReceiptIcChip({ receiptId, paymentNumber, bankReference, paymentMethod, receiptStatus, onChanged }: Props) {
  const stamp = paymentMethod !== 'contra' ? STAMP.exec((bankReference ?? '').trim())?.[1]?.toLowerCase() ?? null : null;
  const enabled = useNavFlags().has(FLAG) || stamp !== null;
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
  const discardable = orphan || (receiptStatus === 'draft' && stamp === answer.messageId.toLowerCase() && answer.status === 'accepted');
  const number = paymentNumber ?? receiptId.slice(0, 8);
  return (
    <>
      <span data-testid="receipt-ic-chip" className={`px-2.5 py-1 rounded-full text-xs font-medium border ${TONE_CLASS[orphan ? 'warn' : STATE_TONE[answer.state] ?? 'muted']}`}>
        Intercompany: {CHIP_LABEL[answer.state] ?? CHIP_LABEL.check_failed}
      </span>
      {discardable && (
        <button type="button" onClick={() => setDiscarding(true)}
          className="px-2.5 py-1 text-xs rounded-lg border border-line text-ink hover:bg-surface-sunken">Discard draft {number}</button>
      )}
      <PaymentDiscardModal open={discarding} messageId={answer.messageId}
        target={discardable ? { paymentId: receiptId, paymentNumber: number, status: 'draft', isDraft: true } : null}
        orphan={orphan} onClose={() => setDiscarding(false)} onDone={() => { setDiscarding(false); setAnswer(null); onChanged?.(); }} />
    </>
  );
}
