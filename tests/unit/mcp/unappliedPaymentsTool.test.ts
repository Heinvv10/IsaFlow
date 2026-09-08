/**
 * `list_unapplied_payments` — the AP mirror of `list_unapplied_receipts`.
 *
 * The tool's job is the envelope: totals over the whole population rather than
 * the page, and payments whose supplier is gone reported in `excludedRows` with
 * their amount instead of silently dropped. A completeness claim that cannot
 * fail is worse than none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/unappliedPaymentService', () => ({
  getUnappliedPayments: vi.fn(),
}));

import { getUnappliedPayments } from '@/modules/accounting/services/ap/unappliedPaymentService';
import { listUnappliedPaymentsTool } from '@/lib/mcp/tools/supplierPayments';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:invoices'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

const row = (over: Record<string, unknown> = {}) => ({
  paymentId: 'aaaaaaaa-0000-4000-8000-000000000001',
  paymentNumber: 'SP-2026-00001',
  paymentDate: '2026-05-01',
  supplierId: 'dddddddd-0000-4000-8000-000000000001',
  supplierName: 'Acme Supplies',
  paymentAmount: 100000,
  allocatedAmount: 40000,
  unappliedAmount: 60000,
  status: 'processed',
  reference: 'EFT-771',
  description: 'March account',
  journalEntryId: 'je1',
  ...over,
});

const result = (over: Record<string, unknown> = {}) => ({
  rows: [row()], rowsTotal: 1, universeTotal: 1, unattributed: [],
  totalUnapplied: 60000, totalUnattributed: 0,
  postedThrough: '2026-09-07T17:58:00.000Z', ...over,
});

beforeEach(() => {
  vi.mocked(getUnappliedPayments).mockReset().mockResolvedValue(result() as never);
});

describe('list_unapplied_payments', () => {
  it('serves the partly applied remainder, company-scoped from ctx', async () => {
    const body = payload(await listUnappliedPaymentsTool.handler({ as_at: '2026-09-08' }, CTX));
    assertEnvelopeSound(body as never);
    expect(vi.mocked(getUnappliedPayments).mock.calls[0]![0]).toBe(CTX.companyId);
    expect(body.rows).toEqual([expect.objectContaining({
      payment_number: 'SP-2026-00001', payment_amount: 100000,
      allocated_amount: 40000, unapplied_amount: 60000, status: 'processed',
    })]);
    expect(body.totalUnapplied).toBe(60000);
  });

  it('totals over the population, not the page', async () => {
    vi.mocked(getUnappliedPayments).mockResolvedValue(result({
      rowsTotal: 39, universeTotal: 39, totalUnapplied: 37719269.77,
    }) as never);
    const body = payload(await listUnappliedPaymentsTool.handler({ as_at: '2026-09-08', limit: 1 }, CTX));
    expect((body.rows as unknown[]).length).toBe(1);
    expect(body.rowsTotal).toBe(39);
    expect(body.totalUnapplied).toBe(37719269.77);
    expect(body.truncated).toBe(true);
    expect(body.next_cursor).toEqual(expect.any(String));
  });

  it('reports a payment whose supplier is gone in excludedRows, with its amount', async () => {
    vi.mocked(getUnappliedPayments).mockResolvedValue(result({
      rows: [], rowsTotal: 0, universeTotal: 1, totalUnapplied: 0,
      unattributed: [row({ paymentId: 'orphan-1', paymentNumber: 'SP-9', supplierId: null, supplierName: null, unappliedAmount: 25000 })],
      totalUnattributed: 25000,
    }) as never);
    const body = payload(await listUnappliedPaymentsTool.handler({ as_at: '2026-09-08' }, CTX));
    // rowsTotal + excludedRows === universeTotal, and the envelope checks it.
    assertEnvelopeSound(body as never);
    expect(body.excludedRows).toEqual([expect.objectContaining({
      id: 'orphan-1', reason: 'unknown_counterparty', amount: 25000, documentNumber: 'SP-9',
    })]);
    expect(body.totalUnattributed).toBe(25000);
  });

  it('detail "summary" serves the totals and no rows', async () => {
    const body = payload(await listUnappliedPaymentsTool.handler({ detail: 'summary' }, CTX));
    assertEnvelopeSound(body as never);
    expect(body.rows).toEqual([]);
    expect(body.totalUnapplied).toBe(60000);
  });

  it('refuses detail "full" — an unapplied payment has no allocations to expand', async () => {
    const res = await listUnappliedPaymentsTool.handler({ detail: 'full' }, CTX) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(vi.mocked(getUnappliedPayments)).not.toHaveBeenCalled();
  });

  it('refuses an as_at Postgres could not cast, before querying', async () => {
    const res = await listUnappliedPaymentsTool.handler({ as_at: '2026-02-31' }, CTX) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(vi.mocked(getUnappliedPayments)).not.toHaveBeenCalled();
  });

  it('pages by keyset cursor rather than offset', async () => {
    const first = payload(await listUnappliedPaymentsTool.handler({ limit: 1 }, CTX));
    await listUnappliedPaymentsTool.handler({ limit: 1, cursor: first.next_cursor }, CTX);
    expect(vi.mocked(getUnappliedPayments).mock.calls[1]![1]).toMatchObject({
      after: { paymentDate: '2026-05-01', id: 'aaaaaaaa-0000-4000-8000-000000000001' },
    });
  });

  it('is a read tool', () => {
    expect(listUnappliedPaymentsTool.write).toBe(false);
  });
});
