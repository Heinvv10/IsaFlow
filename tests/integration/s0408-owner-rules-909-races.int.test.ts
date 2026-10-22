// Migration 909 races and lock order (audit S-04/S-08 follow-ups A and B).
//
// - Two concurrent removals of two co-owners leave exactly one owner, whoever
//   writes (platform_admin twice, or platform_admin against an app owner).
// - Lock order is the row first, then `company_owners:<company>`: while a
//   writer waits for the advisory lock, a third session cannot lock its row.
// - B re-reads the actor's role after the advisory lock: an owner demoted by a
//   concurrent owner write that commits first is refused (RC010).
// Waits are observed in pg_stat_activity, never slept for.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import {
  cleanup, openTx, outcome, ownerLockKey, ownersOf, roleOf, seedCompany, waitsOnLock, type Role,
} from './s0408-owner-rules.helpers';

assertDisposableDb('909 races seed companies and members.');

const id = () => crypto.randomUUID();
const DEL = 'DELETE FROM company_users WHERE company_id = $1 AND user_id = $2';
const ROUNDS = 10;

describe.skipIf(!isDisposableDb(process.env.DATABASE_URL))('909 — races and lock order', () => {
  let pool: Pool;
  const companies: string[] = [];

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 }); });
  afterAll(async () => { await cleanup(pool, companies); await pool.end(); });

  /** first removes o1 and holds; second removes o2 and must wait on the owner lock; first commits. */
  async function race(first: [Role, string | undefined], second: [Role, string | undefined]) {
    const [o1, o2] = [id(), id()];
    const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner']]);
    const t1 = await openTx(pool, first[0], c, first[1] === 'o2' ? o2 : first[1]);
    const t2 = await openTx(pool, second[0], c, second[1] === 'o1' ? o1 : second[1]);
    try {
      await t1.q(DEL, [c, o1]);
      const p2 = outcome(t2.q(DEL, [c, o2]));
      await waitsOnLock(pool, t2.pid, 'advisory');
      await t1.end(true);
      const r2 = await p2;
      await t2.end(r2 === 'ok');
      return { r2, owners: await ownersOf(pool, c) };
    } finally {
      await t1.end(false);
      await t2.end(false);
    }
  }

  it(`two platform_admin removals of two co-owners leave one owner (${ROUNDS} rounds)`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const { r2, owners } = await race(['platform_admin', undefined], ['platform_admin', undefined]);
      expect(r2).toBe('RC011');
      expect(owners).toHaveLength(1);
    }
  });

  it(`a platform_admin removal against an app owner's removal of the other owner leaves one owner (${ROUNDS} rounds)`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      // The app owner o1 removes o2 while the admin site removes o1 first.
      const { r2, owners } = await race(['platform_admin', undefined], ['app_user', 'o1']);
      expect(['RC005', 'RC010']).toContain(r2);
      expect(owners).toHaveLength(1);
    }
  });

  it.each([
    ['platform_admin', undefined],
    ['app_user', 'owner'],
  ] as const)('lock order (%s): the row is held before the owner lock is awaited', async (role, actor) => {
    const [o1, o2] = [id(), id()];
    const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner']]);
    const rowId = (await pool.query('SELECT id FROM company_users WHERE company_id = $1 AND user_id = $2', [c, o2])).rows[0].id;
    const holder = await pool.connect();
    const writer = await openTx(pool, role, c, actor ? o1 : undefined);
    const third = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerLockKey(c)]);
      const w = outcome(writer.q(DEL, [c, o2]));
      await waitsOnLock(pool, writer.pid, 'advisory');
      // The writer waits for the owner lock while already holding o2's row.
      await third.query('BEGIN');
      expect(await outcome(third.query('SELECT 1 FROM company_users WHERE id = $1 FOR UPDATE NOWAIT', [rowId]))).toBe('55P03');
      await third.query('ROLLBACK');
      await holder.query('COMMIT');
      expect(await w).toBe('ok');
      await writer.end(true);
      expect(await ownersOf(pool, c)).toEqual([o1]);
    } finally {
      await third.query('ROLLBACK').catch(() => undefined);
      third.release();
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await writer.end(false);
    }
  });

  it('B re-reads the actor after the owner lock: an owner demoted in flight cannot remove an owner (RC010)', async () => {
    const [o1, o2, o3] = [id(), id(), id()];
    const c = await seedCompany(pool, companies, [[o1, 'owner'], [o2, 'owner'], [o3, 'owner']]);
    const demoter = await openTx(pool, 'app_user', c, o1);
    const remover = await openTx(pool, 'app_user', c, o2);
    try {
      await demoter.q("UPDATE company_users SET role = 'admin' WHERE company_id = $1 AND user_id = $2", [c, o2]);
      const r = outcome(remover.q(DEL, [c, o3]));
      await waitsOnLock(pool, remover.pid, 'advisory');
      await demoter.end(true);
      expect(await r).toBe('RC010');
      await remover.end(false);
      expect([await roleOf(pool, c, o2), await roleOf(pool, c, o3)]).toEqual(['admin', 'owner']);
    } finally {
      await demoter.end(false);
      await remover.end(false);
    }
  });
});
