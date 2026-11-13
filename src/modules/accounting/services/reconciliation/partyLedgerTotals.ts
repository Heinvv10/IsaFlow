/**
 * Party-level totals and invariants for `party_ledger_check`.
 *
 * The figures that matter -- the statement balance and the aged net -- are
 * passed in from the services that own them. What is computed here is only the
 * bridge between them, and the checks that would catch a document the per-row
 * view lost.
 */
import { round2 } from './reconciliationMath';
import { totalsByClass } from './partyLedgerClassify';
import type { PartyDocument, PartyInvariant, PartyLedgerTotals } from './partyLedgerTypes';

export interface TotalsInput {
  documents: readonly PartyDocument[];
  statementBalance: number;
  agedNet: number;
  glAvailable: boolean;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return round2(total);
}

export function buildTotals({ documents, statementBalance, agedNet, glAvailable }: TotalsInput): PartyLedgerTotals {
  const glControlNet = glAvailable ? sum(documents.map((d) => d.gl.controlNet)) : null;
  const statementMinusGl = glControlNet === null ? null : round2(statementBalance - glControlNet);
  const classified = glAvailable
    ? sum(documents.flatMap((d) => d.flags)
        .filter((f) => f.bridge === 'statement_vs_gl' && f.class !== 'unclassified_difference')
        .map((f) => f.amount))
    : null;

  // Each item is signed as its contribution to agedNet - statementBalance:
  //   aged - statement = receipts + credits - settled   (invoice totals cancel)
  // and settled = allocations (payments + credits + write-offs) + whatever
  // amount_paid carries with no allocation behind it. So the four items below are
  // that identity read term by term: cash and credit the statement counts in full
  // but the aging only counts where allocated, a write-off the aging honours but
  // the statement does not list, and amount_paid with no allocation row.
  const unappliedCash = sum(documents
    .filter((d) => d.kind === 'payment' && d.statement.onStatement)
    .map((d) => (d.subledger.total - (d.subledger.allocated ?? 0))));
  const unappliedCredit = sum(documents
    .filter((d) => d.kind === 'credit_note' && d.statement.onStatement)
    .map((d) => (-d.statement.effect - (d.subledger.allocated ?? 0))));
  const writeOffs = round2(-sum(documents
    .filter((d) => d.kind === 'write_off' && d.status === 'approved')
    .map((d) => d.subledger.total)));
  // An invoice whose amount_paid exceeds its allocation rows is aged as settled, yet no
  // receipt or credit note on the statement accounts for it (bank-match confirmation).
  const amountPaidWithoutAllocation = round2(-sum(documents
    .flatMap((d) => d.flags)
    .filter((f) => f.class === 'amount_paid_differs_from_allocations')
    .map((f) => f.amount)));
  const agedMinusStatement = round2(agedNet - statementBalance);

  return {
    statementBalance: round2(statementBalance),
    agedNet: round2(agedNet),
    glControlNet,
    statementMinusGl,
    classifiedDifference: classified,
    unexplainedResidual: statementMinusGl === null || classified === null ? null : round2(statementMinusGl - classified),
    agedMinusStatement,
    agedBridge: {
      unappliedCash,
      unappliedCredit,
      writeOffs,
      amountPaidWithoutAllocation,
      unexplained: round2(
        agedMinusStatement - (unappliedCash + unappliedCredit + writeOffs + amountPaidWithoutAllocation),
      ),
    },
    documents: { total: documents.length, flagged: documents.filter((d) => d.flags.length > 0).length },
    byClass: totalsByClass(documents),
  };
}

export interface InvariantInput {
  documents: readonly PartyDocument[];
  totals: PartyLedgerTotals;
  /** Sum of total - rewound paid over in-population invoices, read from the document rows themselves. */
  invoiceOpenFromRows: number;
  glAvailable: boolean;
}

/**
 * Checked, not assumed, and reported rather than thrown (a violation is the
 * most interesting thing this tool can say). Each compares two INDEPENDENT
 * reads, so none closes by construction.
 */
export function checkPartyInvariants({ documents, totals, invoiceOpenFromRows, glAvailable }: InvariantInput): PartyInvariant[] {
  const statementFromRows = sum(documents.map((d) => d.statement.effect));
  const unclassified = sum(documents.flatMap((d) => d.flags)
    .filter((f) => f.bridge === 'statement_vs_gl' && f.class === 'unclassified_difference')
    .map((f) => f.amount));
  const out: PartyInvariant[] = [
    {
      name: 'documents_sum_to_statement_balance',
      holds: statementFromRows === round2(totals.statementBalance),
      detail: `The documents' statement effects sum to ${statementFromRows}; the statement service reports ${round2(totals.statementBalance)}. A gap means the statement lists a line this tool has no document row for.`,
    },
    {
      name: 'invoice_rows_sum_to_aged_net',
      holds: round2(invoiceOpenFromRows) === round2(totals.agedNet),
      detail: `Invoices open per their own rows (${round2(invoiceOpenFromRows)}) against the aged reader's total (${round2(totals.agedNet)}). A gap means the two disagree about which documents are open.`,
    },
  ];
  if (glAvailable && totals.unexplainedResidual !== null) {
    out.push({
      name: 'residual_is_the_unclassified_difference',
      holds: totals.unexplainedResidual === unclassified,
      detail: `unexplainedResidual (${totals.unexplainedResidual}) must be exactly what the documents' own unclassified differences carry (${unclassified}); anything else is a statement line with no document row.`,
    });
  }
  return out;
}
