/**
 * The bulk dry run's FIFO simulation.
 *
 * `bulk_allocate_bank_transactions` posts its lines one after another against
 * the SAME set of open documents, so a dry run that planned every line against
 * the opening balances would promise two lines the same bill. The simulation
 * therefore consumes a shared, mutable balance per entity, in the order the
 * lines will post.
 */
import { describe, it, expect } from 'vitest';
import {
  simulateSequentialApplications,
  type SimulationDocument,
  type SimulationLine,
} from '@/modules/accounting/services/shared/autoApplySimulation';

const BILLS: SimulationDocument[] = [
  { invoiceId: 'b1', invoiceNumber: 'BILL-001', outstanding: 100 },
  { invoiceId: 'b2', invoiceNumber: 'BILL-002', outstanding: 200 },
  { invoiceId: 'b3', invoiceNumber: 'BILL-003', outstanding: 300 },
];

function line(index: number, cash: number, over: Partial<SimulationLine> = {}): SimulationLine {
  return { index, entityKey: 'sup-1', cash, oldestFirst: true, ...over };
}

describe('simulateSequentialApplications', () => {
  it('applies one line oldest-first and reports the remainder on account', () => {
    const out = simulateSequentialApplications([line(0, 250)], new Map([['sup-1', BILLS]]));
    expect(out).toEqual([{
      index: 0,
      applications: [
        { documentId: 'b1', documentNumber: 'BILL-001', amount: 100 },
        { documentId: 'b2', documentNumber: 'BILL-002', amount: 150 },
      ],
      onAccount: 0,
    }]);
  });

  it('leaves the surplus on account when the open documents run out', () => {
    const out = simulateSequentialApplications([line(0, 700)], new Map([['sup-1', BILLS]]));
    expect(out[0]!.applications.map((a) => a.amount)).toEqual([100, 200, 300]);
    expect(out[0]!.onAccount).toBe(100);
  });

  it('lets a later line see what an earlier line consumed', () => {
    // The defect this exists for: both lines planned against the opening
    // balance would each claim BILL-001 in full.
    const out = simulateSequentialApplications(
      [line(0, 150), line(1, 150)],
      new Map([['sup-1', BILLS]]),
    );
    expect(out[0]!.applications).toEqual([
      { documentId: 'b1', documentNumber: 'BILL-001', amount: 100 },
      { documentId: 'b2', documentNumber: 'BILL-002', amount: 50 },
    ]);
    expect(out[1]!.applications).toEqual([
      { documentId: 'b2', documentNumber: 'BILL-002', amount: 150 },
    ]);
    expect(out[1]!.onAccount).toBe(0);
  });

  it('keeps entities apart', () => {
    const out = simulateSequentialApplications(
      [line(0, 100), line(1, 100, { entityKey: 'sup-2' })],
      new Map([
        ['sup-1', BILLS],
        ['sup-2', [{ invoiceId: 'c1', invoiceNumber: 'BILL-C1', outstanding: 500 }]],
      ]),
    );
    expect(out[0]!.applications[0]!.documentId).toBe('b1');
    expect(out[1]!.applications[0]!.documentId).toBe('c1');
  });

  it('honours a newest-first line without disturbing the shared balances', () => {
    const out = simulateSequentialApplications(
      [line(0, 350, { oldestFirst: false }), line(1, 100)],
      new Map([['sup-1', BILLS]]),
    );
    expect(out[0]!.applications).toEqual([
      { documentId: 'b3', documentNumber: 'BILL-003', amount: 300 },
      { documentId: 'b2', documentNumber: 'BILL-002', amount: 50 },
    ]);
    // b1 is untouched and still the oldest open bill for the next line.
    expect(out[1]!.applications).toEqual([
      { documentId: 'b1', documentNumber: 'BILL-001', amount: 100 },
    ]);
  });

  it('applies nothing for a line with no entity, and leaves it all on account', () => {
    const out = simulateSequentialApplications(
      [line(0, 400, { entityKey: null })],
      new Map([['sup-1', BILLS]]),
    );
    expect(out).toEqual([{ index: 0, applications: [], onAccount: 400 }]);
  });

  it('applies nothing when the entity has no open documents', () => {
    const out = simulateSequentialApplications([line(0, 500)], new Map());
    expect(out).toEqual([{ index: 0, applications: [], onAccount: 500 }]);
  });

  it('consumes a NAMED document, so a later FIFO line sees the reduced balance', () => {
    // A batch line that names an invoice_id is applied by the live path too —
    // through a different service, which reports its own result — so the
    // preview must consume its balance without reporting it, or line 2's FIFO
    // plan is measured against money line 1 has already spent.
    const out = simulateSequentialApplications(
      [line(0, 60, { documentId: 'b2' }), line(1, 300)],
      new Map([['sup-1', BILLS]]),
    );
    expect(out[0]!.applications).toEqual([
      { documentId: 'b2', documentNumber: 'BILL-002', amount: 60 },
    ]);
    expect(out[1]!.applications).toEqual([
      { documentId: 'b1', documentNumber: 'BILL-001', amount: 100 },
      { documentId: 'b2', documentNumber: 'BILL-002', amount: 140 },
      { documentId: 'b3', documentNumber: 'BILL-003', amount: 60 },
    ]);
  });

  it('caps a named document at its own balance and leaves the rest on account', () => {
    const out = simulateSequentialApplications(
      [line(0, 500, { documentId: 'b1' })],
      new Map([['sup-1', BILLS]]),
    );
    expect(out[0]!.applications).toEqual([
      { documentId: 'b1', documentNumber: 'BILL-001', amount: 100 },
    ]);
    expect(out[0]!.onAccount).toBe(400);
  });

  it('applies nothing for a named document that is not open', () => {
    const out = simulateSequentialApplications(
      [line(0, 50, { documentId: 'gone' })],
      new Map([['sup-1', BILLS]]),
    );
    expect(out[0]!).toEqual({ index: 0, applications: [], onAccount: 50 });
  });

  it('skips a document with under a cent left on it', () => {
    // payment_allocations carries CHECK (amount_allocated > 0); a rounding
    // crumb is not a settlement.
    const out = simulateSequentialApplications(
      [line(0, 50)],
      new Map([['sup-1', [
        { invoiceId: 'b0', invoiceNumber: 'CRUMB', outstanding: 0.004 },
        { invoiceId: 'b1', invoiceNumber: 'BILL-001', outstanding: 100 },
      ]]]),
    );
    expect(out[0]!.applications).toEqual([
      { documentId: 'b1', documentNumber: 'BILL-001', amount: 50 },
    ]);
  });
});
