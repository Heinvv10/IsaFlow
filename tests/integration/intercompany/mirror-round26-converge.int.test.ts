/**
 * Intercompany P2, round 26, INFO3: the descoped manual elimination of a mirrored row (docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md)
 * left objects in 1019's earlier shapes. A database that applied one converges on the current 1019: its two functions, the discarded_by /
 * discarded_at columns, the per-row index and the (row, has-a-reason) shape of the unique index are gone / replaced, and applying it twice changes nothing more.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const MIGRATION_1019 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1019_intercompany_p2_mirror.sql'), 'utf8');
afterAll(() => pool.end());

const apply = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_1019);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
};
const exists = async (sqlText: string) => (await pool.query(sqlText)).rowCount === 1;
const fn = (name: string) => exists(`SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = '${name}'`);
const col = (name: string) => exists(`SELECT 1 FROM information_schema.columns WHERE table_name = 'consolidation_adjustments' AND column_name = '${name}'`);
const index = (name: string) => exists(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}'`);
const indexDef = async () => (await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_consolidation_adjustments_standing_source'")).rows[0]?.indexdef as string | undefined;

/** What the earlier 1019 (rounds 23-24) created, by hand. */
async function plantOldShape() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION public.intercompany_row_manually_eliminated(p_row uuid, p_start date DEFAULT NULL, p_end date DEFAULT NULL)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT false $$;
    CREATE OR REPLACE FUNCTION public.intercompany_manual_cover(p_row uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT false $$;
    ALTER TABLE consolidation_adjustments ADD COLUMN IF NOT EXISTS discarded_by UUID, ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_consolidation_adjustments_source ON consolidation_adjustments (source_intercompany_id) WHERE source_intercompany_id IS NOT NULL;
    DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source;
    CREATE UNIQUE INDEX uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id, (manual_reason IS NOT NULL))
      WHERE status IN ('draft', 'posted')`);
}

describe('INFO3: a database that applied an earlier 1019 converges on this one', () => {
  beforeAll(plantOldShape, 60000);

  it('has the old objects before (the plant is real)', async () => {
    expect(await fn('intercompany_row_manually_eliminated')).toBe(true);
    expect(await fn('intercompany_manual_cover')).toBe(true);
    expect(await col('discarded_by')).toBe(true);
    expect(await col('discarded_at')).toBe(true);
    expect(await index('idx_consolidation_adjustments_source')).toBe(true);
    expect(await indexDef()).toContain('manual_reason IS NOT NULL');
  });

  it('applying 1019 drops them and replaces the index with the one-standing-elimination-per-row shape; a second application changes nothing', async () => {
    await apply();
    for (const again of [false, true]) {
      if (again) await apply();
      expect(await fn('intercompany_row_manually_eliminated')).toBe(false);
      expect(await fn('intercompany_manual_cover')).toBe(false);
      expect(await col('discarded_by')).toBe(false);
      expect(await col('discarded_at')).toBe(false);
      expect(await index('idx_consolidation_adjustments_source')).toBe(false);
      const def = await indexDef();
      expect(def).toBeDefined();
      expect(def).not.toContain('manual_reason');
      expect(def).toMatch(/\(source_intercompany_id\)/);
      expect((await pool.query("SELECT count(*)::int AS n FROM app_definer_reviews WHERE signature IN ('intercompany_row_manually_eliminated(uuid,date,date)', 'intercompany_manual_cover(uuid)')")).rows[0].n).toBe(0);
    }
  }, 120000);
});
