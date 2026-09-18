/**
 * What the reconciliation asserts about its OWN output.
 *
 * A reconciliation that reports a residual of zero has proved only that its
 * items sum to its difference — never that they are the right items. This
 * endpoint has already been through that: it reported 0.00 on every production
 * company while counting a VAT account as an AP control account, because an
 * item of the same amount across the same documents removed it again.
 *
 * These are the checks that do NOT close by construction:
 *
 *   control_plus_items_equals_subledger  the identity the endpoint claims in
 *       its own description. It holds by construction ONLY because the residual
 *       is emitted as an item; if it ever fails, an item was added after the
 *       residual was computed, or rounding was applied twice.
 *   item_within_cited_gross  no item may claim more than the documents it cites
 *       are worth. This is the one that catches an item summed off the wrong
 *       column — R453m of `document_not_on_control_account` across bills worth
 *       a fraction of it read as a finding about the books. It compares
 *       Σ|member amount|, NOT the group's net: on a net, one overstated member
 *       hides behind an opposite-signed one, which is not hypothetical —
 *       `posting_with_no_document` nets +R124,704.80 against a cited gross of
 *       R686,504.50 on a production copy because two refund journals of
 *       −R120,290.00 and −R160,609.85 sit in the same group.
 *   unexplained_is_the_residual  the residual is the gap less the NAMED items,
 *       never clamped, floored or plugged. A clamped residual is how an
 *       incomplete decomposition comes to look complete.
 *
 * THE RESIDUAL IS RE-DERIVED FROM THE BALANCES, not from the `difference` the
 * caller reports and not from the residual item in the list. `subledgerTotal`
 * and `controlAccountBalance` are read from the ledger and the subledger; every
 * other figure here is computed from them, so a check that starts from one of
 * those computed figures can only ever agree with whatever produced it. A clamp
 * on the way out — "call anything under a rand zero" — leaves the reported
 * figure, the residual ITEM and this arithmetic disagreeing, and all three are
 * compared. The same clamp checked against `difference` alone would pass.
 *
 * RETURNED, NOT THROWN: a violation is the most interesting thing the endpoint
 * can say about a set of books, and a 500 would replace it with nothing.
 */

import type { ReconciliationInvariant, ReconcilingItem } from './reconcilingItemTypes';
import { round2 } from './reconciliationMath';

export interface InvariantInputs {
  /** Read from the subledger. An INPUT to the arithmetic, not a result of it. */
  subledgerTotal: number | null;
  /** Read from the ledger. Likewise. */
  controlAccountBalance: number | null;
  /** What the response REPORTS as the difference. Checked, never trusted. */
  difference: number | null;
  /** What the response REPORTS as the residual. Checked, never trusted. */
  unexplained: number | null;
  items: readonly ReconcilingItem[];
}

export function checkInvariants({
  subledgerTotal,
  controlAccountBalance,
  difference,
  unexplained,
  items,
}: InvariantInputs): ReconciliationInvariant[] {
  const control = items.filter((i) => i.bridge === 'subledger_to_control');
  const explained = round2(control.reduce((s, i) => s + i.amount, 0));
  // The NAMED items: everything except the residual, which is defined as
  // whatever closes the gap and so cannot be evidence that the gap closed.
  const named = round2(
    control.filter((i) => i.type !== 'unexplained_difference').reduce((s, i) => s + i.amount, 0),
  );

  const out: ReconciliationInvariant[] = [];

  if (controlAccountBalance === null || subledgerTotal === null) {
    out.push({
      name: 'control_plus_items_equals_subledger',
      holds: true,
      detail: 'Not applicable: there is no control balance or no subledger to reconcile, and the response says so rather than comparing against a fabricated zero.',
    });
  } else {
    const reached = round2(controlAccountBalance + explained);
    out.push({
      name: 'control_plus_items_equals_subledger',
      holds: reached === round2(subledgerTotal),
      detail: `controlAccountBalance ${controlAccountBalance} + subledger_to_control items ${explained} = ${reached}; subledgerTotal is ${round2(subledgerTotal)}.`,
    });
  }

  // Residual items cite no documents and are excluded: their whole purpose is
  // to carry an amount nothing accounts for.
  //
  // Σ|member| against Σ gross. Absolute values cannot offset, so a member that
  // claims more than its own document is worth cannot be hidden by an
  // opposite-signed member of the same group. A tolerance of a cent per
  // document absorbs rounding without absorbing a finding.
  const overstated = control.filter(
    (i) => i.documentIds.length > 0
      && round2(i.citedAbsAmount) > round2(i.citedGross) + 0.01 * Math.max(1, i.documentIds.length),
  );
  out.push({
    name: 'item_within_cited_gross',
    holds: overstated.length === 0,
    detail: overstated.length === 0
      ? 'Every item claims no more than the documents it names are worth, member by member.'
      : overstated
        .map((i) => `${i.type} claims ${i.citedAbsAmount} in absolute value (net ${i.amount}) against ${i.documentIds.length} document(s) worth ${i.citedGross}`)
        .join('; '),
  });

  if (subledgerTotal === null || controlAccountBalance === null || unexplained === null) {
    out.push({
      name: 'unexplained_is_the_residual',
      holds: true,
      detail: 'Not applicable: there is no difference to leave a residual of.',
    });
  } else {
    // From the two READ figures, never from the reported difference.
    const gap = round2(subledgerTotal - controlAccountBalance);
    const residual = round2(gap - named);
    // The residual is also an ITEM whenever it is non-zero. Absent means zero,
    // and zero is what it must then equal.
    const asItem = round2(
      control.filter((i) => i.type === 'unexplained_difference').reduce((s, i) => s + i.amount, 0),
    );
    const differenceAgrees = difference !== null && round2(difference) === gap;
    out.push({
      name: 'unexplained_is_the_residual',
      holds: unexplained === residual && asItem === residual && differenceAgrees,
      detail: `subledgerTotal ${round2(subledgerTotal)} − controlAccountBalance ${round2(controlAccountBalance)} = ${gap}`
        + `, less named items ${named} = ${residual}; unexplainedDifference is ${unexplained}`
        + `, the unexplained_difference item carries ${asItem}`
        + `, and the reported difference is ${difference === null ? 'null' : round2(difference)}.`,
    });
  }

  return out;
}
