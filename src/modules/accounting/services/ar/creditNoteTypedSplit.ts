/**
 * A customer credit note linked to a TYPED invoice: one whose journal's revenue legs all carry a VAT type (migration
 * 1008). PROPORTIONAL ONLY (Hein, 2026-11-19): credit notes have no lines yet, so a note cannot say which of the
 * invoice's lines it reverses, and four review rounds of inferring that from its VAT each found a new edge. Until
 * credit notes get lines, a note against a typed invoice reverses the invoice in proportion across ALL its lines:
 *
 *   NET  R = the invoice's remaining net over every revenue leg (each leg's net less what live earlier notes took).
 *        The note's subtotal S must be > 0 and <= R; its debits are allocated pro rata over every leg by remaining net
 *        (allocateCreditNote / remainingCarries), each debit carrying its leg's VAT type. When S = R every leg takes
 *        exactly what it has left.
 *   VAT  V = the invoice's remaining VAT (its VAT Output legs less the tax of live earlier customer notes). The note's
 *        tax_amount must be EXACTLY requiredCreditNoteVat(R, V, S) = round-half-away(V x S / R) in exact integer cents,
 *        which is V itself when S = R (V x R / R). No tolerance and no rate: the invoice's own VAT, in proportion.
 *
 * NOTES NOT LINKED TO IT (#1701 rounds 3-6): a note applied to the invoice but not linked to it took none of its legs at
 * approval. What its applications count here is RULE A (creditNoteDetached): its DETACHED gross (the share of its total
 * that reversed no leg anywhere), consumed in application order by its applications to invoices whose legs it did not
 * reverse; a linked note's FIFO spillover counts nowhere. The count settles R and V in the invoice's own proportion
 * (appliedSettlement), so R and V shrink together and the argument below holds with them. Apply refuses an increment
 * past R + V before any write (REST apply, MCP apply_credit_note, adjust_credit_note_application); the FIFO walks cap
 * each typed invoice at it (shared/creditNoteTypedPlan).
 *
 * STRANDING IS IMPOSSIBLE. (1) While R > 0 and V >= 0, a note with S = R is accepted with VAT exactly V (the formula,
 * exact in BigInt), and every partial note's VAT is at most V (S < R), so V stays >= 0; (2) the note that brings R to 0
 * is S = R, which takes exactly V, so R = 0 implies V = 0; (3) a cancelled note restores both its net and its VAT, and
 * an unapplied application its share; (4) applications count at most R + V, in proportion, so neither goes below
 * zero. Negative V (hand-made data) is refused.
 *
 * NAMED LIMIT: a tiny note can need no VAT (0.03 against the mixed 1000 / 300 / 200 invoice: 0.02 standard, VAT 0.00),
 * so its standard debit posts with no VAT leg and field 1 does not see it: at most half a cent of VAT per note, and the
 * clearing note takes exactly what is left, so it corrects itself.
 *
 * Only the standard lines of a mixed invoice cannot be credited alone until credit notes have lines. A note against a
 * legacy invoice (any uncoded leg) is not this file's: allocateCreditNote, exactly as before. Pure.
 */
import { allocateCreditNote, noteShares, remainingCarries, type CreditNoteAllocation, type RevenueLeg } from './invoiceRevenueLines';
import type { JournalLineInput } from '../../types/gl.types';

export class CreditNoteVatSplitRefusal extends Error {
  readonly code = 'CREDIT_NOTE_VAT_SPLIT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'CreditNoteVatSplitRefusal';
  }
}

export interface TypedNote {
  subtotal: number;
  taxAmount: number;
  /** The invoice's remaining VAT: its VAT Output legs less the tax of its live earlier customer notes. */
  remainingVat: number;
}

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);

/** Every revenue leg of the invoice journal carries a VAT type (and there is one): the invoice is typed. */
export const legsAreTyped = (legs: readonly RevenueLeg[]): boolean => legs.length > 0 && legs.every((l) => l.vatType != null);

/**
 * a x b / d in integer cents, rounded half away from zero (d > 0). In BigInt: a x b passes 2^53 above ~R2.4M, where a
 * float product rounds the cent wrong.
 */
export const mulDivRound = (a: number, b: number, d: number): number => {
  const n = BigInt(a) * BigInt(b);
  const q = ((n < BigInt(0) ? -n : n) * BigInt(2) + BigInt(d)) / (BigInt(2) * BigInt(d));
  return Number(n < BigInt(0) ? -q : q);
};

/**
 * The VAT a note crediting `subtotal` of an invoice with `remainingNet` (> 0) and `remainingVat` left must carry: its
 * proportional share, rounded half away from zero to the cent. Exact, so a note crediting all of the net gets all of
 * the VAT (V x R / R = V; no special case, and the mutation that added one could not be told apart).
 */
export function requiredCreditNoteVat(input: { remainingNet: number; remainingVat: number; subtotal: number }): number {
  return mulDivRound(cents(input.remainingVat), cents(input.subtotal), cents(input.remainingNet)) / 100;
}

/**
 * What the applications of notes NOT linked to a typed invoice (credit_note_allocations rows, gross) settle of its
 * remaining net and VAT (#1701 rounds 3-4, decided): its GROSS credit capacity, split in the INVOICE's OWN remaining
 * proportion, never the note's. An application moves no revenue and no VAT; the note posted its own VAT at its own
 * approval. So a standard note applied to a zero-rated invoice takes net only, and nothing turns negative on a ratio.
 * `applied` is the SUM of those applications: rounded once (the VAT half away from zero, the net the rest), so many
 * small applications count exactly what one would. Capped at the capacity (an over-application, which apply now
 * refuses, counts as clearing the invoice). VAT left below zero (hand-made data) takes none. Cents in, cents out.
 */
