/**
 * `create_credit_note`'s `mirror_bill` / `acknowledge_vat_already_reversed` arguments (brief step 5b).
 * The plan itself is the service's (ap/supplierCreditNoteMirror); this file only reads the arguments and
 * shapes the reply, so the tool stays under the line cap.
 */
import type { MirrorPlan } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';

export const MIRROR_ARG_SCHEMA = {
  mirror_bill: {
    type: 'boolean',
    description: 'Supplier notes only, needs supplier_invoice_id, excludes tax_rate. The note\'s VAT is taken from the bill AS IT '
      + 'STANDS NOW (document_vat_history): subtotal x the VAT the bill still carries / the base it still carries, after its '
      + 'reversals, credit notes and journals that name it. The expense side mirrors the bill at approve whether or not this is '
      + 'set (each bill leg\'s account, job, CC1, CC2, BU, pro rata, capped by earlier notes). Refused when the subtotal is more '
      + 'than the bill still carries, and — unless acknowledge_vat_already_reversed — when the bill\'s VAT was already reversed '
      + 'out of proportion to its base (a second reversal would misstate the VAT201).',
  },
  acknowledge_vat_already_reversed: {
    type: 'boolean',
    description: 'Only with mirror_bill, after its VAT_ALREADY_REVERSED refusal: create the note carrying the bill\'s VAT as it stands now.',
  },
} as const;

export type MirrorArgs = { error: string } | { mirror: boolean; acknowledged: boolean };

export function readMirrorArgs(
  args: Record<string, unknown>, type: string, supplierInvoiceId: string | undefined,
): MirrorArgs {
  for (const key of ['mirror_bill', 'acknowledge_vat_already_reversed'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') return { error: `${key} must be true or false` };
  }
  const mirror = args.mirror_bill === true;
  const acknowledged = args.acknowledge_vat_already_reversed === true;
  if (acknowledged && !mirror) return { error: 'acknowledge_vat_already_reversed only applies with mirror_bill: true' };
  if (!mirror) return { mirror, acknowledged };
  if (type !== 'supplier') return { error: 'mirror_bill applies to supplier credit notes only' };
  if (!supplierInvoiceId) return { error: 'mirror_bill needs supplier_invoice_id: the bill whose VAT the note mirrors' };
  if (args.tax_rate !== undefined && args.tax_rate !== null) {
    return { error: 'mirror_bill takes the VAT from the bill; leave tax_rate out' };
  }
  return { mirror, acknowledged };
}

export function mirrorReply(plan: MirrorPlan, acknowledged: boolean): Record<string, unknown> {
  return {
    bill_vat_rate_now: plan.billVatRateNow,
    bill_vat_net_now: plan.vatNetNow,
    bill_net_base_now: plan.netBaseNow,
    vat_out_of_proportion: plan.vatOutOfProportion,
    adjusting_journals: plan.adjustingJournals,
    acknowledged_vat_already_reversed: acknowledged,
  };
}
