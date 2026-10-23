/**
 * AP-01 round 15: the durable record's own bounds are the ones the settle budget counts - its checkout waits at most
 * UNRECORDED_ANSWER_CHECKOUT_MS and its transaction gets UNRECORDED_ANSWER_BUDGET_MS in all (nothing is sent past it).
 */
import { describe, expect, it, vi } from 'vitest';

const conn = vi.hoisted(() => ({ connectWithin: vi.fn(), sent: [] as string[] }));
vi.mock('@/modules/accounting/services/ap/netcashSendCapacity', () => ({ connectWithin: conn.connectWithin }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), getPool: () => ({}) }));
vi.mock('@/lib/rollbackFailed', () => ({ rollbackFailed: vi.fn(async () => false) }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { recordUnrecordedAnswer } from '@/modules/accounting/services/ap/netcashUnrecordedAnswer';
import { UNRECORDED_ANSWER_BUDGET_MS, UNRECORDED_ANSWER_CHECKOUT_MS } from '@/modules/accounting/services/ap/netcashTimeouts';

describe('recordUnrecordedAnswer bounds', () => {
  it('checks out within UNRECORDED_ANSWER_CHECKOUT_MS and sends nothing once UNRECORDED_ANSWER_BUDGET_MS is spent', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const client = {
      on: vi.fn(), removeListener: vi.fn(), release: vi.fn(),
      query: vi.fn(async (cfg: { text: string }) => {
        conn.sent.push(cfg.text);
        if (/^BEGIN/.test(cfg.text)) clock += UNRECORDED_ANSWER_BUDGET_MS; // the attempt's whole budget goes on BEGIN
        return { rows: [], rowCount: 0 };
      }),
    };
    conn.connectWithin.mockResolvedValue(client);
    try {
      const ok = await recordUnrecordedAnswer({ companyId: 'c', userId: 'u', claims: {} }, '00000000-0000-0000-0000-000000000001',
        { status: 'submitted', batchReference: 'NC', netcashResponse: { outcome: 'accepted' }, submittedAt: null }, 'tok');
      expect({ ok, checkout: conn.connectWithin.mock.calls[0]?.[1], insertSent: conn.sent.some((t) => /INSERT INTO audit_log/.test(t)) })
        .toEqual({ ok: false, checkout: UNRECORDED_ANSWER_CHECKOUT_MS, insertSent: false });
    } finally {
      now.mockRestore();
    }
  });
});
