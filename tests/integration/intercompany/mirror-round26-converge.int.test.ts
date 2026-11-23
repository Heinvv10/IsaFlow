/**
 * Intercompany P2, round 26, INFO3 + round 27, L1: the descoped manual elimination of a mirrored row (docs/plans/2026-11-22-intercompany-manual-elimination-of-mirrored-rows.md)
 * left objects in 1019's earlier shapes. A database that applied one converges on the current 1019: its two functions, the discarded_by /
 * discarded_at columns, the per-row index and the (row, has-a-reason) shape of the unique index are gone / replaced, and applying it twice changes nothing more.
 * Round 27 (L1), as REVISED in round 28: the same holds for a database that USED that feature (duplicate standing eliminations: the old (row, has-a-reason)
 * index is KEPT, because it still refuses a third and a fourth standing row; the strict index stays absent and the NOTICE names the rows and says the old
 * index is kept; once the duplicates are cleaned and 1019 is re-applied the strict index replaces it) and for a message an older backfill bound to a P1
 * manual row by matching NULL to NULL (it is unbound).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { withoutTrigger } from './intercompany.helpers';
import { clearMirrorRows, co, connect, mirrorCleanup, mirrorSetup, sentInvoice } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const MIGRATION_1019 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1019_intercompany_p2_mirror.sql'), 'utf8');
// 1025 redefines two functions 1019 defines (the messages guard, the message-document check): replayed after it, so the committed replay leaves the newest bodies
const MIGRATION_1025 = readFileSync(resolve(__dirname, '../../../scripts/migrations/sql/1025_intercompany_p4b_allocation_sender.sql'), 'utf8');
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);

const apply = async (notices: string[] = []) => {
  const client = await pool.connect();
  client.on('notice', (n) => notices.push(n.message));
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_1019);
    await client.query(MIGRATION_1025);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.removeAllListeners('notice'); client.release(); }
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

/** The old unique index (one per row AND per has-a-reason) and the plain index the descoped feature made, planted by hand. */
const plantOldIndex = () => pool.query(`
  DROP INDEX IF EXISTS uq_consolidation_adjustments_standing_source;
  CREATE UNIQUE INDEX uq_consolidation_adjustments_standing_source ON consolidation_adjustments (source_intercompany_id, (manual_reason IS NOT NULL))
    WHERE status IN ('draft', 'posted')`);
const manualRow = async () => (await pool.query(
  `INSERT INTO intercompany_transactions (group_id, source_company_id, target_company_id, transaction_type, amount, transaction_date, description, source_journal_entry_id)
   VALUES ($1, $2, $3, 'sale', 1000, '2026-12-05', 'manual P1 sale', NULL) RETURNING id`, [co.G, co.A, co.B])).rows[0].id as string;
const adjust = (row: string, reason: string | null) => pool.query(
  `INSERT INTO consolidation_adjustments(group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id, manual_reason)
   VALUES ($1, 'interco_revenue', 'dup', '2026-12-01', '2026-12-31', '[]'::jsonb, $2, $3) RETURNING id`, [co.G, row, reason]);

