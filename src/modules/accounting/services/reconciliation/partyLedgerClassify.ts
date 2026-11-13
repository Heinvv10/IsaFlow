/**
 * Pure classification for `party_ledger_check`: given what the statement counts
 * for a document and what that document's own journal put on the control
 * accounts, say whether they differ and WHY.
 *
 * The reason classes reuse the vocabulary of `reconcile_subledger`
 * (`document_not_linked_to_journal`, `document_not_on_control_account` split by
 * cause, ...) at the grain of ONE document. No balance is computed here: every
 * figure comes in from the statement services, the aging readers or the journal
 * chain read, and this file only compares them. That is the point -- a second
 * balance formula could agree with itself and hide a defect in the first.
 *
 * ONE FLAG PER DIFFERENCE. A document whose statement effect differs from its GL
 * net gets exactly one `statement_vs_gl` flag carrying the whole difference, so
 * the flags' amounts sum to the party's statement-minus-GL gap and the residual
 * is exactly the amount carried by `unclassified_difference`.
 */
import { round2 } from './reconciliationMath';
import type {
  FlagClassTotal,
  JournalFacts,
  MismatchClass,
  PartyDocKind,
  PartyDocument,
  PartyFlag,
} from './partyLedgerTypes';

export interface DocumentInput {
  kind: PartyDocKind;
  id: string;
  number: string | null;
  date: string;
  status: string | null;
  asAt: string;
  total: number;
  statementEffect: number;
  onStatement: boolean;
  excludedReason: string | null;
  journal: JournalFacts;
  /** False when the company has no control account: there is nothing to compare to. */
  glAvailable: boolean;
  settled: number | null;
  outstanding: number | null;
  allocated: number | null;
  /** What `settled` is tested against, when that is not the as-at `allocated` (credit notes: every row, undated). */
  trailAllocated?: number | null;
  /** Total less allocations, for payments and credit notes. */
  unapplied: number | null;
  /** Compare `settled` with `allocated` (invoices, credit notes). */
  checkTrail: boolean;
  attribution?: PartyDocument['gl']['attribution'];
  sharedWith?: string[];
}

const MONEY_EPSILON = 0.005;

function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < MONEY_EPSILON;
}

/** The non-control accounts that took the value the statement says should be on control. */
function matchingNonControl(input: DocumentInput): PartyFlag['postedTo'] {
  const want = Math.sign(input.statementEffect);
  const hits = input.journal.nonControl
    .filter((a) => want === 0 || Math.sign(a.net) === want)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 5);
  return hits;
}

function statementVsGl(input: DocumentInput, diff: number): PartyFlag {
  const j = input.journal;
  const base = { bridge: 'statement_vs_gl' as const, amount: diff };
  const flag = (cls: MismatchClass, detail: string, extra?: Partial<PartyFlag>): PartyFlag =>
    ({ class: cls, ...base, detail, ...extra });

  if (
    input.kind === 'write_off' && input.status === 'approved' &&
    j.status === 'posted' && j.entryDate !== null && j.entryDate <= input.asAt
  ) {
    return flag(
      'write_off_not_on_statement',
      'The write-off credited the control account but the statement does not list write-offs, so the statement still shows the invoice as owed.',
    );
  }
  if (j.journalId === null) {
    return input.kind === 'invoice'
      ? flag('document_not_linked_to_journal', 'The document carries no gl_journal_entry_id; the statement counts it and the control account does not.')
      : flag('settlement_with_no_journal', `The ${input.kind.replace('_', ' ')} reduces the statement balance but posted no journal to the control account.`);
  }
  if (j.status === null) {
    return flag('journal_not_posted', 'The linked journal entry row was not found in this company.');
  }
  if (j.status === 'reversed' && input.onStatement) {
    return flag('reversed_journal_live_document', 'The linked journal is marked reversed while the document is still live on the statement.');
  }
  if (j.status !== 'posted' && j.status !== 'reversed') {
    return flag('journal_not_posted', `The linked journal is '${j.status}', so none of it is on the control account.`);
  }
  if (j.entryDate !== null && j.entryDate > input.asAt) {
    return flag('journal_dated_after_as_at', `The journal is dated ${j.entryDate}, after the reporting date, while the document is dated on or before it.`);
  }
  if (!input.onStatement && j.controlNet !== 0) {
    return flag(
      'excluded_document_has_live_journal',
      `The statement leaves this document off${input.excludedReason ? ` (${input.excludedReason})` : ''} but its journal still stands on the control account.`,
    );
  }
  if (input.onStatement && j.reversalsInForce > 0) {
    return flag('reversed_journal_live_document', `The journal has ${j.reversalsInForce} reversal(s) in force while the document is still live on the statement.`);
  }
  if (j.controlLines === 0) {
    const postedTo = matchingNonControl(input);
    if (postedTo && postedTo.length > 0) {
      return flag('posted_to_non_control_account', 'The journal posted to accounts that are not typed as the control account for this subledger.', { postedTo });
    }
    return flag('unclassified_difference', 'The journal has no line on a control account and no other account carries the value.');
  }
  return flag('journal_amount_differs', 'The journal reached the control account for a different amount than the statement counts.');
}

