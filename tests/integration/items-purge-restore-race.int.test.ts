/**
 * The soft-delete purge of items reads its candidates, then deletes each in its own statement. An item restored (or
 * deleted again, so inside the grace period) between those two steps must NOT be hard-deleted: the DELETE repeats the
 * eligibility test. The window is opened deterministically: straight after the candidate SELECT, a second connection
 * flips the row, the way a concurrent restore would.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

const hooks = vi.hoisted(() => ({ afterCandidates: null as null | (() => Promise<void>), fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & Record<string, unknown>;
  // Untouched (lazy) for every statement but the hooked one: only that one is awaited here.
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    const hook = hooks.afterCandidates;
    if (hook && /^\s*SELECT i\.id FROM items i/.test(text)) {
      hooks.afterCandidates = null;
      return (async () => {
        const rows = await realSql(strings, ...values);
        hooks.fired += 1;
        await hook();
        return rows;
      })();
    }
    return realSql(strings, ...values);
  }) as typeof realSql;
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import { purgeExpiredDeletes } from '../../src/modules/accounting/services/core/softDeleteService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let u: SetupUser;
const made: string[] = [];

const newDeletedItem = async (code: string): Promise<string> => {
  const id = String((await pool.query(
    `INSERT INTO items (company_id, code, description, deleted_at) VALUES ($1, $2, 'purge race', NOW() - INTERVAL '1 hour') RETURNING id`,
    [u.homeCompanyId, code])).rows[0].id);
  made.push(id);
  return id;
};

beforeAll(async () => { u = await newSetupUser(pool); }, 120000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM items WHERE id = ANY($1)', [made]);
  } finally {
    await pool.end();
  }
}, 60000);

describe('purge of soft-deleted items: the DELETE repeats the eligibility test', () => {
  it('an item restored after the candidate read survives', async () => {
    const id = await newDeletedItem('RACE-RESTORED');
    hooks.fired = 0;
    hooks.afterCandidates = () => pool.query('UPDATE items SET deleted_at = NULL WHERE id = $1', [id]).then(() => undefined);
    await purgeExpiredDeletes(u.homeCompanyId);
    expect(hooks.fired).toBe(1); // the window really opened (a renamed query cannot make this vacuous)
    expect((await pool.query('SELECT deleted_at FROM items WHERE id = $1', [id])).rows).toEqual([{ deleted_at: null }]);
  });

  it('an item deleted again after the candidate read (inside its grace period) survives', async () => {
    const id = await newDeletedItem('RACE-REDELETED');
    hooks.fired = 0;
    hooks.afterCandidates = () => pool.query('UPDATE items SET deleted_at = NOW() WHERE id = $1', [id]).then(() => undefined);
    await purgeExpiredDeletes(u.homeCompanyId);
    expect(hooks.fired).toBe(1);
    expect((await pool.query('SELECT 1 FROM items WHERE id = $1', [id])).rowCount).toBe(1);
  });

  it('an untouched candidate is still purged', async () => {
    const id = await newDeletedItem('RACE-CONTROL');
    hooks.fired = 0;
    hooks.afterCandidates = async () => undefined;
    await purgeExpiredDeletes(u.homeCompanyId);
    expect(hooks.fired).toBe(1);
    expect((await pool.query('SELECT 1 FROM items WHERE id = $1', [id])).rowCount).toBe(0);
  });
});
