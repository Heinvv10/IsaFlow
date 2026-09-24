/**
 * The one-active-lock-per-period index must end up right whatever order
 * migrations 570 / 695 / 696 get (re-)run in.
 *
 * 570 is not recorded in schema_migrations on every database (isaflow_dev
 * lacks it), so `db:migrate` can re-run it after 695/696. Its CREATE UNIQUE
 * INDEX IF NOT EXISTS recreates the FULL index under uq_vat_period_locks_company_period
 * when no index of that name exists — and a period can then never be re-locked
 * after an unlock (seen on isaflow_dev, 2026-09-24). 696 gave the partial index
 * 570's name; 697 makes that end state self-healing: it drops an index of that
 * name ONLY if it is the full (predicate-less) one, recreates the partial one,
 * and drops 695's duplicate `_active` name.
 *
 * Each case replays the real migration files, in the order named, inside one
 * transaction that is ROLLED BACK — the shared schema is never left changed.
 *
 * The expected end state is exactly one unique index on the natural key: the
 * partial one, named uq_vat_period_locks_company_period. ANY other unique
 * index on the table counts against it, whatever its name: a full unique index
 * beside the partial one is also picked as an ON CONFLICT arbiter, and then a
 * period can never be re-locked after an unlock. isaflow_dev carries such an
 * index (uq_vat_period_locks_master_compat, added by hand so master's code keeps
 * working for other sessions until this branch merges), so these cases are RED
 * there until it is dropped after the merge — by design.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { getPoolForTests } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const FILES: Record<string, string> = {
  570: '570_vat_period_locks.sql',
  695: '695_vat_period_lock_unlock_history.sql',
  696: '696_vat_period_lock_index_survives_570_rerun.sql',
  697: '697_vat_period_lock_index_self_heal.sql',
};
const text = (n: string) => readFileSync(join(process.cwd(), 'scripts/migrations/sql', FILES[n]!), 'utf8');

/** Replays `order` inside a rolled-back transaction; returns the natural-key unique indexes. */
async function replay(order: string[]): Promise<{ name: string; partial: boolean }[]> {
  const c: PoolClient = await getPoolForTests().connect();
  try {
    await c.query('BEGIN');
    // Simple-protocol query (no parameters): each file is several statements.
    for (const n of order) await c.query(text(n));
    const r = await c.query(`
      SELECT ic.relname AS name, i.indpred IS NOT NULL AS partial
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = 'vat_period_locks'::regclass AND i.indisunique AND NOT i.indisprimary
      ORDER BY 1`);
    return r.rows as { name: string; partial: boolean }[];
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const GOOD = [{ name: 'uq_vat_period_locks_company_period', partial: true }];

describeIfDb('vat_period_locks unique index survives any re-run order of 570 / 695 / 696', () => {
  beforeAll(() => assertNotProductionDb('This test replays migrations inside a rolled-back transaction.'));

  it('570 re-run after the fix is a no-op', async () => {
    expect(await replay(['697', '570'])).toEqual(GOOD);
  });

  it('695 then 570 then 696 then 697', async () => {
    expect(await replay(['695', '570', '696', '697'])).toEqual(GOOD);
  });

  it('a 695 re-run AFTER 696 (it drops the partial by name) followed by 570 is healed by 697', async () => {
    expect(await replay(['696', '695', '570', '697'])).toEqual(GOOD);
  });

  it('697 alone after 695 and a 570 re-run (the state isaflow_dev was in) heals it', async () => {
    expect(await replay(['695', '570', '697'])).toEqual(GOOD);
  });

  it('697 twice is harmless', async () => {
    expect(await replay(['697', '697'])).toEqual(GOOD);
  });

  // The guard drops an index of 570's name ONLY when it is the FULL one: on
  // the target state 697 must leave the partial index itself untouched (same
  // OID), not drop and rebuild it under a table lock.
  it('697 never drops the partial index (same index OID before and after)', async () => {
    const c: PoolClient = await getPoolForTests().connect();
    const oid = async () => (await c.query(
      `SELECT 'uq_vat_period_locks_company_period'::regclass::oid AS o`)).rows[0].o as number;
    try {
      await c.query('BEGIN');
      await c.query(text('697'));
      const before = await oid();
      await c.query(text('697'));
      expect(await oid()).toBe(before);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
