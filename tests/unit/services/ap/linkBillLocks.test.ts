/**
 * PR #1703 review r16: the link's bill locks (purchaseOrderBillLinkRead.lockBills). Only a busy tie (55P03) is retried, in a fresh
 * savepoint each time, 5 attempts at most, never past the deadline; anything else ends the call on the first attempt as it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { script, runs } = vi.hoisted(() => ({ script: [] as unknown[], runs: { n: 0 } }));
vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(async () => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? [];
  }), { unsafe: (raw: string) => ({ raw }) }),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { runs.n += 1; return fn(); }),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { lockBills } from '@/modules/accounting/services/ap/purchaseOrderBillLinkRead';
import { TiedBillBusyError } from '@/modules/accounting/services/ap/purchaseOrderErrors';
import { RowLockTimeoutError } from '@/modules/accounting/services/core/rowLockBudget';

const busy = () => Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
const POS = [{ id: 'P1', po_number: 'PO-1' }];
const later = () => Date.now() + 60_000;
const call = (deadline = later()) => lockBills('c1', ['p1'], ['b1'], POS, deadline);
/** One attempt: the own-bill lock answers, then the tie lock does `tie`. */
const attempt = (tie: unknown) => script.push([], tie);

beforeEach(() => { script.length = 0; runs.n = 0; });

describe('lockBills', () => {
  it('a 23505 propagates after one attempt', async () => {
    script.push(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(call()).rejects.toMatchObject({ code: '23505' });
    expect(runs.n).toBe(1);
  });
  it('a waited-out own bill (RowLockTimeoutError) propagates after one attempt, not as a busy tie', async () => {
    script.push(new RowLockTimeoutError('A bill in this call'));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RowLockTimeoutError);
    expect(err).not.toBeInstanceOf(TiedBillBusyError);
    expect(runs.n).toBe(1);
  });
  it('a tie busy every time: exactly 5 savepoint runs, then TiedBillBusyError naming the PO', async () => {
    for (let i = 0; i < 8; i++) attempt(busy());
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TiedBillBusyError);
    expect((err as Error).message).toBe('A bill tied to purchase order PO-1 is being changed right now; retry in a moment.');
    expect(runs.n).toBe(5);
  });
  it('a tie busy twice, then free: three runs, no refusal', async () => {
    attempt(busy()); attempt(busy()); attempt([]);
    await expect(call()).resolves.toBeUndefined();
    expect(runs.n).toBe(3);
  });
  it('a deadline already passed stops the loop: one run, TiedBillBusyError (never "A bill in this call")', async () => {
    for (let i = 0; i < 8; i++) attempt(busy());
    const err = await call(Date.now() - 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TiedBillBusyError);
    expect(runs.n).toBe(1);
  });
  it('a deadline that falls inside the sleep stops the loop after it', async () => {
    for (let i = 0; i < 8; i++) attempt(busy());
    const t0 = Date.now();
    const err = await call(Date.now() + 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TiedBillBusyError);
    expect(runs.n).toBeLessThan(5);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
