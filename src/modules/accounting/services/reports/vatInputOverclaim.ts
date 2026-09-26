/**
 * The INPUT variance the VAT201 rate check gates on, measured per journal.
 *
 * `deriveVatBoxes` reports one signed variance per box per period: input tax
 * minus 15% of the input base. An under-claim anywhere in the period (a bill
 * with an untaxed item, a journal whose base carries an extra line) therefore
 * absorbs an over-claim anywhere else, and the return ties while one bill
 * claims more than its supply allows. SARS does not net them: an over-claim is
 * an over-claim whatever else was under-claimed.
 *
 * So the variance that drives `rateCheck.inputVariance` / `ties` — and through
 * them the filability check (vat201LedgerFields) and the new-lock refusal — is
 * Σ max(0, tax − rate·base) over journals. An under-claim contributes 0. The
 * displayed per-box base, tax and variance are unchanged.
 *
 * Per journal, with two groupings that keep it from inventing over-claims:
 *
 *   - a REVERSAL is counted with the journal it reverses (key = reversal_of_id):
 *     an over-claim reversed in the same period nets to nothing, which is how
 *     a confirmed over-claim is corrected. A reversal whose original is in
 *     another period stands alone, and being a reduction it contributes 0.
 *   - a LATE-CLAIM companion (vatLateClaimBasis) has no base leg; its base is
 *     the `late_claim_base` each VAT Input line carries (none recorded → 0).
 *
 * The rate is a parameter: the caller passes the rate the boxes were derived
 * at, so this file holds none of its own.
 *
 * ROUNDING ALLOWANCE (Hein, 2026-09-26 — replaces the earlier flat R0.01):
 * each of a journal's TAXED input-VAT lines rounds its own 15% to the
 * nearest CENT, so its own rounding error is at most HALF a cent either way
 * — the true per-line rounding bound is R0.005, not R0.01. A journal with
 * several such lines can therefore tie out up to R0.005 per line over the
 * flat 15%-of-the-summed-base figure with no real over-claim behind it. The
 * allowance is compared against the RAW over-claim unrounded (not pre-cent-
 * rounded itself, since half a cent has no cent representation of its own),
 * and only the amount ABOVE it — if any — is rounded to the cent and joins
 * the sum. A real over-claim beyond that allowance still flags; a single
 * TAXED line's exact R0.01 excess is no longer absorbed as "rounding" (a
 * whole cent is twice the true half-cent bound for one line) — it shows.
 * Padding a journal with untaxed (base-only) lines buys it nothing — only a
 * line `classifyVatJournalLine` puts in role 'tax' counts.
 */
import { classifyVatJournalLine, type VatLineInput } from './vatBoxBasis';

export type OverclaimLine = VatLineInput & {
  /** gl_journal_entries.reversal_of_id: a reversal is measured with its original. */
  reversalOfId?: string | null;
  /** On a late-claim companion's VAT Input line: the base behind the claim. */
  lateClaimBase?: number | null;
};

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface Acc {
  tax: number;
  base: number;
  hasInput: boolean;
  /** Count of this journal's lines classified as a taxed input-VAT line. */
  taxedLines: number;
}

/**
 * @param ordinary lines of ordinary journals, AFTER the coded-base rule and the
 *   late-claim clearing-leg filter — exactly what `deriveVatBoxes` is given.
 * @param late lines of late-claim companion journals.
 */
export function perJournalInputOverclaim(
  ordinary: readonly OverclaimLine[],
  late: readonly OverclaimLine[],
  rate: number,
): number {
  const accs = new Map<string, Acc>();
  const accFor = (l: OverclaimLine): Acc => {
    const key = l.reversalOfId ?? l.journalEntryId;
    const a = accs.get(key) ?? { tax: 0, base: 0, hasInput: false, taxedLines: 0 };
    accs.set(key, a);
    return a;
  };

  for (const l of ordinary) {
    const c = classifyVatJournalLine(l);
    if (c.role === 'tax' && c.direction === 'input') {
      const a = accFor(l);
      a.tax = r2(a.tax + c.amount);
      a.hasInput = true;
      a.taxedLines += 1;
    } else if (c.role === 'base') {
      const a = accFor(l);
      a.base = r2(a.base + l.debit - l.credit);
    }
  }
  for (const l of late) {
    const c = classifyVatJournalLine(l);
    if (c.role !== 'tax' || c.direction !== 'input') continue;
    const a = accFor(l);
    a.tax = r2(a.tax + c.amount);
    a.base = r2(a.base + (l.lateClaimBase ?? 0));
    a.hasInput = true;
    a.taxedLines += 1;
  }

  let over = 0;
  for (const a of accs.values()) {
    if (!a.hasInput) continue;
    const raw = Math.max(0, r2(a.tax - r2(a.base * rate)));
    // R0.005 per TAXED input-VAT line — the true per-line rounding bound, not
    // rounded to the cent itself (see the file header). Only the excess above
    // it, if any, is rounded and charged.
    const allowance = 0.005 * a.taxedLines;
    const excess = raw > allowance ? r2(raw - allowance) : 0;
    over = r2(over + excess);
  }
  return over;
}
