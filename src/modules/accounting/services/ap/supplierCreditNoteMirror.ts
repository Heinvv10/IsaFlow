/**
 * `mirror_bill` for a SUPPLIER credit note (MCP `create_credit_note`; brief step 5b, 2026-11-13).
 *
 * What already exists, and is NOT rebuilt here: at approval a note LINKED to a
 * bill credits that bill's own expense legs — account, job, CC1, CC2, BU — pro
 * rata, each capped at what earlier notes left it (migration 892,
 * supplierCreditNoteExpenseLines.ts). The 5100 (default_expense) fallback now
 * bites only for an unlinked note with no `gl_account_id`, a linked bill with
 * no journal, and whatever exceeds the legs.
 *
 * What did not exist: the note's VAT. Approval credits VAT input with the
 * note's own `tax_amount`, which `create_credit_note` computed as subtotal x
 * tax_rate (default 15%) — blind to the bill's own rate and to VAT a journal
 * had already reversed. SIV3762: JE-2026-26788 reversed its input VAT by hand,
 * CN-557 (15% default) reversed it again, JE-2026-31949 put R260.87 back.
 *
 * So a mirrored note takes its VAT from the bill AS IT STANDS NOW
 * (`getDocumentVatHistory`): tax = subtotal x vat_net_now / net_base_now, the
 * whole remaining VAT when the note takes the whole remaining base. And it is
 * REFUSED, unless acknowledged, when the bill's VAT no longer stands in
 * proportion to its base — VAT reversed (or added) by something other than a
 * credit note for the same base — because that is the double reversal, and the
 * journals that did it are found partly by heuristic.
 *
 * The figure is fixed on the draft. Approval does not re-read it: a note or
 * journal posted against the bill between create and approve is not seen.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { getDocumentVatHistory, type DocumentVatHistory, type DocumentVatLine } from '../reports/documentVatHistory';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => formatMoney(n);

export interface MirrorPlan {
  taxAmount: number;
  /** Display only (numeric(5,2)); the amount above is what posts. */
  taxRate: number;
  billVatRateNow: number;
  vatNetNow: number;
  netBaseNow: number;
  /** The bill's VAT at its posted rate on what it still carries, less what it carries: > 0 = already reversed. */
  vatOutOfProportion: number;
  /** Non-posting journals that moved the bill's VAT. */
  adjustingJournals: { entry_number: string | null; tie: string; vat_amount: number }[];
}

export type MirrorDecision =
  | { ok: true; plan: MirrorPlan; acknowledged: boolean }
  | { ok: false; reason: string };

function adjusting(lines: readonly DocumentVatLine[]): MirrorPlan['adjustingJournals'] {
  const byJournal = new Map<string, MirrorPlan['adjustingJournals'][number]>();
  for (const l of lines) {
    if (l.tie === 'posting') continue;
    const e = byJournal.get(l.journal_entry_id) ?? { entry_number: l.entry_number, tie: l.tie, vat_amount: 0 };
    e.vat_amount = r2(e.vat_amount + l.vat_amount);
    byJournal.set(l.journal_entry_id, e);
  }
  return [...byJournal.values()].filter((e) => e.vat_amount !== 0);
}

/** Pure: the mirrored note's VAT, or why it cannot be mirrored. */
export function planMirroredNote(h: DocumentVatHistory, subtotal: number, acknowledged: boolean): MirrorDecision {
  const { vat_posted: vatPosted, vat_net_now: vatNetNow, net_base_posted: basePosted, net_base_now: baseNow } = h.totals;
  const bill = h.document_number;
  if (basePosted <= 0) {
    return { ok: false, reason: `Bill ${bill} has no posted journal with an expense base to mirror (status ${h.document_status}). Approve it first, or raise the note without mirror_bill.` };
  }
  if (baseNow <= 0.005) {
    return { ok: false, reason: `Bill ${bill} carries nothing any more: its credit notes and reversals have taken its whole base (${fmt(basePosted)}). There is nothing to mirror.` };
  }
  if (subtotal > baseNow + 0.005) {
    return { ok: false, reason: `subtotal ${fmt(subtotal)} is more than the ${fmt(baseNow)} bill ${bill} still carries after its credit notes and reversals. A mirrored note cannot credit more than the bill has left; lower the subtotal, or raise the note without mirror_bill.` };
  }
  const postedRate = vatPosted / basePosted;
  const adjustingJournals = adjusting(h.lines);
  const tolerance = 0.01 * (1 + adjustingJournals.length);
  const outOfProportion = r2(baseNow * postedRate - vatNetNow);
  const rateNow = Math.max(0, vatNetNow) / baseNow;
  const whole = Math.abs(subtotal - baseNow) <= 0.005;
  const taxAmount = whole ? Math.max(0, vatNetNow) : Math.min(Math.max(0, vatNetNow), r2(subtotal * rateNow));
  const plan: MirrorPlan = {
    taxAmount: r2(taxAmount), taxRate: Math.min(100, r2(rateNow * 100)), billVatRateNow: r2(rateNow * 100),
    vatNetNow, netBaseNow: baseNow, vatOutOfProportion: outOfProportion, adjustingJournals,
  };
  if (Math.abs(outOfProportion) > tolerance && !acknowledged) {
    const named = adjustingJournals.map((j) => `${j.entry_number ?? '(unnumbered)'} ${j.tie} ${fmt(j.vat_amount)}`).join('; ');
    const direction = outOfProportion > 0 ? `already reversed ${fmt(outOfProportion)} more of its VAT` : `gained ${fmt(-outOfProportion)} of VAT`;
    return {
      ok: false,
      reason: `VAT_ALREADY_REVERSED: bill ${bill} posted ${fmt(vatPosted)} VAT on ${fmt(basePosted)}; it still carries `
        + `${fmt(baseNow)} of base but only ${fmt(vatNetNow)} of VAT, so later journals have ${direction} than its credit notes `
        + `account for (${named || 'none named'}). A note at the bill's posted rate would reverse that VAT a second time — a `
        + `VAT201 misstatement. Matches by reference or narration are heuristic: check them with document_vat_history. `
        + `A mirrored note would carry ${fmt(plan.taxAmount)} VAT (${plan.billVatRateNow}% of its subtotal, the bill's VAT as it `
        + 'stands now). To create it with that VAT, call again with acknowledge_vat_already_reversed: true; if the matched '
        + 'journals are not about this bill, raise the note without mirror_bill.',
    };
  }
  return { ok: true, plan, acknowledged };
}

export async function planMirroredSupplierNote(
  companyId: string, supplierInvoiceId: string, subtotal: number, acknowledged: boolean,
): Promise<MirrorDecision> {
  const history = await getDocumentVatHistory(companyId, 'supplier_invoice', supplierInvoiceId);
  if (!history) return { ok: false, reason: 'Not found' };
  return planMirroredNote(history, subtotal, acknowledged);
}
