/** `due_by_date`: a WRAP of the report service; companyId from ctx only. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/dueByDateService', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/reports/dueByDateService')>(
    '@/modules/accounting/services/reports/dueByDateService',
  );
  return { ...actual, appToday: () => '2026-11-05', getDueByDate: vi.fn() };
});

import { DueByDateInputError, getDueByDate } from '@/modules/accounting/services/reports/dueByDateService';
import { buildDueByDateSide } from '@/modules/accounting/utils/dueByDate';
import { dueByDateTool } from '@/lib/mcp/tools/reportsDueByDate';
import type { McpToolContext } from '@/lib/mcp/types';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';

const CTX = { userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111', scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const CUST = 'cccccccc-0000-4000-8000-000000000001';

const inv = (over: Partial<OpenAgingInvoice>): OpenAgingInvoice => ({
  id: 'i1', invoiceNumber: 'INV-1', entityId: CUST, entityName: 'Blitz', dueDate: '2026-11-10', dueDateMissing: false,
  totalAmount: 500, amountPaid: 0, balance: 500, invoiceDate: '2026-10-01', reference: null, ...over,
});

const body = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;

beforeEach(() => {
  vi.mocked(getDueByDate).mockReset().mockImplementation(async (_co, side, byDate) =>
    buildDueByDateSide(side, side === 'ar' ? [inv({}), inv({ id: 'i2', dueDateMissing: true, balance: 70 })] : [inv({ id: 'p1', entityId: 's', balance: 200 })], '2026-11-05', byDate));
});

describe('due_by_date', () => {
  it('is a read tool on read:reports', () => {
    expect(dueByDateTool.write).toBe(false);
    expect(dueByDateTool.scope).toBe('read:reports');
  });

  it('returns both sides with totals and net position; contacts carry no invoices', async () => {
    const b = body(await dueByDateTool.handler({ by_date: '2026-11-30' }, CTX));
    expect(b.byDate).toBe('2026-11-30');
    expect(b.receivables.totals).toMatchObject({ dueTodayToDate: 500, noDueDate: 70, total: 570 });
    expect(b.payables.totals.totalByDate).toBe(200);
    expect(b.netPosition).toBe(300);
    expect(b.receivables.contacts[0].invoices).toBeUndefined();
  });

  it('states what the net position leaves out', async () => {
    const b = body(await dueByDateTool.handler({ by_date: '2026-11-30' }, CTX));
    expect(b.netPositionExcludesNoDueDate).toEqual({ receivables: 70, payables: 0 });
  });

  it('an entity_id with nothing open is an error that says so, not an empty list', async () => {
    const other = 'dddddddd-0000-4000-8000-000000000009';
    const r = await dueByDateTool.handler({ side: 'ar', entity_id: other }, CTX);
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toContain(other);
    expect(text).toContain('NOT a confirmation that nothing is owed');
  });

  it('uses the company from ctx, and defaults by_date to the end of the current month', async () => {
    await dueByDateTool.handler({}, CTX);
    expect(getDueByDate).toHaveBeenCalledWith(CTX.companyId, 'ar', '2026-11-30');
    expect(getDueByDate).toHaveBeenCalledWith(CTX.companyId, 'ap', '2026-11-30');
  });

  it('side + entity_id drills into one contact WITH invoices, and gives no net position', async () => {
    const b = body(await dueByDateTool.handler({ side: 'ar', entity_id: CUST }, CTX));
    expect(b.payables).toBeUndefined();
    expect(b.netPosition).toBeUndefined();
    expect(b.receivables.contacts).toHaveLength(1);
    expect(b.receivables.contacts[0].invoices.map((i: { dueDate: string | null }) => i.dueDate)).toEqual(['2026-11-10', null]);
  });

  it('refuses entity_id without side, a bad side, and malformed args before any query', async () => {
    for (const args of [{ entity_id: CUST }, { side: 'xx' }, { by_date: 'soon' }, { side: 'ar', entity_id: 'nope' }]) {
      const r = await dueByDateTool.handler(args, CTX);
      expect((r as { isError?: boolean }).isError, JSON.stringify(args)).toBe(true);
    }
    expect(getDueByDate).not.toHaveBeenCalled();
  });

  it('reports a refused by_date as a tool error, not a crash', async () => {
    vi.mocked(getDueByDate).mockRejectedValue(new DueByDateInputError('by_date must be today or later (today is 2026-11-05)'));
    const r = await dueByDateTool.handler({ by_date: '2026-11-01' }, CTX);
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(r)).toContain('today or later');
  });
});
