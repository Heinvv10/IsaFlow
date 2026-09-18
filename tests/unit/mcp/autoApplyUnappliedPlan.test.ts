/**
 * The back-fill's plan builder and its argument checks.
 *
 * The builder is pure — every open document, date and remainder is handed in —
 * so these are the tests that pin the ORDERING CONTRACT without a database:
 * oldest cash first, balances consumed sequentially, a remainder left on
 * account, and a payment with nothing open reported separately rather than
 * hidden in a total.
 */
import { describe, it, expect } from 'vitest';
import {
  assembleBackfillPlan,
  buildBackfillPlan,
  type BackfillSource,
} from '@/modules/accounting/services/shared/autoApplyBackfillPlan';
import type { SimulationDocument } from '@/modules/accounting/services/shared/autoApplySimulation';
import { parseAutoApplyUnappliedArgs } from '@/lib/mcp/tools/writeAutoApplyUnapplied';

const SUP = 'supplier-1';

function source(over: Partial<BackfillSource> = {}): BackfillSource {
  return {
    kind: 'payment',
    paymentId: 'pay-1',
    paymentNumber: 'PAY-001',
    entityId: SUP,
    entityName: 'Acme',
    paymentDate: '2026-01-10',
    remainder: 100,
    ...over,
  };
}

function doc(id: string, outstanding: number): SimulationDocument {
  return { invoiceId: id, invoiceNumber: id.toUpperCase(), outstanding };
}

const dates = new Map([['b1', '2026-01-01'], ['b2', '2026-01-02'], ['b3', '2026-01-03']]);

function plan(sources: BackfillSource[], docs: SimulationDocument[], oldestFirst = true) {
  return buildBackfillPlan({
    subledger: 'ap',
    sources,
    openByEntity: new Map([[SUP, docs]]),
    oldestFirstByEntity: new Map([[SUP, oldestFirst]]),
    documentDates: dates,
  });
}

describe('buildBackfillPlan', () => {
  it('settles the oldest bills in turn and part-pays the one the money runs out on', () => {
    const result = plan([source({ remainder: 250 })], [doc('b1', 100), doc('b2', 200)]);

    expect(result.dry_run).toBe(true);
    expect(result.applications).toHaveLength(1);
    expect(result.applications[0]!.lines).toEqual([
      { document_id: 'b1', document_number: 'B1', invoice_date: '2026-01-01', amount: 100 },
      { document_id: 'b2', document_number: 'B2', invoice_date: '2026-01-02', amount: 150 },
    ]);
    expect(result.applications[0]!.on_account_after).toBe(0);
    expect(result.totals).toEqual({
      applied: 250,
      left_on_account: 0,
      no_open_documents_amount: 0,
      payments_with_no_open_documents: 0,
    });
  });

  it('consumes balances sequentially, so the second payment cannot re-spend the first bill', () => {
    const result = plan(
      [
        source({ paymentId: 'p1', paymentNumber: 'PAY-001', remainder: 100 }),
        source({ paymentId: 'p2', paymentNumber: 'PAY-002', remainder: 100 }),
      ],
      [doc('b1', 100), doc('b2', 100)],
    );

    expect(result.applications.map((a) => a.lines.map((l) => l.document_id)))
      .toEqual([['b1'], ['b2']]);
    expect(result.totals.applied).toBe(200);
  });

  it('leaves the surplus on account when every bill is settled', () => {
    const result = plan([source({ remainder: 500 })], [doc('b1', 100)]);

    expect(result.applications[0]!.on_account_after).toBe(400);
    expect(result.totals).toMatchObject({ applied: 100, left_on_account: 400 });
  });

  it('reports a payment with nothing open separately, never as an application', () => {
    const result = plan(
      [
        source({ paymentId: 'p1', remainder: 100 }),
        source({ paymentId: 'p2', paymentNumber: 'PAY-002', remainder: 80 }),
      ],
      [doc('b1', 100)],
    );

    expect(result.applications.map((a) => a.payment_id)).toEqual(['p1']);
    expect(result.no_open_documents).toEqual([{
      kind: 'payment',
      payment_id: 'p2',
      payment_number: 'PAY-002',
      entity_id: SUP,
      entity_name: 'Acme',
      payment_date: '2026-01-10',
      amount: 80,
      skipped_reason: null,
    }]);
    expect(result.totals).toMatchObject({
      no_open_documents_amount: 80, payments_with_no_open_documents: 1,
    });
    expect(result.processed).toBe(2);
  });

  it('never applies a skipped source, and never lets it consume a bill', () => {
    const result = plan(
      [
        source({ kind: 'credit_note', paymentId: 'cn1', remainder: 100, skippedReason: 'no table' }),
        source({ paymentId: 'p2', remainder: 100 }),
      ],
      [doc('b1', 100)],
    );

    expect(result.no_open_documents[0]).toMatchObject({
      payment_id: 'cn1', skipped_reason: 'no table',
    });
    // The bill the skipped note did NOT take is still there for the payment.
    expect(result.applications[0]!.lines.map((l) => l.document_id)).toEqual(['b1']);
  });

  it('consumes newest first for a contact that asked for it', () => {
    const result = plan(
      [source({ remainder: 100 })], [doc('b1', 100), doc('b2', 100)], false,
    );
    expect(result.applications[0]!.lines.map((l) => l.document_id)).toEqual(['b2']);
  });

  it('reports a null invoice_date rather than inventing one', () => {
    const result = plan([source({ remainder: 50 })], [doc('unknown', 50)]);
    expect(result.applications[0]!.lines[0]!.invoice_date).toBeNull();
  });
});

describe('assembleBackfillPlan', () => {
  it('carries a live run failures list without counting it as processed', () => {
    const result = assembleBackfillPlan(
      false, 'ar', [{ source: source(), lines: [] }],
      [{ payment_id: 'p9', payment_number: 'PAY-009', error: 'database error 40P01' }],
    );
    expect(result.dry_run).toBe(false);
    expect(result.subledger).toBe('ar');
    expect(result.processed).toBe(1);
    expect(result.failed).toEqual([
      { payment_id: 'p9', payment_number: 'PAY-009', error: 'database error 40P01' },
    ]);
  });
});

describe('parseAutoApplyUnappliedArgs', () => {
  it('defaults dry_run to TRUE when it is absent', () => {
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ap' }))
      .toMatchObject({ dryRun: true, subledger: 'ap', entityId: null, limit: 500 });
  });

  it('runs live only on an explicit false', () => {
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ar', dry_run: false }))
      .toMatchObject({ dryRun: false });
  });

  it('refuses a subledger that is neither side of the ledger', () => {
    expect(parseAutoApplyUnappliedArgs({ subledger: 'gl' })).toBe('subledger must be one of ap, ar');
    expect(parseAutoApplyUnappliedArgs({})).toBe('subledger must be one of ap, ar');
  });

  it('refuses a non-boolean dry_run rather than coercing it', () => {
    // 'false' the STRING is truthy; coercing it would run live on an argument
    // the agent meant as a dry run.
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ap', dry_run: 'false' }))
      .toBe('dry_run must be a boolean');
  });

  it('refuses a limit that is not a positive number, and caps a huge one', () => {
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ap', limit: 0 }))
      .toBe('limit must be a positive number');
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ap', limit: 'ten' }))
      .toBe('limit must be a positive number');
    expect(parseAutoApplyUnappliedArgs({ subledger: 'ap', limit: 99999 }))
      .toMatchObject({ limit: 2000 });
  });
});
