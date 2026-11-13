/**
 * `mirror_bill` for a SUPPLIER credit note (MCP `create_credit_note`; brief step 5b, 2026-11-13).
 *
 * What already exists, and is NOT rebuilt here: at approval a note LINKED to a
 * bill credits that bill's own expense legs pro rata, capped by earlier notes
 * (migration 892, supplierCreditNoteExpenseLines.ts). What did not exist: the
 * note's VAT, which was subtotal x the note's own rate (15% default), blind to
 * the bill. SIV3762: JE-2026-26788 reversed its input VAT by hand, CN-557 (15%)
 * reversed it again, JE-2026-31949 put R260.87 back.
 *
 * The note's VAT comes from the bill's DERIVABLE ties only (posting, late-claim
 * companion, reversals, credit notes — review round 1, A2): subtotal x the VAT
 * the bill still carries / the base it still carries, the exact remainder when
 * the note takes the whole remaining base. Every other open draft on the bill is
 * netted off first, under the bill's credit-note key (two drafts cannot each
 * take the whole VAT).
 *
 * It REFUSES, unless acknowledged, when (a) the derivable VAT no longer stands in
 * proportion to the base, (b) a heuristic match (a hand journal naming the bill)
 * moved its VAT, or (c) the heuristic search was cut at its limit. A heuristic
 * never WRITES: acknowledged, the caller must state `vat_amount` itself (at most
 * the derivable figure); the refusal suggests one. The tolerance is one cent per
 * adjusting journal or open draft, plus one: each note rounds its VAT to the cent.
 *
 * The draft is marked `vat_basis` 'mirror_bill' or 'mirror_bill_ack' (migration
 * 988) and approval re-runs this planner (supplierCreditNoteMirrorApprove).
 */
import { sql } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { lockInvoiceCreditNotes } from '../ar/creditNotePostingChecks';
import { getDocumentVatHistory, type DocumentVatHistory, type DocumentVatLine } from '../reports/documentVatHistory';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => formatMoney(n);

export type MirrorBasis = 'mirror_bill' | 'mirror_bill_ack';
export interface MirrorAck { acknowledged: boolean; vatAmount: number | null }
export const NO_ACK: MirrorAck = { acknowledged: false, vatAmount: null };

export interface AdjustingJournal { entry_number: string | null; tie: string; vat_amount: number }

export interface MirrorPlan {
  taxAmount: number;
  basis: MirrorBasis;
  /** Display only (numeric(5,2)); the amount above is what posts. */
  taxRate: number;
  billVatRateNow: number;
  /** Derivable VAT the bill still carries, net of open drafts. */
  vatNetNow: number;
  netBaseNow: number;
  /** The derivable VAT at the posted rate on what the bill still carries, less what it carries (> 0 = reversed). */
  vatOutOfProportion: number;
  /** Heuristic matches' VAT on the bill's VAT accounts (< 0 = they reversed some). */
  vatHeuristic: number;
  /** The VAT the bill carries if the heuristic matches are about it: what an acknowledged call should state. */
  suggestedVatAmount: number;
  heuristicSearched: boolean;
  adjustingJournals: AdjustingJournal[];
}

/** A live note on the bill that has not posted yet (a draft): it will take its subtotal and VAT when approved. */
export interface UnpostedNote { id: string; credit_note_number: string | null; subtotal: number; tax_amount: number }

export type MirrorDecision = { ok: true; plan: MirrorPlan } | { ok: false; reason: string };

function adjusting(lines: readonly DocumentVatLine[], unposted: readonly UnpostedNote[]): AdjustingJournal[] {
  const byJournal = new Map<string, AdjustingJournal>();
  for (const l of lines) {
    if (l.tie === 'posting' || l.tie === 'late_claim') continue;
    const e = byJournal.get(l.journal_entry_id) ?? { entry_number: l.entry_number, tie: l.tie, vat_amount: 0 };
    e.vat_amount = r2(e.vat_amount + l.vat_amount);
    byJournal.set(l.journal_entry_id, e);
  }
  return [...byJournal.values(), ...unposted.map((n) => ({ entry_number: n.credit_note_number, tie: 'draft_credit_note', vat_amount: r2(-n.tax_amount) }))]
    .filter((e) => e.vat_amount !== 0);
}

