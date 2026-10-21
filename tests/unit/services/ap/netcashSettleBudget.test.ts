/**
 * AP-01 round 13: the settle chain after a send must end well inside SEND_WINDOW_MS (past it, a pending claim with no
 * send lock may be released). Worst case, from the exported bounds: the send, then the claim-connection attempt (its
 * whole budget plus a ROLLBACK that does not answer), then the retry's checkout and attempt (the same). Each attempt is
 * held to SETTLE_ATTEMPT_BUDGET_MS by bounded(): every statement's client timeout is what is left of it, cheap ones
 * (BEGIN, SET LOCAL, set_config, savepoints) at most CHEAP_QUERY_TIMEOUT_MS, and none is sent once it is spent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { ROLLBACK_TIMEOUT_MS } from '@/lib/rollbackFailed';
import {
  CHEAP_QUERY_TIMEOUT_MS, CLAIM_CONNECTION_TIMEOUT_MS, REQUEST_TIMEOUT_MS, SEND_WINDOW_MS, SETTLE_ATTEMPT_BUDGET_MS,
  SETTLE_QUERY_TIMEOUT_MS, SETTLE_STATEMENT_TIMEOUT_MS,
} from '@/modules/accounting/services/ap/netcashTimeouts';
import { bounded } from '@/modules/accounting/services/ap/netcashClaimSettle';

afterEach(() => { vi.useRealTimers(); });

describe('the settle budget', () => {
  it('send + both settle attempts (each with an unanswered ROLLBACK) + the retry checkout stay within 75% of SEND_WINDOW_MS', () => {
    const worst = REQUEST_TIMEOUT_MS + 2 * (SETTLE_ATTEMPT_BUDGET_MS + ROLLBACK_TIMEOUT_MS) + CLAIM_CONNECTION_TIMEOUT_MS;
    expect(Number.isFinite(worst)).toBe(true);
    expect(worst).toBeLessThanOrEqual(0.75 * SEND_WINDOW_MS);
  });

  it('the client gives up after the server would (query timeout above statement timeout), cheap statements sooner', () => {
    expect(SETTLE_QUERY_TIMEOUT_MS).toBeGreaterThan(SETTLE_STATEMENT_TIMEOUT_MS);
    expect(CHEAP_QUERY_TIMEOUT_MS).toBeLessThan(SETTLE_QUERY_TIMEOUT_MS);
    expect(CHEAP_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000); // round 14: 1 s tripped on a box at load 95+
    expect(SETTLE_ATTEMPT_BUDGET_MS).toBeGreaterThanOrEqual(SETTLE_QUERY_TIMEOUT_MS);
  });
});

describe('bounded(): every statement inside the attempt budget', () => {
  const fake = () => {
    const sent: Array<{ text: string; query_timeout?: number }> = [];
    const client = { query: vi.fn(async (cfg: { text: string; query_timeout?: number }) => { sent.push(cfg); return { rows: [], rowCount: 0 }; }) };
    return { client: client as unknown as PoolClient, sent };
  };

  it('cheap statements get the cheap bound, others the settle bound', async () => {
    const { client, sent } = fake();
    const q = bounded(client);
    for (const text of ['BEGIN', 'SET LOCAL ROLE app_user', "SELECT set_config('x', $1, true)", 'SAVEPOINT s', 'RELEASE SAVEPOINT s',
      'ROLLBACK TO SAVEPOINT s', 'UPDATE netcash_submissions SET status = $3', 'COMMIT']) await q.query(text);
    expect(sent.map((c) => c.query_timeout)).toEqual([
      CHEAP_QUERY_TIMEOUT_MS, CHEAP_QUERY_TIMEOUT_MS, CHEAP_QUERY_TIMEOUT_MS, CHEAP_QUERY_TIMEOUT_MS, CHEAP_QUERY_TIMEOUT_MS,
      CHEAP_QUERY_TIMEOUT_MS, SETTLE_QUERY_TIMEOUT_MS, SETTLE_QUERY_TIMEOUT_MS,
    ]);
  });

  it('a statement gets no more than what is left of the attempt, and none is sent once it is spent', async () => {
    vi.useFakeTimers();
    const { client, sent } = fake();
    const q = bounded(client);
    vi.advanceTimersByTime(SETTLE_ATTEMPT_BUDGET_MS - 1000);
    await q.query('UPDATE netcash_submissions SET status = $3');
    expect(sent[0]!.query_timeout).toBe(1000);
    vi.advanceTimersByTime(1000);
    await expect(q.query('COMMIT')).rejects.toThrow(/budget/i);
    expect(sent).toHaveLength(1);
  });
});
