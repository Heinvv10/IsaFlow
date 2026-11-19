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
 *        tax_amount must be EXACTLY requiredCreditNoteVat(R, V, S): V when S = R, else round-half-away(V x S / R),
 *        in integer cents. No tolerance and no rate: the figure is the invoice's own VAT, in proportion.
 *
 * STRANDING IS IMPOSSIBLE. (1) While R > 0 and V >= 0, a note with S = R is accepted with VAT V, and every partial
 * note's VAT is at most V (S < R), so V stays >= 0; (2) the note that brings R to 0 is S = R, which takes exactly V,
 * so R = 0 implies V = 0; (3) a cancelled note restores both its net and its VAT. Negative V (hand-made data) is refused.
 *
 * Only the standard lines of a mixed invoice cannot be credited alone until credit notes have lines. A note against a
 * legacy invoice (any uncoded leg) is not this file's: allocateCreditNote, exactly as before. Pure.
 */
import { allocateCreditNote, remainingCarries, type CreditNoteAllocation, type RevenueLeg } from './invoiceRevenueLines';
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

/** n / d rounded to an integer, half away from zero (d > 0). */
const divRound = (n: number, d: number): number => {
  const q = Math.floor((Math.abs(n) * 2 + d) / (d * 2));
  return n < 0 ? -q : q;
};

/**
 * The VAT a note crediting `subtotal` of an invoice with `remainingNet` and `remainingVat` left must carry: all of the
 * VAT when it credits all of the net, else its proportional share, rounded half away from zero to the cent.
 */
export function requiredCreditNoteVat(input: { remainingNet: number; remainingVat: number; subtotal: number }): number {
  const r = cents(input.remainingNet);
  const v = cents(input.remainingVat);
  const s = cents(input.subtotal);
  return (s === r ? v : divRound(v * s, r)) / 100;
}

/**
 * A gross amount (a dispute's) split into a subtotal and the VAT requiredCreditNoteVat gives it, adding up to the gross
 * exactly; null when no subtotal within two cents of the proportional one does (the gross is more than is left).
 */
export function splitGrossProportionally(gross: number, remainingNet: number, remainingVat: number): { subtotal: number; taxAmount: number } | null {
  const g = cents(gross);
  const r = cents(remainingNet);
  const v = cents(remainingVat);
  if (r <= 0 || g <= 0) return null;
  const guess = divRound(g * r, r + v);
  for (const s of [guess, guess - 1, guess + 1, guess - 2, guess + 2]) {
    if (s <= 0 || s > r) continue;
    const tax = cents(requiredCreditNoteVat({ remainingNet: remainingNet, remainingVat, subtotal: s / 100 }));
    if (s + tax === g) return { subtotal: s / 100, taxAmount: tax / 100 };
  }
  return null;
}

const PROPORTIONAL = 'An invoice with a VAT type per line is credited in proportion across its lines.';

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
  if (s <= 0 || s > r) {
    refuse(`credits ${money(s)}, but the invoice has ${money(Math.max(r, 0))} left to credit. Reduce the note.`);
  }
  if (v < 0) refuse('cannot be raised: the invoice\'s VAT is already fully reversed. Correct it with a journal.');
  const required = cents(requiredCreditNoteVat({ remainingNet: r / 100, remainingVat: v / 100, subtotal: s / 100 }));
  if (cents(note.taxAmount) !== required) {
    refuse(`reverses ${money(s)} of an invoice with ${money(r)} left, so its VAT must be ${money(required)}, `
      + `not ${money(cents(note.taxAmount))}. ${PROPORTIONAL}`);
  }
  // Each leg as allocateCreditNote reads it: `taken` set so that what it carries is exactly what remains.
  const settled = legs.map((l, i) => ({ ...l, taken: (cents(l.net) - carries[i]!) / 100 }));
  const out = allocateCreditNote(settled, s / 100, creditNoteNumber, defaultRevenueAccountId);
  // S <= R leaves nothing over; an excess would be an uncoded debit, so it is refused rather than posted.
  if (out.allocations.some((a) => a.isExcess)) refuse(`could not be spread over the invoice's lines. ${PROPORTIONAL}`);
  return out;
}
