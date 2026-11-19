/**
 * A customer credit note linked to a TYPED invoice: one whose journal's revenue legs all carry a VAT type (migration
 * 1008). Pure (tests/unit/services/ar/creditNoteTypedSplit.test.ts).
 *
 * The note's own VAT leg is its header tax, coded 'standard' (creditNoteApproveService). Split pro rata over every
 * invoice leg, a note of 200 + VAT 30 against 1000 standard / 300 zero-rated / 200 exempt debited 133.33 standard and
 * reversed 30 of VAT: the 15% check out by R10, and a later note could reverse VAT against the unrated legs alone.
 * So here the note's VAT decides how much of its subtotal is RATED: the net its tax_amount is VAT on at the standard
 * rate on the note's date (the whole subtotal when its VAT is within a cent of the subtotal's: a gross split into
 * net + VAT rounds either way), never more than the subtotal; the rest is UNRATED. The rated part is taken pro rata
 * from the invoice's remaining rated legs only, the unrated part from its remaining unrated legs only, each with
 * allocateCreditNote's own remaining-balance and rounding rules. A part its legs cannot carry is REFUSED, before any
 * write: there is no untagged default_revenue excess on a typed invoice, because an uncoded debit would land in a VAT201
 * field the note's VAT says nothing about.
 *
 * The standard rate on the note's date, not the note's own tax_rate: a dispute's credit note (ar/disputeResolution)
 * stamps a derived blended rate (9.4% and the like) that is no rate any line charged.
 *
 * Review round 3: when the note's VAT is all the VAT the rated legs still carry (within a cent), its rated part is
 * their remaining net, so a full credit is not refused by the cent a line its VAT was rounded by (ratedPartCents). And
 * a note whose VAT is more than a cent above the standard rate on its subtotal is refused (assertVatWithinRate): a
 * 100 + VAT 30 note would debit standard 100 and reverse 30 of VAT.
 *
 * A note against a legacy invoice (any uncoded leg) is not this file's: allocateCreditNote, exactly as before.
 */
import { standardVatRatePctOn } from '@/lib/vat/standardRate';
import { RATED_VAT_TYPES } from '../shared/vatTypes';
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
  /** credit_date: a pg Date or 'YYYY-MM-DD'. */
  date: string | Date;
  /**
   * The VAT the invoice's rated legs still carry: its VAT Output legs less the VAT of its live earlier notes. Absent:
   * not known, and the rated part is the rate-implied figure alone.
   */
  remainingRatedVat?: number;
}

const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);

/** Every revenue leg of the invoice journal carries a VAT type (and there is one): the invoice is typed. */
export const legsAreTyped = (legs: readonly RevenueLeg[]): boolean => legs.length > 0 && legs.every((l) => l.vatType != null);

/** The note's rated net, in cents (see the header). */
export function noteRatedCents(note: TypedNote): number {
  const sub = cents(note.subtotal);
  const tax = cents(note.taxAmount);
  if (tax <= 0 || sub <= 0) return 0;
  const rate = standardVatRatePctOn(note.date);
  if (Math.abs(Math.round((sub * rate) / 100) - tax) <= 1) return sub;
  return Math.min(sub, Math.round((tax * 100) / rate));
}

/**
 * The rated part (cents). When the note's VAT is, within a cent, ALL the VAT the invoice's rated legs still carry, it
 * reverses all of them, so its rated part is their remaining net (capped at its subtotal): the VAT on each line was
 * rounded on the line, so the rate-implied figure can miss that net by a cent a line (166.66 + 10.00 against 66.66
 * standard implied 66.67; a hundred R0.10 lines implied 13.33 for 10.00). Otherwise the rate-implied figure.
 * It cannot move net between the groups: the figure taken is the rated legs' own, and the rest must fit the unrated.
 */
function ratedPartCents(note: TypedNote, ratedLeft: number): number {
  const tax = cents(note.taxAmount);
  if (note.remainingRatedVat !== undefined && tax > 0 && Math.abs(tax - cents(note.remainingRatedVat)) <= 1) {
    return Math.min(ratedLeft, cents(note.subtotal));
  }
  return noteRatedCents(note);
}

/** A note's VAT may not be more than a cent above the standard rate on its subtotal (typed path only). */
function assertVatWithinRate(note: TypedNote, creditNoteNumber: string): void {
  const rate = standardVatRatePctOn(note.date);
  const atRate = Math.round((cents(note.subtotal) * rate) / 100);
  if (cents(note.taxAmount) <= atRate + 1) return;
  throw new CreditNoteVatSplitRefusal(`Credit note ${creditNoteNumber}: its VAT of ${money(cents(note.taxAmount))} is more `
    + `than ${rate}% of its subtotal of ${money(cents(note.subtotal))} (${money(atRate)}). Correct its VAT, or its subtotal.`);
}

/** The note's revenue debits and allocation rows against a typed invoice's legs. Throws CreditNoteVatSplitRefusal. */
export function allocateTypedCreditNote(
  legs: readonly RevenueLeg[],
  note: TypedNote,
  creditNoteNumber: string,
  defaultRevenueAccountId: string,
  legacyNotes: readonly number[] = [],
): { lines: JournalLineInput[]; allocations: CreditNoteAllocation[] } {
  const carries = remainingCarries(legs, legacyNotes);
  // Each leg as allocateCreditNote reads it: `taken` set so that what it carries is exactly what remains.
  const settled = legs.map((l, i) => ({ ...l, taken: (cents(l.net) - carries[i]!) / 100 }));
  const isRated = (l: RevenueLeg) => l.vatType != null && RATED_VAT_TYPES.includes(l.vatType);
  assertVatWithinRate(note, creditNoteNumber);
  const ratedLegs = settled.filter(isRated);
  const rated = ratedPartCents(note, legs.reduce((s, l, i) => s + (isRated(l) ? carries[i]! : 0), 0));
  const parts = [
    { legs: ratedLegs, part: rated, refuse: (carried: number, over: number) => `its VAT of `
      + `${money(cents(note.taxAmount))} is VAT on ${money(rated)} of standard-rated supplies, but the invoice's rated lines `
      + `have ${money(carried)} left to credit (${money(over)} over). Reduce the note, or its VAT.` },
    { legs: settled.filter((l) => !isRated(l)), part: cents(note.subtotal) - rated, refuse: (carried: number, over: number) =>
      `${money(cents(note.subtotal) - rated)} of it carries no VAT, but the invoice's zero-rated and exempt lines have `
      + `${money(carried)} left to credit (${money(over)} over). Give the note its VAT, or reduce it.` },
  ];
  const lines: JournalLineInput[] = [];
  const allocations: CreditNoteAllocation[] = [];
  for (const { legs: group, part, refuse } of parts) {
    const out = allocateCreditNote(group, part / 100, creditNoteNumber, defaultRevenueAccountId);
    // What the group's legs could not take; what they did take is all they had left.
    const uncarried = out.allocations.filter((a) => a.isExcess).reduce((s, a) => s + cents(a.amount), 0);
    const carried = part - uncarried;
    if (uncarried !== 0) throw new CreditNoteVatSplitRefusal(`Credit note ${creditNoteNumber}: ${refuse(carried, uncarried)}`);
    lines.push(...out.lines);
    allocations.push(...out.allocations);
  }
  return { lines, allocations };
}
