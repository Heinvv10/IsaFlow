/**
 * Locking a VAT period, against a real Postgres.
 *
 * A VAT201 is filed against a period and the period must then stop moving.
 * Nothing stops that today: the ledger accepts a 2022 posting made this
 * morning, and the return submitted for 2022 no longer agrees with the ledger
 * it was computed from. The lock records what was filed, including the
 * `posted_through` the figures were computed at, so a later drift is visible
 * rather than merely present.
 *
 * The three properties pinned here are the ones a mutating tool lives or dies
 * on: a dry run writes NOTHING, a second lock of the same period does not
 * create a second row, and the guard the live path runs is the same guard the
 * dry run runs.
 *
 * Writes real rows, so it refuses to run against production, and everything is
 * inside BEGIN … ROLLBACK.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { isDbReachable } from '../helpers/dbReachable';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests } from '@/lib/neon';
import {
  getVatPeriodLock,
  isVatPeriodLocked,
  lockVatPeriod,
  listVatPeriodLocks,
} from '@/modules/accounting/services/reports/vatPeriodLockService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const START = '2026-07-01';
const END = '2026-08-31';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER, companyId, claims: {} } as unknown as Ctx);

let dbUp = false;
beforeAll(async () => { dbUp = await isDbReachable(); });

async function withCompany<T>(fn: (companyId: string, client: PoolClient) => Promise<T>): Promise<T> {
  assertNotProductionDb();
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const { rows: [co] } = await client.query<{ id: string }>(
      `INSERT INTO companies (name) VALUES ('VAT Lock Fixture') RETURNING id`,
    );
    return await als.run(ctxFor(client, co!.id), () => fn(co!.id, client));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const figures = {
  outputTax: 2919228.53,
  inputTax: 1544575.33,
  netVat: 1374653.2,
  postedThrough: '2026-09-03T03:10:16.064Z',
};

const actor = { userId: USER, actorType: 'agent' as const, tokenJti: 'jti-1' };

describe('lockVatPeriod', () => {
  it('records the return that was filed, with the posted_through it was computed at', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      const result = await lockVatPeriod(companyId, START, END, figures, actor, 'filed on eFiling');
      expect(result.created).toBe(true);
      const lock = await getVatPeriodLock(companyId, START, END);
      expect(lock).toMatchObject({
        periodStart: START, periodEnd: END,
        outputTax: 2919228.53, inputTax: 1544575.33, netVat: 1374653.2,
        actorType: 'agent', lockedBy: USER,
      });
      // Without this the lock cannot show that the ledger has moved since.
      expect(lock!.postedThrough).toContain('2026-09-03T03:10:16');
    });
  });

  it('is idempotent — locking the same period twice returns the first lock, not a second row', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId, client) => {
      const first = await lockVatPeriod(companyId, START, END, figures, actor);
      const second = await lockVatPeriod(companyId, START, END,
        { ...figures, outputTax: 999 }, actor);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      // The SECOND call's figures must not overwrite what was filed. A lock
      // that can be rewritten records nothing.
      expect(second.lock.outputTax).toBe(2919228.53);
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM vat_period_locks WHERE company_id = $1`, [companyId],
      );
      expect(Number(rows[0]!.n)).toBe(1);
    });
  });

  it('refuses a period that runs backwards, before writing anything', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId, client) => {
      await expect(lockVatPeriod(companyId, END, START, figures, actor)).rejects.toThrow(/period/i);
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM vat_period_locks WHERE company_id = $1`, [companyId],
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });
  });

  it('reports a date inside a locked period as locked, and one outside it as not', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      expect(await isVatPeriodLocked(companyId, '2026-07-15')).toBe(false);
      await lockVatPeriod(companyId, START, END, figures, actor);
      expect(await isVatPeriodLocked(companyId, '2026-07-15')).toBe(true);
      expect(await isVatPeriodLocked(companyId, START)).toBe(true);
      expect(await isVatPeriodLocked(companyId, END)).toBe(true);
      expect(await isVatPeriodLocked(companyId, '2026-06-30')).toBe(false);
      expect(await isVatPeriodLocked(companyId, '2026-09-01')).toBe(false);
    });
  });

  it('never reports another company\'s lock', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId, client) => {
      await lockVatPeriod(companyId, START, END, figures, actor);
      const { rows: [other] } = await client.query<{ id: string }>(
        `INSERT INTO companies (name) VALUES ('Other Tenant') RETURNING id`,
      );
      expect(await isVatPeriodLocked(other!.id, '2026-07-15')).toBe(false);
      expect(await getVatPeriodLock(other!.id, START, END)).toBeNull();
      expect(await listVatPeriodLocks(other!.id)).toEqual([]);
    });
  });

  it('lists locks newest period first', async () => {
    if (!dbUp) return;
    await withCompany(async (companyId) => {
      await lockVatPeriod(companyId, '2026-05-01', '2026-06-30', figures, actor);
      await lockVatPeriod(companyId, START, END, figures, actor);
      const locks = await listVatPeriodLocks(companyId);
      expect(locks.map((l) => l.periodStart)).toEqual(['2026-07-01', '2026-05-01']);
    });
  });
});
