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
 *       a fraction of it read as a finding about the books.
 *   unexplained_is_the_residual  the residual is `difference − Σ items`, never
 *       clamped, floored or plugged. A clamped residual is how an incomplete
 *       decomposition comes to look complete.
 *
 * RETURNED, NOT THROWN: a violation is the most interesting thing the endpoint
 * can say about a set of books, and a 500 would replace it with nothing.
 */

import type { ReconciliationInvariant, ReconcilingItem } from './reconcilingItemTypes';
import { round2 } from './reconciliationMath';

export interface InvariantInputs {
  subledgerTotal: number | null;
  controlAccountBalance: number | null;
  difference: number | null;
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
  const overstated = control.filter(
    (i) => i.documentIds.length > 0 && Math.abs(i.amount) > round2(i.citedGross) + 0.01,
  );
  out.push({
    name: 'item_within_cited_gross',
    holds: overstated.length === 0,
    detail: overstated.length === 0
      ? 'Every item claims no more than the documents it names are worth.'
      : overstated
        .map((i) => `${i.type} claims ${i.amount} against ${i.documentIds.length} document(s) worth ${i.citedGross}`)
        .join('; '),
  });

  if (difference === null || unexplained === null) {
    out.push({
      name: 'unexplained_is_the_residual',
      holds: true,
      detail: 'Not applicable: there is no difference to leave a residual of.',
    });
  } else {
    const residual = round2(difference - named);
    out.push({
      name: 'unexplained_is_the_residual',
      holds: unexplained === residual,
      detail: `difference ${difference} − named items ${named} = ${residual}; unexplainedDifference is ${unexplained}.`,
    });
  }

  return out;
}
