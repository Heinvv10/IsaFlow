/**
 * What a VAT period lock may cover, and how long taking one may wait.
 *
 * A lock records a FILED return, so it cannot end after today (nothing has been
 * filed for the future), cannot span more than twelve months (no SA VAT period
 * does), and cannot overlap another ACTIVE lock (two filed returns for one day
 * would each claim that day's figures). Re-locking the exact active period stays
 * idempotent, and an unlocked (history) row overlaps nothing. The rules live in
 * the service, so the REST route and the MCP tool refuse alike — the MCP dry run
 * too, before anything is written.
 *
 * The exclusive advisory key a lock takes waits at most lock_timeout 5s behind
 * a post, then refuses with a typed, retryable VatLockTimeoutError; the
 * caller's own lock_timeout is restored afterwards. A reversal PREVIEW takes the
 * shared key too, so a preview and the post that follows see the same locks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import {
  VatPeriodLockRefusal, VatLockTimeoutError, lockVatPeriod, unlockVatPeriod,
} from '@/modules/accounting/services/reports/vatPeriodLockService';
import { assertJournalVatPeriodOpen } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { resolveReversalDateDetailed } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { lockVatPeriodTool } from '@/lib/mcp/tools/vatReports';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
const FIG = { outputTax: 1, inputTax: 1, netVat: 0, postedThrough: '2025-01-01T00:00:00.000Z' };
const actor = () => ({ userId: fx.userId, actorType: 'human' as const });
const lock = (s: string, e: string) => inTx(fx, () => lockVatPeriod(fx.companyId, s, e, FIG, actor()));
const VAT_LINE = [{ glAccountId: '00000000-0000-4000-8000-000000000001', vatType: 'standard' }];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(VatPeriodLockRefusal);
  return (err as Error).message;
}

/** Hold a transaction on one connection while `probe` runs on another. */
async function whileHeld(hold: () => Promise<unknown>, probe: () => Promise<unknown>, probeTimeout?: string) {
  const a: PoolClient = await fx.pool.connect();
  const b: PoolClient = await fx.pool.connect();
  try {
    await a.query('BEGIN');
    await runOn(fx, a, hold);
    await b.query('BEGIN');
    if (probeTimeout) await b.query(`SET LOCAL lock_timeout = '${probeTimeout}'`);
    const started = Date.now();
    const outcome = await runOn(fx, b, probe).then(() => 'ran', (e: unknown) => e);
    return { outcome, ms: Date.now() - started };
  } finally {
    await b.query('ROLLBACK').catch(() => undefined);
    await a.query('ROLLBACK').catch(() => undefined);
    a.release();
    b.release();
  }
}

describeIfDb('VAT period lock bounds, lock timeout and preview locking', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test writes VAT period locks.');
    fx = await seedFixture('VLB', DATABASE_URL!);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses a period ending after today', async () => {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const start = new Date(); start.setDate(1);
    expect(await refusal(lock(iso(start), iso(tomorrow)))).toMatch(/after today/);
  });

  it('refuses a period longer than twelve months, and accepts exactly twelve', async () => {
    expect(await refusal(lock('2023-01-01', '2024-01-01'))).toMatch(/12 months/);
    expect((await lock('2023-01-01', '2023-12-31')).created).toBe(true);
  });

  it('refuses an overlap with an ACTIVE lock, naming it; re-locking the same period stays idempotent', async () => {
    const first = await lock('2025-03-01', '2025-04-30');
    expect(await refusal(lock('2025-04-01', '2025-05-31'))).toContain('2025-03-01 to 2025-04-30');
    expect(await refusal(lock('2025-01-01', '2025-12-31'))).toContain('2025-03-01 to 2025-04-30');
    expect(await lock('2025-03-01', '2025-04-30')).toMatchObject({ created: false, lock: { id: first.lock.id } });
    // Unlocked, it is history and overlaps nothing.
    await inTx(fx, () => unlockVatPeriod(fx.companyId, first.lock.id, fx.userId, 'amend'));
    expect((await lock('2025-04-01', '2025-05-31')).created).toBe(true);
  });

  it('the MCP dry run refuses the same periods before writing anything', async () => {
    const ctx = { companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti-b', scopes: [] } as unknown as McpToolContext;
    const r = await inTx(fx, () => lockVatPeriodTool.handler(
      { period_start: '2021-01-01', period_end: '2022-06-30', dry_run: true, idempotency_key: 'k-b1' }, ctx));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/12 months/);
  });

  it('lock waits at most ~5s behind a post, then refuses with a typed retryable error', async () => {
    const { outcome, ms } = await whileHeld(
      () => assertJournalVatPeriodOpen(fx.companyId, '2026-06-01', VAT_LINE),
      () => lockVatPeriod(fx.companyId, '2024-03-01', '2024-04-30', FIG, actor()),
    );
    expect(outcome).toBeInstanceOf(VatLockTimeoutError);
    expect(outcome).toMatchObject({ code: 'VAT_LOCK_TIMEOUT' });
    expect(ms).toBeGreaterThanOrEqual(4500);
    expect(ms).toBeLessThan(9000);
  }, 20000);

  it("restores the caller's lock_timeout after taking the exclusive key", async () => {
    const c = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '1234ms'`);
      await runOn(fx, c, () => lockVatPeriod(fx.companyId, '2024-05-01', '2024-06-30', FIG, actor()));
      expect((await c.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('1234ms');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('a reversal preview takes the shared key: it waits while a lock is being taken', async () => {
    const { outcome } = await whileHeld(
      () => lockVatPeriod(fx.companyId, '2024-07-01', '2024-08-31', FIG, actor()),
      () => resolveReversalDateDetailed(fx.companyId, '2026-06-10', undefined, VAT_LINE),
      '400ms',
    );
    expect(outcome).toMatchObject({ code: '55P03' });
  });

  // L1: create takes the shared key too. Without it, a lock could commit
  // between a draft's creation and its post, and the post's refusal (a 4xx the
  // route commits) would leave the draft behind.
  it('createJournalEntry takes the shared key: it waits while a lock is being taken', async () => {
    const expense = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'`) as Record<string, unknown>[])[0]!.id);
    const { outcome } = await whileHeld(
      () => lockVatPeriod(fx.companyId, '2024-09-01', '2024-10-31', FIG, actor()),
      () => createJournalEntry(fx.companyId, {
        entryDate: '2026-06-10', description: 'no VAT', source: 'manual',
        lines: [{ glAccountId: expense, debit: 10, credit: 0 }, { glAccountId: fx.bankAccountId, debit: 0, credit: 10 }],
      }, fx.userId),
      '400ms',
    );
    expect(outcome).toMatchObject({ code: '55P03' });
  });
});
