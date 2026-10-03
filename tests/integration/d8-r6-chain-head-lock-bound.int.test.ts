/**
 * D8 round 6 (security review of 69e4fe48b, LOW): lockChainHead took the head's
 * row lock with no lock_timeout, so a dismiss / cancel / void waited unbounded
 * on a pooled connection while another request held that journal. It now waits
 * at most CHAIN_HEAD_LOCK_BUDGET_MS across its passes, answers the claim's
 * retryable JournalReversalLockTimeoutError, and restores the caller's
 * lock_timeout on the way out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';
import { JournalReversalLockTimeoutError } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { lockStandingChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { diff, provisional, setup, tb, teardown, type Ctx } from './d8-r4-helpers';

let c: Ctx;
type Row = Record<string, unknown>;

describe.skipIf(!process.env.DATABASE_URL)('D8 round 6: the chain-head lock wait is bounded and restored', () => {
  beforeAll(async () => {
    assertNotProductionDb('D8 round 6 lock bound');
    c = await setup('D8R6L');
  }, 120000);
  afterAll(async () => { await teardown(c); }, 120000);

  it('a dismiss whose journal another request holds refuses within the budget, retryable, booking nothing', async () => {
    const pv = await provisional(c, 115);
    const holder = await c.fx.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM gl_journal_entries WHERE id = $1 FOR UPDATE', [pv.je]);
    const t0 = await tb(c);
    const started = Date.now();
    let err: unknown = null;
    try {
      await inTx(c.fx, async () => {
        await sql`SET LOCAL statement_timeout = '15s'`; // a mutant without the bound fails here, not by hanging
        return dismissProvisionalEntry(c.fx.companyId, pv.je, c.fx.userId);
      }).catch((e: unknown) => { err = e; });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(JournalReversalLockTimeoutError);
    expect(elapsed).toBeGreaterThan(4000);
    expect(elapsed).toBeLessThan(9000);
    expect(diff(t0, await tb(c))).toMatchObject({ expense: 0, bank: 0 });
    const [bt] = (await sql`SELECT status FROM bank_transactions WHERE id = ${pv.bt}::UUID`) as Row[];
    expect(bt!.status).toBe('provisional');
  }, 30000);

  it('restores the caller\'s lock_timeout when it returns', async () => {
    const pv = await provisional(c, 50);
    const setting = await inTx(c.fx, async () => {
      await sql`SET LOCAL lock_timeout = '17s'`;
      expect(await lockStandingChainHead(c.fx.companyId, pv.je)).toBe(pv.je);
      return ((await sql`SELECT current_setting('lock_timeout') AS v`) as Row[])[0]!.v;
    });
    expect(setting).toBe('17s');
  });
});
