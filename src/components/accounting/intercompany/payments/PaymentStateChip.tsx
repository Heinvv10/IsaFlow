/** The state word of a payment message as a chip (intercompany F). */
import type { PaymentState } from '@/modules/accounting/services/intercompany/paymentInboxTypes';
import { STATE_LABEL, STATE_TONE, TONE_CLASS } from './paymentLabels';

export function PaymentStateChip({ state }: { state: PaymentState }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full border ${TONE_CLASS[STATE_TONE[state] ?? 'muted']}`}>
      {STATE_LABEL[state] ?? STATE_LABEL.check_failed}
    </span>
  );
}
