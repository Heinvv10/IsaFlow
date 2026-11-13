/**
 * `create_credit_note`'s `mirror_bill` / `acknowledge_vat_already_reversed` / `vat_amount` arguments (brief step 5b).
 * The plan itself is the service's (ap/supplierCreditNoteMirror); this file only reads the arguments and shapes the
 * reply, so the tool stays under the line cap.
 */
import type { MirrorAck, MirrorPlan } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';
import { hasWholeCents } from './toolHelpers';

export const MIRROR_ARG_SCHEMA = {
  mirror_bill: {
    type: 'boolean',
    description: 'Supplier notes only, needs supplier_invoice_id, excludes tax_rate. The note\'s VAT is taken from the bill AS IT '
      + 'STANDS NOW: subtotal x the VAT its posting, reversals and credit notes leave / the base they leave, other open drafts '
      + 'on the bill netted off (see document_vat_history). The expense side mirrors the bill at approve whether or not this is '
      + 'set. Refused when the subtotal is more than the bill still carries, and — unless acknowledge_vat_already_reversed — '
      + 'when the bill\'s VAT is out of proportion to its base or a journal naming the bill moved its VAT (a second reversal '
      + 'would misstate the VAT201). Approval re-checks the note against the bill.',
  },
  acknowledge_vat_already_reversed: {
    type: 'boolean',
    description: 'Only with mirror_bill, after its VAT_ALREADY_REVERSED refusal, once you have checked the journals it names are '
      + 'about this bill. Needs vat_amount.',
  },
  vat_amount: {
    type: 'number',
    minimum: 0,
    description: 'Only with acknowledge_vat_already_reversed: the VAT this note reverses (whole cents), at most what the bill\'s '
      + 'posting, reversals and credit notes leave on this share. The refusal suggests one.',
  },
} as const;

export type MirrorArgs = { error: string } | { mirror: boolean; ack: MirrorAck };

export function readMirrorArgs(
  args: Record<string, unknown>, type: string, supplierInvoiceId: string | undefined,
): MirrorArgs {
  for (const key of ['mirror_bill', 'acknowledge_vat_already_reversed'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') return { error: `${key} must be true or false` };
  }
  const mirror = args.mirror_bill === true;
  const acknowledged = args.acknowledge_vat_already_reversed === true;
  const raw = args.vat_amount;
  if (raw !== undefined && raw !== null && !acknowledged) return { error: 'vat_amount only applies with acknowledge_vat_already_reversed: true' };
  if (acknowledged && !mirror) return { error: 'acknowledge_vat_already_reversed only applies with mirror_bill: true' };
  let vatAmount: number | null = null;
  if (raw !== undefined && raw !== null) {
    vatAmount = Number(raw);
    if (typeof raw !== 'number' || !Number.isFinite(vatAmount) || vatAmount < 0 || !hasWholeCents(vatAmount)) {
      return { error: 'vat_amount must be a number of rand, zero or more, in whole cents' };
    }
  }
  if (!mirror) return { mirror, ack: { acknowledged, vatAmount } };
  if (type !== 'supplier') return { error: 'mirror_bill applies to supplier credit notes only' };
  if (!supplierInvoiceId) return { error: 'mirror_bill needs supplier_invoice_id: the bill whose VAT the note mirrors' };
  if (args.tax_rate !== undefined && args.tax_rate !== null) {
    return { error: 'mirror_bill takes the VAT from the bill; leave tax_rate out' };
  }
  return { mirror, ack: { acknowledged, vatAmount } };
}

export function mirrorReply(plan: MirrorPlan): Record<string, unknown> {
  return {
    vat_basis: plan.basis,
    bill_vat_rate_now: plan.billVatRateNow,
    bill_vat_net_now: plan.vatNetNow,
    bill_net_base_now: plan.netBaseNow,
    vat_out_of_proportion: plan.vatOutOfProportion,
    vat_heuristic: plan.vatHeuristic,
    heuristic_search: plan.heuristicSearched ? 'ran' : 'not run: no searchable number or no VAT account on the bill',
    adjusting_journals: plan.adjustingJournals,
    acknowledged_vat_already_reversed: plan.basis === 'mirror_bill_ack',
  };
}
