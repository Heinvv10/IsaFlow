/**
 * `partitionCandidates` — which posted lines a reclassification may move, and
 * why each of the rest may not.
 *
 * Pure, so every guard is testable without a database. The DB-gated half
 * (reclassificationDb.test.ts) proves the query that feeds it actually runs.
 *
 * A REFUSAL IS ABOUT THE REQUEST; A SKIP IS ABOUT THE DATA. Everything here is
 * a skip: the caller cannot fix a closed period by re-sending the call, and one
 * unmovable line must not cost the other 418.
 */
import { describe, it, expect } from 'vitest';
import {
  partitionCandidates,
  type CandidateRow,
} from '@/modules/accounting/services/gl/reclassification/candidates';

function row(over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    line_id: '11111111-1111-4111-8111-111111111111',
    journal_entry_id: '22222222-2222-4222-8222-222222222222',
    entry_number: 'JE-2026-00001',
    entry_date: '2026-04-15',
    debit: '1000.00',
    credit: '0.00',
    description: 'Fibre cable',
    project_id: null,
    cost_center_id: null,
    reversed: false,
    period_status: 'open',
    has_period: true,
    already_reclassified: false,
    is_reclass_contra: false,
    vat_period_locked: false,
    ...over,
  };
}

const OPEN = { postingDate: null, vatRelevant: false } as const;

describe('partitionCandidates', () => {
  it('moves an ordinary posted line and carries its amount, project and cost centre', () => {
    const { movable, skipped } = partitionCandidates(
      [row({ debit: '1234.56', credit: '0.00', project_id: 'p1', cost_center_id: 'c1' })],
      OPEN,
    );
    expect(skipped).toEqual([]);
    expect(movable).toHaveLength(1);
    expect(movable[0]).toMatchObject({
      debit: 1234.56,
      credit: 0,
      projectId: 'p1',
      costCenterId: 'c1',
      entryDate: '2026-04-15',
      entryNumber: 'JE-2026-00001',
    });
  });

  it('carries a credit-side line without flipping it — the journal is built from both sides', () => {
    const { movable } = partitionCandidates([row({ debit: '0.00', credit: '500.00' })], OPEN);
    expect(movable[0]).toMatchObject({ debit: 0, credit: 500 });
  });

  it('skips a line whose fiscal period is closed, and says so', () => {
    const { movable, skipped } = partitionCandidates([row({ period_status: 'closed' })], OPEN);
    expect(movable).toEqual([]);
    expect(skipped).toEqual([
      expect.objectContaining({ reason: 'source_period_closed', amount: 1000 }),
    ]);
  });

  it('skips a line whose entry sits in NO fiscal period', () => {
    const { skipped } = partitionCandidates(
      [row({ has_period: false, period_status: null })],
      OPEN,
    );
    expect(skipped[0]).toMatchObject({ reason: 'source_period_missing' });
  });

  it('POSTS a closed-period line when the caller names an open posting date instead', () => {
    const { movable, skipped } = partitionCandidates(
      [row({ period_status: 'closed' })],
      { postingDate: '2026-09-04', vatRelevant: false },
    );
    // The closed period is not being written to — the correction lands in the
    // period the caller named, which the tool validated before calling.
    expect(skipped).toEqual([]);
    expect(movable).toHaveLength(1);
  });

  it('skips a line belonging to a reversed journal entry', () => {
    const { skipped } = partitionCandidates([row({ reversed: true })], OPEN);
    expect(skipped[0]).toMatchObject({ reason: 'entry_reversed' });
  });

  it('skips a line an earlier live batch already moved', () => {
    const { skipped } = partitionCandidates([row({ already_reclassified: true })], OPEN);
    expect(skipped[0]).toMatchObject({ reason: 'already_reclassified' });
  });

  it('skips the CONTRA leg of an earlier reclassification — moving it moves the correction', () => {
    const { skipped } = partitionCandidates([row({ is_reclass_contra: true })], OPEN);
    expect(skipped[0]).toMatchObject({ reason: 'reclassification_contra' });
  });

  it('skips a zero line: there is nothing to move and the pair would not balance usefully', () => {
    const { skipped } = partitionCandidates([row({ debit: '0.00', credit: '0.00' })], OPEN);
    expect(skipped[0]).toMatchObject({ reason: 'zero_amount', amount: 0 });
  });

  it('skips a VAT-locked date ONLY when the move touches a VAT control account', () => {
    const locked = [row({ vat_period_locked: true })];
    expect(partitionCandidates(locked, OPEN).skipped).toEqual([]);
    expect(
      partitionCandidates(locked, { postingDate: null, vatRelevant: true }).skipped[0],
    ).toMatchObject({ reason: 'vat_period_locked' });
  });

  it('reports the FIRST applicable reason per line and never both moves and skips it', () => {
    const { movable, skipped } = partitionCandidates(
      [row({ reversed: true, period_status: 'closed' })],
      OPEN,
    );
    expect(movable).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe('entry_reversed');
  });

  it('accounts for every candidate exactly once — the identity the envelope checks', () => {
    const rows = [
      row({ line_id: 'a' }),
      row({ line_id: 'b', period_status: 'closed' }),
      row({ line_id: 'c', reversed: true }),
      row({ line_id: 'd', debit: '0.00', credit: '0.00' }),
    ];
    const { movable, skipped } = partitionCandidates(rows, OPEN);
    expect(movable.length + skipped.length).toBe(rows.length);
    expect(new Set([...movable.map(m => m.lineId), ...skipped.map(s => s.lineId)]).size).toBe(4);
  });
});