export function appliedSettlement(applied: number, remainingNet: number, remainingVat: number): { net: number; vat: number } {
  const vatLeft = Math.max(remainingVat, 0);
  const capacity = remainingNet + vatLeft;
  const counted = Math.min(applied, Math.max(capacity, 0));
  if (counted <= 0) return { net: 0, vat: 0 };
  const vat = mulDivRound(counted, vatLeft, capacity);
  return { net: counted - vat, vat };
}

/**
 * A typed invoice once the applications counted on it (`applied`, cents, rule A) are settled: each leg's `taken` grows
 * by its pro-rata share of their net (noteShares over what each carries), the VAT by their VAT, and what is left, net
 * (remainingCarries, clamped per leg) and VAT, in cents. The ONE copy: invoiceCreditBasis (live) and the bulk dry run's
 * simulation (shared/creditNoteBatchSimulation) both call it (#1701 round 9). Pure.
 */
export function settleApplied(legs: readonly RevenueLeg[], replayed: readonly number[], vatLeft: number, applied: number):
  { legs: RevenueLeg[]; remainingNet: number; remainingVat: number } {
  const carries = remainingCarries(legs, replayed);
  const share = appliedSettlement(applied, carries.reduce((x, y) => x + y, 0), vatLeft);
  const took = noteShares(carries, share.net);
  const settled = legs.map((l, i) => ({ ...l, taken: (cents(l.taken ?? 0) + took[i]!) / 100 }));
  return { legs: settled, remainingNet: remainingCarries(settled, replayed).reduce((x, y) => x + y, 0), remainingVat: vatLeft - share.vat };
}

/**
 * A gross amount (a dispute's) split into a subtotal and the VAT requiredCreditNoteVat gives it, adding up to the gross
 * exactly; null when no subtotal within two cents of the proportional one does (the gross is more than is left), and
 * null (a refusal, never a throw) when nothing is left or the VAT left is negative (hand-made data; approve refuses it).
 */
export function splitGrossProportionally(gross: number, remainingNet: number, remainingVat: number): { subtotal: number; taxAmount: number } | null {
  const g = cents(gross);
  const r = cents(remainingNet);
  const v = cents(remainingVat);
  if (r <= 0 || g <= 0 || v < 0) return null;
  const guess = mulDivRound(g, r, r + v);
  for (const s of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (s <= 0 || s > r) continue;
    const tax = cents(requiredCreditNoteVat({ remainingNet: remainingNet, remainingVat, subtotal: s / 100 }));
    if (s + tax === g) return { subtotal: s / 100, taxAmount: tax / 100 };
  }
  return null;
}

/** The one wording of the proportional-only rule, on every surface that refuses by it (#1701 round 3 Q4). */
export const PROPORTIONAL = 'An invoice with a VAT type per line is credited in proportion across its lines.';
/**
 * What to do about it (#1701 round 2): a draft whose VAT was right when it was created goes stale when a sibling draft on
 * the same invoice is approved first (the invoice's remaining VAT moved), and approve stays exact.
 */
export const RECREATE = 'Delete this draft (or cancel it) and create it again with no VAT given: its VAT then defaults to the figure required.';

/** The note's revenue debits and allocation rows against a typed invoice's legs. Throws CreditNoteVatSplitRefusal. */
export function allocateTypedCreditNote(
  legs: readonly RevenueLeg[],
  note: TypedNote,
  creditNoteNumber: string,
  defaultRevenueAccountId: string,
  legacyNotes: readonly number[] = [],
): { lines: JournalLineInput[]; allocations: CreditNoteAllocation[] } {
  const refuse = (why: string): never => { throw new CreditNoteVatSplitRefusal(`Credit note ${creditNoteNumber} ${why}`); };
  const carries = remainingCarries(legs, legacyNotes);
  const r = carries.reduce((a, b) => a + b, 0);
  const s = cents(note.subtotal);
  const v = cents(note.remainingVat);
  if (s <= 0) refuse('must credit a positive amount.');
  if (s > r) refuse(`credits ${money(s)}, but the invoice has ${money(Math.max(r, 0))} left to credit. Reduce the note.`);
  if (v < 0) refuse('cannot be raised: the invoice\'s VAT is already fully reversed. Correct it with a journal.');
  const required = cents(requiredCreditNoteVat({ remainingNet: r / 100, remainingVat: v / 100, subtotal: s / 100 }));
  if (cents(note.taxAmount) !== required) {
    refuse(`reverses ${money(s)} of an invoice with ${money(r)} left, so its VAT must be ${money(required)}, `
      + `not ${money(cents(note.taxAmount))}. ${PROPORTIONAL} ${RECREATE}`);
  }
  // Each leg as allocateCreditNote reads it: `taken` set so that what it carries is exactly what remains.
  const settled = legs.map((l, i) => ({ ...l, taken: (cents(l.net) - carries[i]!) / 100 }));
  const out = allocateCreditNote(settled, s / 100, creditNoteNumber, defaultRevenueAccountId);
  // S <= R leaves nothing over; an excess would be an uncoded debit, so it is refused rather than posted.
  if (out.allocations.some((a) => a.isExcess)) refuse(`could not be spread over the invoice's lines. ${PROPORTIONAL}`);
  return out;
}
