/**
 * A PRINTED subtotal that the document's own total and tax contradict.
 *
 * An invoice that prints a subtotal and then a levy, a service charge or a
 * delivery fee before the total has `subtotal + VAT != total` while every
 * figure on it is read correctly — the callers' balance pre-check then refuses
 * a perfectly good document with a 400. The intermediate subtotal is simply not
 * the base of the tax on such a document; `total - VAT` is, and it is the
 * figure that puts the extra charge on the expense leg where it belongs.
 *
 * Preferring the derived figure UNCONDITIONALLY would be the other defect: a
 * mis-read tax line (VAT 12.00 on an R1 150 invoice) also fails to reconcile,
 * and silently rebasing the split on it would post a wrong claim instead of
 * refusing. So the swap is conditional on the derived split looking
 * standard-rated, which the levy case does (150/1012 = 14.8%) and a mis-read
 * tax line does not (12/1138 = 1.1%). Anything else keeps the printed figures
 * and the caller's refusal, with the discrepancy named rather than implied.
 */
import { isPlausibleVatAmount, parseAmount } from './ocrAmountParsing';
import { TOTAL_PATTERNS, VAT_PATTERNS } from './ocrAmountPatterns';

const STANDARD_RATE_MIN = 0.13;
const STANDARD_RATE_MAX = 0.17;

/**
 * The opening words of BOTH outcomes, so the auto-post gate can recognise one
 * without re-spelling it.
 *
 * The printed subtotal was a CHECKSUM: while the reader kept it, a document
 * whose three figures disagreed reached the callers' balance pre-check and came
 * back a 400 that a person had to look at. Inside the band the reader now
 * rebases the net instead, which is right for the levy case and silently
 * discards that checksum for every other reason the figures might disagree — a
 * total mis-read by ~1.5% lands in the band too. `shouldAutoPostReceipt`
 * consults neither the warnings nor the confidence's provenance, so the rebased
 * document would post unattended where it used to stop. One shared prefix, one
 * predicate, and the gate reads it: rebase for the attended path, never for the
 * unattended one.
 */
export const UNRECONCILED_WARNING = 'The extracted amounts do not reconcile';

/** Did the reader fail to settle this document's own arithmetic on its own? */
export function isUnreconciled(warnings: readonly string[] | null | undefined): boolean {
  return (warnings ?? []).some((w) => w.startsWith(UNRECONCILED_WARNING));
}

export interface ReconciledNet {
  /** The net to use — the printed one, or the derived one where it is safe. */
  subtotal: number | null;
  /** What the reader could not settle on its own, or null. */
  warning: string | null;
}

export function reconcileNetAgainstTotal(
  subtotal: number | null,
  vatAmount: number | null,
  totalAmount: number | null,
): ReconciledNet {
  if (subtotal === null || vatAmount === null || totalAmount === null) {
    return { subtotal, warning: null };
  }
  const derived = Math.round((totalAmount - vatAmount) * 100) / 100;
  if (derived === subtotal) return { subtotal, warning: null };

  const rate = derived > 0 ? vatAmount / derived : 0;
  const figures = `subtotal ${subtotal.toFixed(2)}, VAT ${vatAmount.toFixed(2)}, total ${totalAmount.toFixed(2)}`;
  if (rate >= STANDARD_RATE_MIN && rate <= STANDARD_RATE_MAX) {
    return {
      subtotal: derived,
      warning: `${UNRECONCILED_WARNING} (${figures}) — read the net as ${derived.toFixed(2)}, `
        + 'which includes any levy or service charge printed below the subtotal.',
    };
  }
  return {
    subtotal,
    warning: `${UNRECONCILED_WARNING} (${figures}) — check them before posting.`,
  };
}

/* ------------------------------------------------------------------------- *
 * WHICH FIGURE IS THE PAYABLE TOTAL
 * ------------------------------------------------------------------------- */

/**
 * Every figure `TOTAL_PATTERNS` can read, in the order the document prints them.
 *
 * `String.match` returns the LEFTMOST hit, and the guard in front of the total
 * pattern is a DENYLIST of net labels — so a till slip that prints its sections
 * ("Food Total 200.00 / Drinks Total 50.00 / VAT 32.61 / TOTAL 287.50") had its
 * FIRST section read as the amount payable. Measured, that credited the bank
 * R200.00 for an R287.50 slip, and it did so silently: with no printed net the
 * subtotal is DERIVED as total − VAT, so the journal balances by construction,
 * the callers' balance pre-check passes, nothing warns and the auto-post gate
 * lets it through.
 *
 * A denylist cannot be finished. `Goods Total` proved that — `NET_LABEL`
 * already knew `Goods Value`, so the vocabulary knew the noun and still read
 * the section as the payable — and `Items`, `Line`, `Order`, `Deposit` and
 * `Previous` all behaved the same way. So the total is now chosen POSITIVELY:
 * collect every candidate, and pick by the document's own arithmetic, or by
 * position (the grand total is the one at the BOTTOM) with the disagreement
 * declared. Adding a section noun is no longer a thing anyone has to do.
 */
export function extractTotalCandidates(text: string): number[] {
  for (const pattern of GLOBAL_TOTAL_PATTERNS) {
    const values: number[] = [];
    for (const match of text.matchAll(pattern)) {
      if (match[1]) values.push(parseAmount(match[1]));
    }
    if (values.length > 0) return values;
  }
  return [];
}