describe('L1: a database that USED the descoped feature converges too', () => {
  beforeEach(async () => { await pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]); await clearMirrorRows(pool); await connect(pool); });
  afterAll(() => pool.query('DELETE FROM consolidation_adjustments WHERE group_id = $1', [co.G]));

  it('duplicates of the old shape: the old index is KEPT (it still stops a third), the strict index stays absent, and the NOTICE names the rows; once cleaned a re-run builds the strict one', async () => {
    await plantOldIndex();
    const row = await manualRow();
    await adjust(row, null);
    await adjust(row, 'a manual elimination of a mirrored row');   // (allowed by the old shape: one per row AND has-a-reason)
    expect(await indexDef()).toContain('manual_reason IS NOT NULL');
    const notices: string[] = [];
    await apply(notices);
    expect(await indexDef(), 'the old index stays: dropping it would leave the row with no unique guard at all').toContain('manual_reason IS NOT NULL');
    await expect(adjust(row, 'a third standing elimination'), 'a third standing row is still refused').rejects.toMatchObject({ code: '23505' });
    await expect(adjust(row, null), 'and so is a fourth').rejects.toMatchObject({ code: '23505' });
    const notice = notices.find((n) => n.includes('uq_consolidation_adjustments_standing_source NOT created'));
    expect(notice).toContain('1 intercompany row(s) have more than one standing elimination');
    expect(notice).toContain(row);
    expect(notice).toContain('the old (row, has-a-reason) index is kept');
    // the same again: nothing changes
    const again: string[] = [];
    await apply(again);
    expect(await indexDef()).toContain('manual_reason IS NOT NULL');
    expect(again.join(' ')).toContain(row);
    // cleaned by hand: the next application replaces it with the strict one
    await pool.query("DELETE FROM consolidation_adjustments WHERE source_intercompany_id = $1 AND manual_reason IS NOT NULL", [row]);
    await apply();
    expect(await indexDef()).toMatch(/\(source_intercompany_id\)/);
    expect(await indexDef()).not.toContain('manual_reason');
    await expect(adjust(row, null), 'the strict index refuses a second standing elimination').rejects.toMatchObject({ code: '23505' });
  }, 120000);

  it('a message an older backfill bound to a P1 manual row (NULL matched to NULL) is unbound; a properly bound message keeps its row', async () => {
    const manual = await manualRow();
    const planted = await sentInvoice(pool);
    const good = await sentInvoice(pool);
    const goodRow = (await pool.query('SELECT group_transaction_id AS g FROM intercompany_messages WHERE id = $1', [good.id])).rows[0].g as string;
    // the older backfill's result: no provable journal, and the manual row (whose own journal is NULL too) bound
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET source_journal_entry_id = NULL, group_transaction_id = $2::uuid, payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text)) WHERE id = $1", [planted.id, manual]));
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE id = $1', [planted.inv.id]);
    expect((await pool.query('SELECT public.intercompany_is_mirrored_row($1) AS m', [manual])).rows[0].m, 'the plant is real: the manual row reads as mirrored').toBe(true);
    for (const again of [false, true]) {
      await apply();
      const bound = async (id: string) => (await pool.query('SELECT group_transaction_id AS g FROM intercompany_messages WHERE id = $1', [id])).rows[0].g as string | null;
      expect(await bound(planted.id), again ? 'a second application changes nothing' : 'unbound').toBeNull();
      expect(await bound(good.id)).toBe(goodRow);
      expect((await pool.query('SELECT public.intercompany_is_mirrored_row($1) AS m', [manual])).rows[0].m).toBe(false);
    }
  }, 120000);

  it('a message an older backfill bound to a P1 row, whose invoice was posted LATER: the journal is proved and the message is still unbound from the manual row (round 28, L1)', async () => {
    const manual = await manualRow();
    const planted = await sentInvoice(pool);
    const journal = (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [planted.inv.id])).rows[0].je as string;
    // the older backfill's result: the journal not provable THEN (NULL), the manual row bound by matching NULL to NULL; the invoice is posted since
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET source_journal_entry_id = NULL, group_transaction_id = $2::uuid, payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text)) WHERE id = $1", [planted.id, manual]));
    expect((await pool.query("SELECT public.intercompany_own_posting_problem('invoice', $1, $2, $3) AS p", [planted.inv.id, co.A, journal])).rows[0].p, 'the plant is real: the posting proves').toBeNull();
    expect((await pool.query('SELECT public.intercompany_is_mirrored_row($1) AS m', [manual])).rows[0].m, 'the manual row reads as mirrored').toBe(true);
    for (const again of [false, true]) {
      await apply();
      const m = (await pool.query('SELECT source_journal_entry_id AS je, group_transaction_id AS g FROM intercompany_messages WHERE id = $1', [planted.id])).rows[0];
      expect(m.je, again ? 'second application: unchanged' : 'the journal is proved').toBe(journal);
      expect(m.g, 'and the manual row is not bound').toBeNull();
      expect((await pool.query('SELECT public.intercompany_is_mirrored_row($1) AS m', [manual])).rows[0].m, 'the posted elimination of the manual row is visible again').toBe(false);
    }
  }, 120000);
});
