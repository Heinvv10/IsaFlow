/**
 * The pure half of party_ledger_check: which reason class a document's
 * statement-vs-GL difference gets, and how the party totals and invariants are
 * built from the documents. The SQL half is pinned in
 * tests/integration/party-ledger-check.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildDocument, totalsByClass, type DocumentInput } from '@/modules/accounting/services/reconciliation/partyLedgerClassify';
import { buildTotals, checkPartyInvariants } from '@/modules/accounting/services/reconciliation/partyLedgerTotals';
import type { JournalFacts } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';

const POSTED: JournalFacts = {
  journalId: 'j1', status: 'posted', entryDate: '2026-03-01', controlNet: 100,
  controlLines: 1, reversalsInForce: 0, nonControl: [],
};

function input(over: Partial<DocumentInput> = {}, journal: Partial<JournalFacts> = {}): DocumentInput {
  return {
    kind: 'invoice', id: 'd1', number: 'N1', date: '2026-03-01', status: 'approved', asAt: '2026-06-30',
    total: 100, statementEffect: 100, onStatement: true, excludedReason: null,
    journal: { ...POSTED, ...journal }, glAvailable: true,
    settled: 0, outstanding: 100, allocated: 0, unapplied: null, checkTrail: true,
    ...over,
  };
}
const cls = (i: DocumentInput) => buildDocument(i).flags.map((f) => f.class);

describe('buildDocument', () => {
  it('a document whose journal matches the statement carries no flag', () => {
    const d = buildDocument(input());
    expect(d.flags).toEqual([]);
    expect(d.difference).toBe(0);
  });

  it.each([
    ['no journal link, invoice', input({}, { journalId: null, status: null, entryDate: null, controlNet: 0, controlLines: 0 }), 'document_not_linked_to_journal'],
    ['no journal link, payment', input({ kind: 'payment', statementEffect: -100, total: 100, checkTrail: false }, { journalId: null, status: null, entryDate: null, controlNet: 0, controlLines: 0 }), 'settlement_with_no_journal'],
    ['linked row missing', input({}, { status: null, entryDate: null, controlNet: 0, controlLines: 0 }), 'journal_not_posted'],
    ['draft journal', input({}, { status: 'draft', controlNet: 0, controlLines: 0 }), 'journal_not_posted'],
    ['dated after as_at', input({}, { entryDate: '2026-08-01', controlNet: 0, controlLines: 0 }), 'journal_dated_after_as_at'],
    ['reversal in force', input({}, { controlNet: 0, reversalsInForce: 1 }), 'reversed_journal_live_document'],
    ['legacy reversed status', input({}, { status: 'reversed', controlNet: 0, controlLines: 0 }), 'reversed_journal_live_document'],
    ['cancelled with live journal', input({ statementEffect: 0, onStatement: false, excludedReason: 'invoice_cancelled' }), 'excluded_document_has_live_journal'],
    ['cancelled payment, journal never reversed', input({ kind: 'payment', status: 'cancelled', statementEffect: 0, onStatement: false, excludedReason: 'payment_not_confirmed', total: 100, checkTrail: false }, { controlNet: -100 }), 'cancelled_payment_journal_stands'],
    ['cancelled bill with live journal is still the general class', input({ kind: 'invoice', status: 'cancelled', statementEffect: 0, onStatement: false, excludedReason: 'invoice_cancelled' }), 'excluded_document_has_live_journal'],
    ['partial amount', input({}, { controlNet: 60 }), 'journal_amount_differs'],
  ])('%s -> %s', (_name, i, expected) => {
    expect(cls(i)).toEqual([expected]);
  });

  it('a journal on a non-control account names where the value went, matching the statement sign', () => {
    const d = buildDocument(input({}, {
      controlNet: 0, controlLines: 0,
      nonControl: [{ code: '2999', name: 'Sundry', net: 100 }, { code: '5000', name: 'Materials', net: -100 }],
    }));
    expect(d.flags).toHaveLength(1);
    expect(d.flags[0]).toMatchObject({ class: 'posted_to_non_control_account', amount: 100 });
    expect(d.flags[0]!.postedTo).toEqual([{ code: '2999', name: 'Sundry', net: 100 }]);
  });

  it('a difference nothing names is unclassified, never dropped', () => {
    expect(cls(input({}, { controlNet: 0, controlLines: 0 }))).toEqual(['unclassified_difference']);
  });

  it('an approved write-off with a posted journal is the statement not listing it', () => {
    const d = buildDocument(input({
      kind: 'write_off', status: 'approved', statementEffect: 0, onStatement: false, total: 100, checkTrail: false,
    }, { controlNet: -100 }));
    expect(d.flags.map((f) => [f.class, f.amount])).toEqual([['write_off_not_on_statement', 100]]);
  });

  it('an approved write-off with no journal is a subledger-trail flag with no statement difference', () => {
    const d = buildDocument(input({
      kind: 'write_off', status: 'approved', statementEffect: 0, onStatement: false, total: 300, checkTrail: false,
    }, { journalId: null, status: null, entryDate: null, controlNet: 0, controlLines: 0 }));
    expect(d.difference).toBe(0);
    expect(d.flags.map((f) => [f.class, f.bridge, f.amount])).toEqual([['settlement_with_no_journal', 'subledger_trail', 300]]);
  });

  it('amount_paid beyond its allocation rows is flagged separately from the GL comparison', () => {
    const d = buildDocument(input({ settled: 500, allocated: 200 }));
    expect(d.difference).toBe(0);
    expect(d.flags.map((f) => [f.class, f.bridge, f.amount])).toEqual([['amount_paid_differs_from_allocations', 'subledger_trail', 300]]);
  });

  it('an applied credit note beyond its allocation rows says applied, not amount_paid', () => {
    const d = buildDocument(input({ kind: 'credit_note', statementEffect: -100 }, { controlNet: -100 }));
    expect(d.flags).toEqual([]);
    const bad = buildDocument(input({ kind: 'credit_note', statementEffect: -100, settled: 100, allocated: 0 }, { controlNet: -100 }));
    expect(bad.flags.map((f) => f.class)).toEqual(['applied_differs_from_allocations']);
  });

  it('without a control account there is no GL comparison to fail', () => {
    const d = buildDocument(input({ glAvailable: false }, { controlNet: 0, controlLines: 0 }));
    expect(d.difference).toBeNull();
    expect(d.flags).toEqual([]);
  });

  it('sub-cent noise is not a difference', () => {
    expect(buildDocument(input({ statementEffect: 100.004 }, { controlNet: 100 })).flags).toEqual([]);
  });
});

describe('shared journals', () => {
  it('an unattributable document carries no GL view and its own flag, and no statement-vs-GL flag', () => {
    const d = buildDocument(input(
      { kind: 'payment', statementEffect: -100, total: 100, checkTrail: false, attribution: 'unattributable', sharedWith: ['x', 'y'] },
      { controlNet: 0, controlLines: 0 },
    ));
    expect(d.difference).toBeNull();
    expect(d.flags.map((f) => [f.class, f.bridge, f.amount])).toEqual([['shared_journal_unattributable', 'shared_journal', -100]]);
    expect(d.gl).toMatchObject({ attribution: 'unattributable', sharedWith: ['x', 'y'] });
  });

  it('is left out of the gap on both sides and counted apart', () => {
    const ok = buildDocument(input({ id: 'a' }));
    const shared = buildDocument(input(
      { id: 'b', kind: 'payment', statementEffect: -40, total: 40, checkTrail: false, attribution: 'unattributable', sharedWith: ['z'] },
      { controlNet: 0, controlLines: 0 },
    ));
    const t = buildTotals({ documents: [ok, shared], statementBalance: 60, agedNet: 60, glAvailable: true });
    expect(t).toMatchObject({
      glControlNet: 100, statementMinusGl: 0, classifiedDifference: 0, unexplainedResidual: 0,
      sharedJournalUnattributable: { documents: 1, statementEffect: -40 },
    });
    expect(t.byClass).toEqual([{ class: 'shared_journal_unattributable', count: 1, amount: -40 }]);
  });
});

describe('totals and invariants', () => {
  const clean = buildDocument(input({ id: 'a' }));
  const noJournal = buildDocument(input({ id: 'b', total: 50, statementEffect: 50 }, { journalId: null, status: null, entryDate: null, controlNet: 0, controlLines: 0 }));
  const lost = buildDocument(input({ id: 'c', statementEffect: 40, total: 40 }, { controlNet: 0, controlLines: 0 }));
  const docs = [clean, noJournal, lost];

  it('the residual is exactly what the unclassified documents carry', () => {
    const t = buildTotals({ documents: docs, statementBalance: 190, agedNet: 190, glAvailable: true });
    expect(t).toMatchObject({ glControlNet: 100, statementMinusGl: 90, classifiedDifference: 50, unexplainedResidual: 40 });
    expect(t.byClass.map((c) => [c.class, c.count, c.amount]).sort()).toEqual(
      [['document_not_linked_to_journal', 1, 50], ['unclassified_difference', 1, 40]],
    );
    expect(t.documents).toEqual({ total: 3, flagged: 2 });
  });

  it('invariants hold when the statement lines all have a document, and fail when one is missing', () => {
    const ok = buildTotals({ documents: docs, statementBalance: 190, agedNet: 190, glAvailable: true });
    expect(checkPartyInvariants({ documents: docs, totals: ok, invoiceOpenFromRows: 190, glAvailable: true }).every((i) => i.holds)).toBe(true);

    const missing = buildTotals({ documents: docs, statementBalance: 250, agedNet: 190, glAvailable: true });
    const bad = checkPartyInvariants({ documents: docs, totals: missing, invoiceOpenFromRows: 190, glAvailable: true });
    expect(bad.filter((i) => !i.holds).map((i) => i.name)).toEqual([
      'documents_sum_to_statement_balance', 'residual_is_the_unclassified_difference',
    ]);
  });

  it('flags aged and row populations that disagree', () => {
    const t = buildTotals({ documents: docs, statementBalance: 190, agedNet: 190, glAvailable: true });
    const res = checkPartyInvariants({ documents: docs, totals: t, invoiceOpenFromRows: 180, glAvailable: true });
    expect(res.filter((i) => !i.holds).map((i) => i.name)).toEqual(['invoice_rows_sum_to_aged_net']);
  });

  it('no control account: GL figures are null, not zero', () => {
    const d = [buildDocument(input({ glAvailable: false }))];
    const t = buildTotals({ documents: d, statementBalance: 100, agedNet: 100, glAvailable: false });
    expect(t).toMatchObject({ glControlNet: null, statementMinusGl: null, classifiedDifference: null, unexplainedResidual: null });
  });

  it('totalsByClass orders by absolute amount', () => {
    expect(totalsByClass(docs).map((c) => c.class)).toEqual(['document_not_linked_to_journal', 'unclassified_difference']);
  });
});
