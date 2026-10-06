/**
 * NUMRACE round 3: brk-numrace's round-2 attacks on 4858dbcd6 (agents/brk-numrace/brk-r2-attacks), kept as
 * regression tests for ordered lazy — a single-year element takes no key before its own rows, so neither shape can
 * cycle. Same file runs on daf057eaf. As brk wrote them (round 2's rows-then-keys claimed only the FIRST row lock):
 *   B2: a row a peer holds past the claim's 5 s bound is left unclaimed, the keys are taken, and the run's own
 *       per-row lock then waits on it again — keys before that row.
 *   H:  a customer-refund line locks the CUSTOMER (lockContactForRefund) before its journal; the run's keys are
 *       already held by then, so a single refund for the same customer (contact, then its number) cycles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { bulkAllocateBankTransactionsTool } from '@/lib/mcp/tools/writeBankBulkAllocate';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { settle, waitBlockedBy } from './helpers/numraceGate';
import {
  bulkAllocate, deadlocks, dropCrossYear, line, seedCrossYear, toolCtx, txn, type CrossYear,
} from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const made: CrossYear[] = [];
const out = (tag: string, v: unknown) => process.stdout.write(`${tag} ${JSON.stringify(v)}\n`);

async function fixture(prefix: string): Promise<CrossYear> {
  const c = await seedCrossYear(prefix, DATABASE_URL!);
  made.push(c);
  return c;
}

/** P holds `lockSql`'s row, signals, waits for go, then runs `then` (which numbers a 2025 journal). */
async function peerHolding(c: CrossYear, lockSql: () => Promise<unknown>, then: () => Promise<unknown>) {
  const p = await txn(c);
  let go!: () => void, locked!: () => void;
  const goP = new Promise<void>((res) => { go = res; });
  const lockedP = new Promise<void>((res) => { locked = res; });
  const done = settle(p.run(async () => { await lockSql(); locked(); await goP; return then(); }));
  await lockedP;
  return { p, go, done };
}

describeIfDb('NUMRACE r3: brk round-2 attacks B2 and H', () => {
  beforeAll(() => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
  });
  afterAll(async () => {
    for (const c of made) { await dropCrossYear(c).catch(() => undefined); await dropFixture(c.fx).catch(() => undefined); }
  }, 60000);

  it('B2: bulk allocate [L1 2025, L2 2026] vs a single allocation holding L1 for 6.5 s: no deadlock', async () => {
    const c = await fixture('BRK-B2');
    const l1 = await line(c, '11111111', '2025-12-20', 'NRB one');
    const l2 = await line(c, '22222222', '2026-01-05', 'NRB two');
    const before = await deadlocks(c);
    const { p, go, done } = await peerHolding(c,
      () => sql`SELECT id FROM bank_transactions WHERE id = ${l1}::UUID FOR UPDATE`,
      () => allocateTransaction(c.fx.companyId, l1, c.expense, c.fx.userId, undefined, 'account', undefined, undefined));
    const r = await txn(c);
    try {
      const pR = settle(r.run(() => bulkAllocate(c, [{ id: l1 }, { id: l2 }])));
      await waitBlockedBy(c.fx.pool, p.pid);
      await new Promise((res) => setTimeout(res, 6500));
      go();
      const [rp, rr] = [await done, await pR];
      await new Promise((res) => setTimeout(res, 1500));
      const after = await deadlocks(c);
      out('B2', { rp: rp.ok ? 'ok' : rp, rr: rr.ok ? (rr.value as { content: { text: string }[] }).content[0]!.text : rr,
        deadlocks: { before, after } });
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      go();
      await p.abandon();
      await r.abandon();
    }
  }, 90000);

  it('H: bulk allocate [customer refund 2025, account 2026] vs a single refund for the same customer: no deadlock', async () => {
    const c = await fixture('BRK-H');
    // R 500 on account: an inflow allocated to the customer with no invoice open.
    const credit = await line(c, '99999999', '2025-06-01', 'NRH credit');
    await sql`UPDATE bank_transactions SET amount = 500 WHERE id = ${credit}::UUID`;
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, credit, c.expense, c.fx.userId, undefined, 'customer',
      c.fx.customerId, undefined));
    const lr = await line(c, '11111111', '2025-12-20', 'NRH refund bulk');
    const l2 = await line(c, '22222222', '2026-01-05', 'NRH two');
    const lp = await line(c, '55555555', '2025-12-10', 'NRH refund single');
    const before = await deadlocks(c);
    const { p, go, done } = await peerHolding(c,
      () => sql`SELECT id FROM customers WHERE id = ${c.fx.customerId}::UUID FOR UPDATE`,
      () => allocateTransaction(c.fx.companyId, lp, c.expense, c.fx.userId, undefined, 'customer', c.fx.customerId,
        undefined));
    const r = await txn(c);
    try {
      const pR = settle(r.run(() => bulkAllocateBankTransactionsTool.handler({
        allocations: [
          { transaction_id: lr, alloc_type: 'customer', entity_id: c.fx.customerId },
          { transaction_id: l2, contra_account_id: c.expense },
        ],
        idempotency_key: `brk-h-${crypto.randomUUID()}`,
      }, toolCtx(c))));
      await waitBlockedBy(c.fx.pool, p.pid);
      go();
      const [rp, rr] = [await done, await pR];
      await new Promise((res) => setTimeout(res, 1500));
      const after = await deadlocks(c);
      out('H', { rp: rp.ok ? 'ok' : rp, rr: rr.ok ? (rr.value as { content: { text: string }[] }).content[0]!.text : rr,
        deadlocks: { before, after } });
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      go();
      await p.abandon();
      await r.abandon();
    }
  }, 90000);
});
