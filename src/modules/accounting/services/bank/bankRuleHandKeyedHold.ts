/**
 * The bank-rule sweep's gates for a HAND-KEYED line (moved out of bankRuleAutoPostLine, its line cap): is this
 * line's rule post one nobody decided? Each is skipped (counted `approval_required`), from reads, before any write.
 * Feed and imported lines are bank evidence and are never held here.
 *
 *  - R-035 PR5 (Hein, D2): a SUPPLIER rule paying out is a payment instruction, under an enforced supplier_payment rule
 *    (a deposit is a refund in: not gated);
 *  - R-035 PR6 (Hein, H2; round 4): an ACCOUNT rule is a manual journal, under an enforced manual_journal rule,
 *    whatever ran the sweep (rules applied, a statement import, a reversed allocation back in 'imported');
 *  - Hein 2026-11-15: a CUSTOMER rule paying out is a refund, under the same manual_journal rules (bankLineRefundGate).
 */
import type { DbRow } from '@/lib/neon';
import { isBankEvidenced, manualLinePaymentRefusal } from '../ap/bankLinePaymentGate';
import { handKeyedLineJournalRefusal } from './bankLineJournalGate';
import { handKeyedRefundRefusal } from './bankLineRefundGate';

export async function handKeyedRuleLineHeld(args: {
  companyId: string; locked: DbRow; allocType: string; supplierId: string | null; isDeposit: boolean; totalAmount: number;
}): Promise<boolean> {
  const { companyId, locked, allocType, supplierId, isDeposit, totalAmount } = args;
  if (isBankEvidenced(locked)) return false;
  if (allocType === 'supplier' && supplierId && !isDeposit) return (await manualLinePaymentRefusal(companyId, totalAmount)) !== null;
  if (allocType === 'account') return (await handKeyedLineJournalRefusal(companyId, totalAmount)) !== null;
  if (allocType === 'customer' && !isDeposit) return (await handKeyedRefundRefusal(companyId, totalAmount)) !== null;
  return false;
}
