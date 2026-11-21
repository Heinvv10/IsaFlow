/**
 * Codex gate review: the late re-read after a cancel / delete holds its bill takes a newly billing-closed PO only with NOWAIT; a busy
 * one (55P03) is left closed, kept out of billedBefore (so nothing reopens it) and returned as busy, never waited on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, script } = vi.hoisted(() => ({ calls: [] as string[], script: [] as Array<unknown[] | Error> }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(strings.reduce((acc, s, i) => acc + (typeof values[i - 1] === 'object' && (values[i - 1] as { raw?: string })?.raw !== undefined ? (values[i - 1] as { raw: string }).raw : '?') + s));
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  }), { unsafe: (raw: string) => ({ raw }) }),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ap/purchaseOrderBilled', () => ({ billedCentsByPo: vi.fn(async (_c: string, ids: string[]) => new Map(ids.map((i) => [i, 100000]))) }));

import { recheckClosedByBilling } from '@/modules/accounting/services/ap/purchaseOrderBillingClose';

const busy = Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
beforeEach(() => { calls.length = 0; script.length = 0; });

describe('recheckClosedByBilling', () => {
  it('a PO closed by billing meanwhile is locked NOWAIT and read before the change', async () => {
    script.push([{ id: 'P1' }], [{ '?column?': 1 }]);
    const r = await recheckClosedByBilling('c1', 'b1', new Map());
    expect(r).toEqual({ billedBefore: new Map([['p1', 100000]]), busy: [] });
    expect(calls[1]).toContain('FOR NO KEY UPDATE NOWAIT');
  });
  it('a busy one (55P03) is left closed: not in billedBefore, returned as busy with its number', async () => {
    script.push([{ id: 'p1' }], busy, [{ po_number: 'PO-1' }]);
    const r = await recheckClosedByBilling('c1', 'b1', new Map([['p0', 5]]));
    expect(r).toEqual({ billedBefore: new Map([['p0', 5]]), busy: [{ poId: 'p1', poNumber: 'PO-1' }] });
  });
  it('a PO the first read already holds is not re-taken; any other error is thrown', async () => {
    script.push([{ id: 'p0' }]);
    expect((await recheckClosedByBilling('c1', 'b1', new Map([['p0', 5]]))).billedBefore).toEqual(new Map([['p0', 5]]));
    script.push([{ id: 'p1' }], Object.assign(new Error('boom'), { code: '57014' }));
    await expect(recheckClosedByBilling('c1', 'b1', new Map())).rejects.toThrow('boom');
  });
});
