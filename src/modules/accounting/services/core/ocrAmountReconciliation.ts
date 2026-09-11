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
import { blankFillers } from './ocrWholeFigures';

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
 * `Previous` all behaved the same way. So every candidate is collected, and a
 * document that prints more than one distinct figure is DECLARED ambiguous
 * rather than resolved: `selectTotalAmount` offers a guess, and
 * `unattendedPostingGate` refuses to post it unattended. Adding a section noun
 * is no longer a thing anyone has to do.
 *
 * EVERY pattern is consulted, not the first one that hits, and that is the
 * whole of it. While the loop returned on the first productive pattern, a slip
 * printing a plain `Total` above its payable never reached `TOTAL_PATTERNS[1]`
 * (`Amount Due` / `Balance Due` / `Payable`) or `[2]` (`Amount Incl VAT`) at
 * all — so `Sub Total 200.00 / VAT 15% 30.00 / Total 230.00 / Gratuity 23.00 /
 * Amount Due 253.00` yielded ONE candidate, 230.00, which equalled the total
 * read, raised no warning and posted unattended: measured, R230.00 credited to
 * the bank against a payable of R253.00. The labels were in the vocabulary the
 * whole time; the loop is what dropped them. Hits are ordered by MATCH POSITION
 * so `selectTotalAmount`'s "the bottom one" still means the figure printed
 * lowest on the document, whichever pattern read it.
 *
 * A ZERO beside a non-zero figure is not a payable, and is dropped:
 * consulting every pattern made `Balance Due 0.00` on a PAID invoice the
 * bottom candidate, so the reader offered R0.00. Negatives are KEPT. Round 13
 * dropped them beside a positive figure too, and a refund slip printing
 * `TOTAL -499.00 / Refund Total 499.00` then read 499 and posted a purchase
 * for money the business received; kept, the two figures disagree and refuse.
 */
export function extractTotalCandidates(text: string): number[] {
  const values = totalHits(text).map((h) => h.value);
  const nonZero = values.filter((v) => v !== 0);
  return nonZero.length > 0 ? nonZero : values;
}

/**
 * Where the LAST printed total equal to `total` ENDS, or null when none is.
 *
 * The bottom occurrence, not the first: an invoice that repeats its payable in
 * a header box (`AMOUNT DUE 1150.00` above the line items) would otherwise put
 * every line item "below the total block", and every one of them would have to
 * be explained.
 */
export function totalPrintedLastEnd(text: string, total: number): number | null {
  const hits = totalHits(text).filter((h) => h.value === total);
  return hits.length > 0 ? hits[hits.length - 1]!.end : null;
}

/** Where the first printed total equal to `total` ENDS, or null when none is. */
export function totalPrintedEnd(text: string, total: number): number | null {
  const hit = totalHits(text).find((h) => h.value === total);
  return hit ? hit.end : null;
}

function totalHits(text: string): Array<{ at: number; end: number; value: number }> {
  const hits: Array<{ at: number; end: number; value: number }> = [];
  for (const pattern of GLOBAL_TOTAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) hits.push({ at: match.index, end: match.index + match[0].length, value: parseAmount(match[1]) });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
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
 * The best guess at the payable total, for the person reviewing the capture.
 *
 * It no longer decides money on its own, and that is the whole change. Four
 * rounds tried to PICK the payable out of several printed totals, and each
 * picking rule was beaten by a slip it was not written for. The last of them —
 * "`subtotal + VAT` may endorse only the bottom figure" — read R230.00 off a
 * mixed basket whose VAT-analysis block is printed UNDER the tender:
 *
 *     TOTAL 253.00 / CASH 300.00 / CHANGE 47.00 /
 *     VAT ANALYSIS / Sub Total 200.00 / VAT 15% 30.00 / Total 230.00
 *
 * That block's own arithmetic covers only the standard-rated part, so the
 * endorsement matched it, the warning was suppressed and the slip posted R23
 * short. The text is genuinely ambiguous; no ordering rule can be finished.
 *
 * So one distinct figure is a fact, and several are a question. The BOTTOM one
 * is offered as the guess, because a grand total is usually printed below what
 * it sums, and the ambiguity is always declared under `UNRECONCILED_WARNING` so
 * the capture screen says so. Whether the document may post with nobody
 * looking is `unattendedPostingRefusal`'s decision, and it refuses every
 * document that prints more than one. Do not add a rule here that makes one of
 * several candidates safe to post.
 */
export function selectTotalAmount(candidates: readonly number[]): SelectedTotal {
  if (candidates.length === 0) return { totalAmount: null, warning: null };

  const last = candidates[candidates.length - 1]!;
  const distinct = [...new Set(candidates)];
  if (distinct.length === 1) return { totalAmount: last, warning: null };

  const figures = distinct.map((c) => c.toFixed(2)).join(', ');
  return {
    totalAmount: last,
    warning: `${UNRECONCILED_WARNING} (totals ${figures}) — the document prints more than one `
      + `total; the bottom one, ${last.toFixed(2)}, is shown as the payable. Check it before posting.`,
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
  // Leader dots (`VAT 15%.........150.00`) blanked, as the figure readers do (r29).
  const unfilled = text.split(/\r?\n/).map(blankFillers).join('\n');
  for (const pattern of VAT_PATTERNS) {
    const candidates: number[] = [];
    for (const match of unfilled.matchAll(pattern)) {
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
