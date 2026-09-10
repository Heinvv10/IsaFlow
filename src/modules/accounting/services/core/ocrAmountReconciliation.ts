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
