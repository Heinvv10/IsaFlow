/**
 * withJournalDateRefusal's hand-back: a posting call that RETURNED on a transaction it had itself aborted (only the
 * RELEASE fails, 25P02) gets its answer back, and the request is marked rollback-only so its owner cannot commit.
 * A 25P02 the call itself threw is not a hand-back: it propagates, and the flag stays unset.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => ({ releaseFails: false }));
vi.mock('@/lib/neon', () => ({
  withSavepoint: async (_name: string, fn: () => Promise<unknown>) => {
    const value = await fn();
    if (h.releaseFails) throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    return value;
  },
}));

import { als, type RequestContext } from '@/lib/als';
import { withJournalDateRefusal } from '@/lib/apiJournalDate';

const res = {} as NextApiResponse;
const store = () => ({ client: {}, afterCommit: [] }) as unknown as RequestContext;

describe('withJournalDateRefusal: the 25P02 hand-back', () => {
  it('the call returned, then RELEASE failed 25P02: the answer comes back and the request is rollback-only', async () => {
    h.releaseFails = true;
    const ctx = store();
    const out = await als.run(ctx, () => withJournalDateRefusal(res, async () => ({ contended: true })));
    expect(out).toEqual({ contended: true });
    expect(ctx.rollbackOnly).toMatch(/aborted/);
  });

  it('RELEASE succeeds: the answer comes back and the flag stays unset', async () => {
    h.releaseFails = false;
    const ctx = store();
    const out = await als.run(ctx, () => withJournalDateRefusal(res, async () => 'ok'));
    expect(out).toBe('ok');
    expect(ctx.rollbackOnly).toBeUndefined();
  });

  it('the call itself threw 25P02: it propagates, and the flag stays unset', async () => {
    h.releaseFails = false;
    const ctx = store();
    const thrown = Object.assign(new Error('aborted'), { code: '25P02' });
    await expect(als.run(ctx, () => withJournalDateRefusal(res, async () => { throw thrown; }))).rejects.toBe(thrown);
    expect(ctx.rollbackOnly).toBeUndefined();
  });
});