/** Pure: the mirrored note's VAT, or why it cannot be mirrored. */
export function planMirroredNote(
  h: DocumentVatHistory, subtotal: number, ack: MirrorAck, unposted: readonly UnpostedNote[] = [],
): MirrorDecision {
  const { vat_posted: vatPosted, net_base_posted: basePosted, vat_heuristic: vatHeuristic } = h.totals;
  const baseNow = r2(h.totals.net_base_now - unposted.reduce((s, n) => s + n.subtotal, 0));
  const vatNow = r2(h.totals.vat_derivable_now - unposted.reduce((s, n) => s + n.tax_amount, 0));
  const bill = h.document_number;
  const same = unposted.find((n) => Math.abs(n.subtotal - subtotal) <= 0.005);
  const retryHint = same
    ? ` Draft credit note ${same.credit_note_number ?? same.id} (id ${same.id}) for the same subtotal is already open on this bill: if this is a retry, approve that one with approve_credit_note.`
    : '';
  if (basePosted <= 0) {
    return { ok: false, reason: `Bill ${bill} has no posted journal with an expense base to mirror (status ${h.document_status}). Approve it first, or raise the note without mirror_bill.` };
  }
  if (baseNow <= 0.005) {
    return { ok: false, reason: `Bill ${bill} carries nothing any more: its credit notes (draft ones included) and reversals take its whole base (${fmt(basePosted)}). There is nothing to mirror.${retryHint}` };
  }
  if (subtotal > baseNow + 0.005) {
    return { ok: false, reason: `subtotal ${fmt(subtotal)} is more than the ${fmt(baseNow)} bill ${bill} still carries after its credit notes (draft ones included) and reversals. A mirrored note cannot credit more than the bill has left; lower the subtotal, or raise the note without mirror_bill.${retryHint}` };
  }
  const whole = Math.abs(subtotal - baseNow) <= 0.005;
  const share = (vat: number) => (whole ? Math.max(0, vat) : Math.min(Math.max(0, vat), r2(subtotal * Math.max(0, vat) / baseNow)));
  const derivableTax = r2(share(vatNow));
  const suggested = r2(Math.min(derivableTax, share(r2(vatNow + Math.min(0, vatHeuristic)))));
  const adjustingJournals = adjusting(h.lines, unposted);
  const tolerance = 0.01 * (1 + adjustingJournals.length);
  const outOfProportion = r2(baseNow * (vatPosted / basePosted) - vatNow);
  const issues = [
    Math.abs(outOfProportion) > tolerance
      ? `its credit notes and reversals leave ${fmt(vatNow)} of VAT on ${fmt(baseNow)} of base, ${fmt(Math.abs(outOfProportion))} ${outOfProportion > 0 ? 'less' : 'more'} than its posted rate gives` : null,
    Math.abs(vatHeuristic) > 0.01 ? `journals naming the bill moved ${fmt(vatHeuristic)} of its VAT (matched by narration or reference: heuristic)` : null,
    h.heuristic.truncated ? `more than ${h.heuristic.limit} journals name the bill, so the search is incomplete` : null,
  ].filter((s): s is string => s !== null);
  const rateOf = (tax: number) => Math.min(100, r2(tax / subtotal * 100));
  const plan = (taxAmount: number, basis: MirrorBasis): MirrorPlan => ({
    taxAmount, basis, taxRate: rateOf(taxAmount), billVatRateNow: r2(Math.max(0, vatNow) / baseNow * 100),
    vatNetNow: vatNow, netBaseNow: baseNow, vatOutOfProportion: outOfProportion, vatHeuristic, suggestedVatAmount: suggested,
    heuristicSearched: h.heuristic.searched, adjustingJournals,
  });
  if (ack.acknowledged && ack.vatAmount !== null) {
    if (ack.vatAmount > derivableTax + 0.01) {
      return { ok: false, reason: `vat_amount ${fmt(ack.vatAmount)} is more than the ${fmt(derivableTax)} of VAT bill ${bill} still carries on this share of its base (its posting, reversals and credit notes). A mirrored note cannot reverse more VAT than the bill carries.` };
    }
    return { ok: true, plan: plan(r2(ack.vatAmount), 'mirror_bill_ack') };
  }
  if (issues.length === 0) return { ok: true, plan: plan(derivableTax, 'mirror_bill') };
  const named = adjustingJournals.map((j) => `${j.entry_number ?? '(unnumbered)'} ${j.tie} ${fmt(j.vat_amount)}`).join('; ');
  return {
    ok: false,
    reason: `VAT_ALREADY_REVERSED: bill ${bill} posted ${fmt(vatPosted)} VAT on ${fmt(basePosted)}, and ${issues.join('; ')} `
      + `(${named || 'no journal named'}). A note at the bill's rate could reverse VAT a second time — a VAT201 misstatement. `
      + 'Check the journals with document_vat_history. If they are about this bill, call again with '
      + `acknowledge_vat_already_reversed: true and vat_amount: ${suggested} (the VAT the bill carries on this share once they `
      + `count; at most ${derivableTax}). If a match is about another document, a person must decide — do not acknowledge it.`,
  };
}

/** Every live supplier note linked to the bill that has not posted (status draft), in creation order. */
export async function readUnpostedBillNotes(companyId: string, billId: string): Promise<UnpostedNote[]> {
  const rows = (await sql`
    SELECT cn.id, cn.credit_note_number, cn.subtotal, cn.tax_amount FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID AND cn.supplier_invoice_id = ${billId}::UUID
      AND cn.type = 'supplier' AND cn.status = 'draft'
    ORDER BY cn.created_at, cn.id`) as { id: string; credit_note_number: string | null; subtotal: unknown; tax_amount: unknown }[];
  return rows.map((r) => ({ id: String(r.id), credit_note_number: r.credit_note_number, subtotal: Number(r.subtotal), tax_amount: Number(r.tax_amount ?? 0) }));
}

/**
 * Call inside the request transaction that then creates the note: the bill's credit-note key
 * (`lockInvoiceCreditNotes`, the key approveCreditNote takes after its note row) is held until it
 * commits, so two mirrored creates on one bill are serialised and the second sees the first's draft.
 */
export async function planMirroredSupplierNote(
  companyId: string, supplierInvoiceId: string, subtotal: number, ack: MirrorAck,
): Promise<MirrorDecision> {
  await lockInvoiceCreditNotes(supplierInvoiceId);
  const history = await getDocumentVatHistory(companyId, 'supplier_invoice', supplierInvoiceId);
  if (!history) return { ok: false, reason: 'Not found' };
  return planMirroredNote(history, subtotal, ack, await readUnpostedBillNotes(companyId, supplierInvoiceId));
}