function trailFlags(input: DocumentInput): PartyFlag[] {
  const out: PartyFlag[] = [];
  const j = input.journal;
  const trail = input.trailAllocated ?? input.allocated;
  if (input.checkTrail && input.settled !== null && trail !== null && !sameMoney(input.settled, trail)) {
    const cls: MismatchClass = input.kind === 'invoice' ? 'amount_paid_differs_from_allocations' : 'applied_differs_from_allocations';
    const settledWord = input.kind === 'invoice' ? 'amount_paid' : 'applied_amount';
    out.push({
      class: cls,
      bridge: 'subledger_trail',
      amount: round2(input.settled - trail),
      detail: `${settledWord} says ${round2(input.settled)} but its allocation rows support ${round2(trail)}.`,
    });
  }
  if (
    input.kind === 'write_off' && input.status === 'approved' &&
    (j.journalId === null || j.status !== 'posted')
  ) {
    out.push({
      class: 'settlement_with_no_journal',
      bridge: 'subledger_trail',
      amount: round2(input.total),
      detail: 'An approved write-off settled the invoice in the subledger but posted no journal to the control account.',
    });
  }
  return out;
}

export function buildDocument(input: DocumentInput): PartyDocument {
  const j = input.journal;
  const attribution = input.attribution ?? 'own';
  const sharedWith = input.sharedWith ?? [];
  const unattributable = attribution === 'unattributable';
  // An unattributable shared journal has no leg that is this document's: comparing
  // the statement with 0 would invent a difference the ledger never stated.
  const difference = input.glAvailable && !unattributable ? round2(input.statementEffect - j.controlNet) : null;
  const flags: PartyFlag[] = [];
  if (difference !== null && difference !== 0) flags.push(statementVsGl(input, difference));
  if (unattributable) {
    flags.push({
      class: 'shared_journal_unattributable',
      bridge: 'shared_journal',
      amount: round2(input.statementEffect),
      detail: `Journal ${j.journalId} is carried by ${sharedWith.length + 1} documents and its control lines cannot be matched to them one to one (or to one batch total), so this document's own leg is unknown. It is left out of the statement-versus-GL comparison; sharing documents: ${sharedWith.join(', ')}.`,
    });
  }
  flags.push(...trailFlags(input));
  return {
    kind: input.kind,
    id: input.id,
    number: input.number,
    date: input.date,
    status: input.status,
    statement: {
      effect: round2(input.statementEffect),
      onStatement: input.onStatement,
      excludedReason: input.excludedReason,
    },
    subledger: {
      total: round2(input.total),
      settled: input.settled === null ? null : round2(input.settled),
      outstanding: input.outstanding === null ? null : round2(input.outstanding),
      allocated: input.allocated === null ? null : round2(input.allocated),
      unapplied: input.unapplied === null ? null : round2(input.unapplied),
    },
    gl: {
      journalId: j.journalId,
      journalStatus: j.status,
      controlNet: round2(j.controlNet),
      reversalsInForce: j.reversalsInForce,
      attribution,
      sharedWith,
    },
    difference,
    flags,
  };
}

/** Counts and sums the flags by class, largest absolute amount first. */
export function totalsByClass(docs: readonly PartyDocument[]): FlagClassTotal[] {
  const acc = new Map<MismatchClass, FlagClassTotal>();
  for (const doc of docs) {
    for (const f of doc.flags) {
      const cur = acc.get(f.class) ?? { class: f.class, count: 0, amount: 0 };
      cur.count += 1;
      cur.amount = round2(cur.amount + f.amount);
      acc.set(f.class, cur);
    }
  }
  return [...acc.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.class.localeCompare(b.class));
}
