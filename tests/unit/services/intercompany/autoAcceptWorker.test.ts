/**
 * Intercompany P2, the worker's bookkeeping (the database side is in the integration suites): a transient fault defers the message (the
 * queue backs it off), and a deferral at or past STUCK_AT attempts is counted and logged AT ERROR so the cron route can report it; a
 * refusal is stored as a FIXED sentence only when it is one of ours (`safeForSender`), else the generic one (the sender reads `error`),
 * with the detail logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  accept: vi.fn(async (..._a: unknown[]) => ({})),
  failed: vi.fn(async (..._a: unknown[]) => true),
  tx: vi.fn(async (_p: unknown, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@/modules/accounting/services/intercompany/acceptService', () => ({ acceptMessage: m.accept }));
vi.mock('@/modules/accounting/services/intercompany/handleService', () => ({ markMessageFailed: m.failed }));
vi.mock('@/modules/accounting/services/intercompany/receiverTx', () => ({ withReceiverTx: m.tx }));

import { AUTO_ACCEPT_BUDGET_MS, GENERIC, STUCK_AT, runAutoAccept } from '@/modules/accounting/services/intercompany/autoAcceptWorker';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const queueRow = (attempt: number, id = 'm1') => ({ message_id: id, to_company_id: 'co-b', actor_user_id: 'u1', attempt });
const lockTimeout = () => Object.assign(new Error('lock timeout'), { code: '55P03' });

beforeEach(() => {
  vi.clearAllMocks();
  m.accept.mockResolvedValue({});
  m.failed.mockResolvedValue(true);
  m.tx.mockImplementation(async (_p: unknown, fn: () => Promise<unknown>) => fn());
});

describe('runAutoAccept', () => {
  it('claims through the queue (the second argument is true) and accepts as the receiver\'s write-role user', async () => {
    m.sql.mockResolvedValueOnce([queueRow(1)]);
    const run = await runAutoAccept(7);
    expect(run).toEqual({ considered: 1, accepted: 1, failed: 0, deferred: 0, stuck: 0, exhausted: 0 });
    expect(m.sql).toHaveBeenCalledTimes(2); // the queue, then the count of messages that used every attempt
    expect(m.tx).toHaveBeenCalledWith({ userId: 'u1', companyId: 'co-b' }, expect.any(Function));
    expect(m.accept).toHaveBeenCalledWith('u1', 'co-b', 'm1', {}, { auto: true });
  });

  it('a lock timeout early on is a deferral (warn), not stuck, and the message is not marked failed', async () => {
    m.sql.mockResolvedValueOnce([queueRow(1)]);
    m.accept.mockRejectedValueOnce(lockTimeout());
    const run = await runAutoAccept();
    expect(run).toMatchObject({ deferred: 1, stuck: 0, failed: 0 });
    expect(m.failed).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/deferred/), expect.objectContaining({ attempt: 1 }), 'intercompany');
  });

  it(`the same deferral on attempt ${STUCK_AT} or later is stuck: counted, and logged at error`, async () => {
    m.sql.mockResolvedValueOnce([queueRow(STUCK_AT)]);
    m.accept.mockRejectedValueOnce(lockTimeout());
    const run = await runAutoAccept();
    expect(run).toMatchObject({ deferred: 1, stuck: 1 });
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/keeps deferring/), expect.objectContaining({ attempt: STUCK_AT }), 'intercompany');
  });

  it('a pending message that used every attempt (the queue no longer takes it) is counted as stuck, every run, and logged at error', async () => {
    m.sql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ message_id: 'x1' }, { message_id: 'x2' }]);
    const run = await runAutoAccept();
    expect(run).toMatchObject({ considered: 0, stuck: 2, exhausted: 2 });
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/cannot run/), expect.objectContaining({ exhausted: 2, stuck: 2 }), 'intercompany');
  });

  it('exhausted messages add to the messages that keep deferring in the one stuck figure', async () => {
    m.sql.mockResolvedValueOnce([queueRow(STUCK_AT)]).mockResolvedValueOnce([{ message_id: 'm-other' }]);
    m.accept.mockRejectedValueOnce(lockTimeout());
    expect(await runAutoAccept()).toMatchObject({ deferred: 1, stuck: 2, exhausted: 1 });
  });

  it('one message that is both deferring this run and out of attempts is ONE stuck message, not two', async () => {
    m.sql.mockResolvedValueOnce([queueRow(STUCK_AT, 'm1')]).mockResolvedValueOnce([{ message_id: 'm1' }, { message_id: 'm2' }]);
    m.accept.mockRejectedValueOnce(lockTimeout());
    expect(await runAutoAccept()).toMatchObject({ deferred: 1, exhausted: 2, stuck: 2 });
  });

  it('a refusal of ours (safeForSender) is stored as its own fixed sentence', async () => {
    m.sql.mockResolvedValueOnce([queueRow(1)]);
    m.accept.mockRejectedValueOnce(new ConnectionRefusal(409, 'Link the supplier for this connection first.', true));
    const run = await runAutoAccept();
    expect(run.failed).toBe(1);
    expect(m.failed).toHaveBeenCalledWith('co-b', 'm1', 'Link the supplier for this connection first.');
    expect(m.log.info).toHaveBeenCalledWith(expect.stringMatching(/refused/), expect.objectContaining({ reason: 'Link the supplier for this connection first.' }), 'intercompany');
  });

  it('a refusal that carries a service\'s text, and any other error, is stored as the GENERIC sentence; the detail is logged, never stored', async () => {
    m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b')]);
    m.accept.mockRejectedValueOnce(new ConnectionRefusal(400, 'Account 5000 Management fees is a header account'));
    m.accept.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "uq_supplier_invoices_supplier_number"'), { code: '23505' }));
    const run = await runAutoAccept();
    expect(run.failed).toBe(2);
    expect(m.failed.mock.calls.map((c) => c[2])).toEqual([GENERIC, GENERIC]);
    expect(JSON.stringify(m.failed.mock.calls)).not.toMatch(/Management fees|uq_supplier/);
    // the log carries the code and the class, never the message (it can hold values from rows)
    expect(JSON.stringify([m.log.warn.mock.calls, m.log.error.mock.calls, m.log.info.mock.calls])).not.toMatch(/Management fees|uq_supplier|duplicate key/);
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/failed/), expect.objectContaining({ code: '23505', error: 'Error' }), 'intercompany');
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/failed/), expect.not.objectContaining({ detail: expect.anything() }), 'intercompany');
  });

  it('one message failing never stops the rest', async () => {
    m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b')]);
    m.accept.mockRejectedValueOnce(new Error('x'));
    const run = await runAutoAccept();
    expect(run).toMatchObject({ considered: 2, accepted: 1, failed: 1 });
  });

  it('the generic sentence names nothing', () => {
    expect(GENERIC).toBe('Could not create the draft; the receiving company must review it.');
  });

  describe('the time budget (the timer\'s curl gives up at 300 s)', () => {
    /** A clock that moves `step` ms each time the worker reads it. */
    const clock = (step: number) => { let t = 0; return () => { const now = t; t += step; return now; }; };

    it('stops starting messages once the budget is spent; the rest are deferred to the next run and logged', async () => {
      m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b'), queueRow(1, 'c'), queueRow(1, 'd')]);
      // reads: start (0), before a (40 s), before b (80 s), before c (120 s): over a 100 s budget
      const run = await runAutoAccept(50, { budgetMs: 100_000, now: clock(40_000) });
      expect(m.accept.mock.calls.map((c) => c[2])).toEqual(['a', 'b']);
      expect(run).toMatchObject({ considered: 4, accepted: 2, deferred: 2 });
      expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/time budget/), expect.objectContaining({ processed: 2, remaining: 2 }), 'intercompany');
    });

    it('gives the attempt back on exactly the messages it did not start (the budget never uses one up)', async () => {
      m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b'), queueRow(1, 'c'), queueRow(1, 'd')]).mockResolvedValueOnce([{ n: 2 }]);
      await runAutoAccept(50, { budgetMs: 100_000, now: clock(40_000) });
      const release = m.sql.mock.calls.find((c) => String((c[0] as TemplateStringsArray).join('?')).includes('intercompany_auto_accept_release'));
      expect(release?.[1]).toEqual(['c', 'd']);
      expect(m.log.warn).toHaveBeenCalledWith(expect.stringMatching(/time budget/), expect.objectContaining({ released: 2 }), 'intercompany');
    });

    it('still reports the messages that used every attempt after stopping early', async () => {
      m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b')]).mockResolvedValueOnce([{ n: 2 }]).mockResolvedValueOnce([{ message_id: 'x1' }]);
      const run = await runAutoAccept(50, { budgetMs: 10, now: clock(60_000) });
      expect(m.accept).not.toHaveBeenCalled();
      expect(run).toMatchObject({ considered: 2, accepted: 0, deferred: 2, exhausted: 1, stuck: 1 });
    });

    it('a run inside the budget processes everything and logs no budget warning', async () => {
      m.sql.mockResolvedValueOnce([queueRow(1, 'a'), queueRow(1, 'b')]);
      const run = await runAutoAccept(50, { budgetMs: 100_000, now: clock(1) });
      expect(run).toMatchObject({ considered: 2, accepted: 2, deferred: 0 });
      expect(m.log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/time budget/), expect.anything(), 'intercompany');
    });

    it('the default budget is well under the 300 s the timer waits', () => {
      expect(AUTO_ACCEPT_BUDGET_MS).toBeLessThanOrEqual(240_000);
    });
  });
});