/** `TOTAL_PATTERNS` are single-match; `matchAll` requires the global flag. */
const GLOBAL_TOTAL_PATTERNS: RegExp[] = TOTAL_PATTERNS.map(
  (p) => new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`),
);

export interface SelectedTotal {
  /** The payable total, or null when the document printed none. */
  totalAmount: number | null;
  /** Why the reader could not settle which figure it was, or null. */
  warning: string | null;
}

/**
 * The payable total out of the candidates, and whether the choice is safe to
 * post unattended.
 *
 * One distinct figure is not a choice at all. Where several disagree, the LAST
 * one wins, because a grand total is printed below the sections it sums, and
 * the disagreement is declared under the `UNRECONCILED_WARNING` prefix so
 * `shouldAutoPostReceipt` refuses. An operator looking at the capture screen
 * then reads both figures; nobody is looking on the unattended path, which is
 * where the R87.50 went.
 *
 * The warning is dropped ONLY when the printed net plus the printed tax comes
 * to the BOTTOM figure. `subtotal + VAT` matching a candidate ANYWHERE was the
 * previous rule and it inverted the defect it was written for: on the ordinary
 * layout that prints a gratuity, a delivery fee or a rounding line BELOW the
 * Sub Total / VAT / Total block —
 *
 *     Sub Total 200.00 / VAT 30.00 / Total 230.00 / Gratuity 23.00 / Total Due 253.00
 *
 * — 200 + 30 endorsed the INTERMEDIATE 230.00, and because the endorsement
 * branch also suppressed the warning it converted a correct refusal into a
 * silent wrong number: measured, total 230.00 against a payable of 253.00,
 * `warnings: []`, `autoPost: true`, the journal balancing by construction and
 * the bank credited R230.00. `subtotal + VAT` proves a figure is *a* total of
 * the VAT-bearing part; it is no evidence that nothing was added below it.
 *
 * Requiring the endorsed figure to be the bottom one costs the case where the
 * payable is endorsed and something LARGER is printed under it (a cash-tendered
 * line). That document is genuinely ambiguous from the labels alone — which is
 * the denylist this module abolished — and on an unattended posting path the
 * correct default for an ambiguous document is to refuse, not to guess.
 */
export function selectTotalAmount(
  candidates: readonly number[],
  subtotal: number | null,
  vatAmount: number | null,
): SelectedTotal {
  if (candidates.length === 0) return { totalAmount: null, warning: null };

  const last = candidates[candidates.length - 1]!;
  const distinct = [...new Set(candidates)];
  if (distinct.length === 1) return { totalAmount: last, warning: null };

  const endorsed = subtotal !== null && vatAmount !== null
    ? Math.round((subtotal + vatAmount) * 100) / 100
    : null;
  if (endorsed !== null && endorsed === last) return { totalAmount: last, warning: null };

  const figures = distinct.map((c) => c.toFixed(2)).join(', ');
  const arithmetic = endorsed !== null
    ? `its own subtotal and VAT come to ${endorsed.toFixed(2)}, which is not the bottom figure`
    : 'its own subtotal and VAT settle none of them';
  return {
    totalAmount: last,
    warning: `${UNRECONCILED_WARNING} (totals ${figures}) — the document prints more than one `
      + `total and ${arithmetic}; read the payable as `
      + `${last.toFixed(2)}. Check it before posting.`,
  };
}

/* ------------------------------------------------------------------------- *
 * WHICH FIGURE IS THE VAT
 * ------------------------------------------------------------------------- */

/**
 * The VAT amount, from the first label form that yields a plausible candidate.
 *
 * Every occurrence of that form is collected, not just the first, for two
 * reasons. A registration number printed above the real VAT line used to
 * consume the whole pattern; and a slip that splits its VAT summary across
 * several lines used to report only the first, under-claiming.
 *
 * Summing is allowed ONLY where the arithmetic proves it: subtotal + sum must
 * equal the stated total. Without that check a document printing both a
 * per-line VAT and a "Total VAT" of the same figure would double it, and the
 * result would still balance well enough to post.
 */
export function extractVatAmount(
  text: string,
  subtotal: number | null,
  totalAmount: number | null,
): number | null {
  for (const pattern of VAT_PATTERNS) {
    const candidates: number[] = [];
    for (const match of text.matchAll(pattern)) {
      if (match[1] && isPlausibleVatAmount(match[1], totalAmount)) {
        candidates.push(parseAmount(match[1]));
      }
    }
    if (candidates.length === 0) continue;

    if (candidates.length > 1 && subtotal !== null && totalAmount !== null) {
      // Prefer the candidate the DOCUMENT'S OWN ARITHMETIC endorses over the
      // one that happens to be printed first. Where a slip prints both a levy
      // and the VAT under the same label form, subtotal + candidate === total
      // picks the tax out of the pair; falling through to `candidates[0]` picks
      // by page order, which is not evidence of anything.
      const reconciling = candidates.filter(
        (c) => Math.round((subtotal + c) * 100) / 100 === totalAmount,
      );
      if (reconciling.length === 1) return reconciling[0]!;

      const sum = Math.round(candidates.reduce((a, c) => a + c, 0) * 100) / 100;
      if (Math.round((subtotal + sum) * 100) / 100 === totalAmount) return sum;
    }
    return candidates[0]!;
  }
  return null;
}
