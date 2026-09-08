/**
 * `aged_debtors` / `aged_creditors` v2 (W2) — WRAPS of the aging services.
 *
 * What the audit found, and it was exact: ten rows, no total, no rowsTotal, no
 * truncated, no envelope. To answer "what are we owed" the reader had to sum
 * ten rows by hand — which is how R63,133,371.78 came to be a number somebody
 * added up rather than a number the tool reported.
 *
 * So the totals come first, and they are computed over EVERY entity rather than
 * over the page. A paginated report whose totals describe only the page is the
 * more dangerous shape: it looks complete.
 *
 * Two things are reported beside the buckets because they change what the
 * buckets mean:
 *
 *  - `unappliedReceipts` / `unappliedPayments` — cash on the control account
 *    attached to no document. AR reports receipts applied to no invoice, AP
 *    reports supplier payments applied to no bill; each reduces its own side's
 *    balance and is in NONE of these buckets, so an aged total read without it
 *    overstates the figure. Named on both sides, netted on neither.
 *  - `agedFromInvoiceDate` — invoices with no due date. Since #303 they are
 *    aged from their invoice date instead of being dropped, so they ARE in the
 *    buckets and their age is derived. That is worth stating; it is not an
 *    exclusion, and it is deliberately NOT in excludedRows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({
  getARAging: vi.fn(), getARAgingDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({
  getAPAging: vi.fn(), getAPAgingDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptService', () => ({
  getUnappliedReceipts: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/unappliedPaymentService', () => ({
  getUnappliedPayments: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-08-31T22:15:00.000Z'),
}));

import { getARAging, getARAgingDetail } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging, getAPAgingDetail } from '@/modules/accounting/services/ap/apAgingService';
import { getUnappliedReceipts } from '@/modules/accounting/services/ar/unappliedReceiptService';
import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';
import { agedDebtorsTool, agedCreditorsTool } from '@/lib/mcp/tools/reportsAging';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

const bucket = (over: Record<string, unknown> = {}) => ({
  entityId: 'cccccccc-0000-4000-8000-000000000001', entityName: 'Blitz Fibre',
  current: 100, days30: 200, days60: 0, days90: 0, days120Plus: 700, total: 1000, ...over,
});

const NO_RECEIPTS = {
  rows: [], rowsTotal: 0, universeTotal: 0, unattributed: [],
  totalUnapplied: 0, totalUnattributed: 0, postedThrough: '2026-08-31T22:15:00.000Z',
};

beforeEach(() => {
  vi.mocked(getARAging).mockReset().mockResolvedValue([bucket()]);
  vi.mocked(getAPAging).mockReset().mockResolvedValue([bucket({ entityName: 'Acme Supplies' })]);
  vi.mocked(getARAgingDetail).mockReset();
  vi.mocked(getAPAgingDetail).mockReset();
  vi.mocked(getUnappliedReceipts).mockReset().mockResolvedValue(NO_RECEIPTS as never);
  vi.mocked(getUnappliedPayments).mockReset().mockResolvedValue(NO_RECEIPTS as never);
});

describe('aged_debtors', () => {
  it('reports the TOTAL, and every bucket total, over all entities', async () => {
    vi.mocked(getARAging).mockResolvedValue([
      bucket({ entityId: 'a', current: 100, days30: 0, days120Plus: 0, total: 100 }),
      bucket({ entityId: 'b', current: 0, days30: 250, days120Plus: 400, total: 650 }),
    ]);
    const body = payload(await agedDebtorsTool.handler({ as_at: '2026-08-31' }, CTX));
    assertEnvelopeSound(body as never);

    // The whole point. The audit had to sum ten rows by hand.
    expect(body.total).toBe(750);
    expect(body.buckets).toEqual({ current: 100, days30: 250, days60: 0, days90: 0, days120Plus: 400 });
    expect(body.entityCount).toBe(2);
    expect(body.rowsTotal).toBe(2);
  });

  it('totals over EVERY entity, not just the page', async () => {
    vi.mocked(getARAging).mockResolvedValue([
      bucket({ entityId: 'a', total: 100, current: 100, days30: 0, days120Plus: 0 }),
      bucket({ entityId: 'b', total: 650, current: 0, days30: 250, days120Plus: 400 }),
    ]);
    const body = payload(await agedDebtorsTool.handler({ as_at: '2026-08-31', limit: 1 }, CTX));
    // One row served, both counted. A total that follows the page is the more
    // dangerous error: it looks complete.
    expect((body.rows as unknown[]).length).toBe(1);
    expect(body.total).toBe(750);
    expect(body.rowsTotal).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.next_cursor).toEqual(expect.any(String));
  });

  it('pages to exhaustion, serving every entity exactly once', async () => {
    vi.mocked(getARAging).mockResolvedValue([
      bucket({ entityId: 'a', total: 1 }), bucket({ entityId: 'b', total: 2 }),
      bucket({ entityId: 'c', total: 3 }),
    ]);
    const seen: string[] = [];
    let cursor: unknown = undefined;
    for (let i = 0; i < 5; i++) {
      const body = payload(await agedDebtorsTool.handler(
        cursor === undefined ? { as_at: '2026-08-31', limit: 2 } : { as_at: '2026-08-31', limit: 2, cursor },
        CTX,
      ));
      for (const r of body.rows as Array<{ entityId: string }>) seen.push(r.entityId);
      if (body.next_cursor === null) break;
      cursor = body.next_cursor;
    }
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('reports unapplied receipts, which are in NO bucket and reduce the debt', async () => {
    vi.mocked(getUnappliedReceipts).mockResolvedValue({
      ...NO_RECEIPTS, rowsTotal: 39, totalUnapplied: 37719269.77,
    } as never);
    const body = payload(await agedDebtorsTool.handler({ as_at: '2026-08-31' }, CTX));
    expect(body.unappliedReceipts).toMatchObject({ count: 39, total: 37719269.77 });
    expect(body.unappliedPayments).toBeUndefined();
    // Named, not netted: netting it off would invent a figure no report owns.
    expect(body.total).toBe(1000);
  });

  it('names the invoices whose age is DERIVED from the invoice date', async () => {
    vi.mocked(getARAgingDetail).mockResolvedValue({
      client: { id: 'cccccccc-0000-4000-8000-000000000001', name: 'Blitz Fibre' },
      invoices: [
        { id: 'i1', entityId: 'c1', entityName: 'Blitz', dueDate: '2026-01-01',
          dueDateMissing: true, totalAmount: 1058000, amountPaid: 0, balance: 1058000 },
      ],
      buckets: bucket(),
    } as never);
    const body = payload(await agedDebtorsTool.handler(
      { as_at: '2026-08-31', entity_id: 'cccccccc-0000-4000-8000-000000000001' }, CTX,
    ));
    // In the buckets, not excluded from them — since #303 they are aged from
    // invoice_date. Saying so is different from dropping them, which is the
    // R1,058,000 defect.
    expect(body.agedFromInvoiceDate).toMatchObject({ count: 1, total: 1058000 });
    expect(body.excludedRows).toEqual([]);
  });

  it('drills into ONE entity and returns its invoices', async () => {
    vi.mocked(getARAgingDetail).mockResolvedValue({
      client: { id: 'cccccccc-0000-4000-8000-000000000001', name: 'Blitz Fibre' },
      invoices: [
        { id: 'i1', entityId: 'c1', entityName: 'Blitz', dueDate: '2026-01-01',
          totalAmount: 600, amountPaid: 100, balance: 500 },
        { id: 'i2', entityId: 'c1', entityName: 'Blitz', dueDate: '2026-02-01',
          totalAmount: 500, amountPaid: 0, balance: 500 },
      ],
      buckets: bucket(),
    } as never);
    const body = payload(await agedDebtorsTool.handler(
      { as_at: '2026-08-31', entity_id: 'cccccccc-0000-4000-8000-000000000001' }, CTX,
    ));
    assertEnvelopeSound(body as never);
    expect(vi.mocked(getARAgingDetail).mock.calls[0]![0]).toBe(CTX.companyId);
    expect(body.entity).toMatchObject({ id: 'cccccccc-0000-4000-8000-000000000001', name: 'Blitz Fibre' });
    expect((body.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(body.total).toBe(1000);
    // The whole-book aging is NOT run when one entity was asked for.
    expect(vi.mocked(getARAging)).not.toHaveBeenCalled();
  });

  it('refuses an as_at or entity_id Postgres could not cast, before querying', async () => {
    for (const args of [{ as_at: '2026-02-31' }, { as_at: '2026-08-31', entity_id: 'nope' }]) {
      expect(((await agedDebtorsTool.handler(args, CTX)) as { isError?: boolean }).isError).toBe(true);
    }
    expect(vi.mocked(getARAging)).not.toHaveBeenCalled();
    expect(vi.mocked(getARAgingDetail)).not.toHaveBeenCalled();
  });

  it('detail "summary" serves the totals and no rows', async () => {
    const body = payload(await agedDebtorsTool.handler({ as_at: '2026-08-31', detail: 'summary' }, CTX));
    assertEnvelopeSound(body as never);
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(1000);
    expect(body.rowsTotal).toBe(1);
  });
});

describe('aged_creditors', () => {
  it('reports the same totals for suppliers', async () => {
    const body = payload(await agedCreditorsTool.handler({ as_at: '2026-08-31' }, CTX));
    assertEnvelopeSound(body as never);
    expect(body.total).toBe(1000);
    expect(body.entityCount).toBe(1);
    // The AR figure is not reported on the AP side, and vice versa: each side
    // names its own mechanism.
    expect(body.unappliedReceipts).toBeUndefined();
    expect(vi.mocked(getUnappliedReceipts)).not.toHaveBeenCalled();
  });

  it('reports unapplied supplier PAYMENTS, which are in NO bucket and reduce the liability', async () => {
    vi.mocked(getUnappliedPayments).mockResolvedValue({
      ...NO_RECEIPTS, rowsTotal: 12, totalUnapplied: 842300.55,
    } as never);
    const body = payload(await agedCreditorsTool.handler({ as_at: '2026-08-31' }, CTX));
    expect(body.unappliedPayments).toMatchObject({ count: 12, total: 842300.55 });
    // Named, not netted: netting it off would invent a figure no report owns.
    expect(body.total).toBe(1000);
    expect(vi.mocked(getUnappliedPayments).mock.calls[0]![0]).toBe(CTX.companyId);
  });

  it('counts the orphaned payments in the figure too', async () => {
    vi.mocked(getUnappliedPayments).mockResolvedValue({
      ...NO_RECEIPTS, rowsTotal: 2, totalUnapplied: 100,
      unattributed: [{}, {}, {}], totalUnattributed: 250,
    } as never);
    const body = payload(await agedCreditorsTool.handler({ as_at: '2026-08-31' }, CTX));
    // A payment whose supplier row is gone is still cash on the control
    // account. Reporting only the attributable ones understates the figure.
    expect(body.unappliedPayments).toMatchObject({ count: 5, total: 350 });
  });

  it('drills into one supplier', async () => {
    vi.mocked(getAPAgingDetail).mockResolvedValue({
      supplier: { id: 'dddddddd-0000-4000-8000-000000000001', name: 'Acme Supplies' },
      invoices: [
        { id: 'b1', entityId: 's1', entityName: 'Acme', dueDate: '2026-01-01',
          totalAmount: 900, amountPaid: 0, balance: 900 },
      ],
      buckets: bucket(),
    } as never);
    const body = payload(await agedCreditorsTool.handler(
      { as_at: '2026-08-31', entity_id: 'dddddddd-0000-4000-8000-000000000001' }, CTX,
    ));
    expect(body.entity).toMatchObject({ name: 'Acme Supplies' });
    expect((body.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(['b1']);
    expect(body.total).toBe(900);
  });

  it('makes NO completeness claim it cannot fail, on either shape', async () => {
    const body = payload(await agedCreditorsTool.handler({ as_at: '2026-08-31' }, CTX));
    // universeTotal must be absent here. These rows are produced by the report,
    // not selected from a wider pool, so any universe would be synthesized from
    // the very numbers the envelope checks against it — an identity that cannot
    // fail whatever the code did. CONTRACTS.md §1 names that anti-pattern, and
    // an absent claim is honest where one that always passes reads as
    // verification.
    expect(body).not.toHaveProperty('universeTotal');
    expect(body).not.toHaveProperty('completenessFault');
  });
});
