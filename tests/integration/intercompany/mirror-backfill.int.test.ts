/**
 * Intercompany P2, messages written before the database recorded their journal and group row (migration 1019, section 6b). The backfill
 * takes the sender's journal from the sender's own document, and the group row from the payload ONLY where the database confirms it (the
 * sender's row to this receiver for that journal, both companies in its group); a reference it cannot confirm is left NULL, which the
 * definers fail closed on. The block is run here against planted legacy rows, as it is in the migration.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { withoutTrigger } from './intercompany.helpers';
import { clearMirrorRows, connect, mirrorCleanup, mirrorSetup, sentInvoice } from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => { await clearMirrorRows(pool); await connect(pool); });

const sql = readFileSync('scripts/migrations/sql/1019_intercompany_p2_mirror.sql', 'utf8');
const BACKFILL = sql.slice(sql.indexOf('DO $$\nDECLARE\n  r RECORD;'), sql.indexOf('-- ── 7. The definer registry'));
const legacy = (id: string) => withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
  'UPDATE intercompany_messages SET source_journal_entry_id = NULL, group_transaction_id = NULL WHERE id = $1', [id]));
const row = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];

describe('the backfill', () => {
  it('finds the block it is testing', () => {
    expect(BACKFILL.startsWith('DO $$')).toBe(true);
    expect(BACKFILL).toContain('intercompany_group_row_ok');
  });

  it('goes through the guard\'s own system update: a session cannot use it, and it moves nothing but the two NULL columns', async () => {
    const m = await sentInvoice(pool);
    await legacy(m.id);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('app.intercompany_system_update', 'backfill', true)");
      await expect(c.query('UPDATE intercompany_messages SET source_journal_entry_id = gen_random_uuid() WHERE id = $1', [m.id])).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE migration_admin');
      await c.query("SELECT set_config('app.intercompany_system_update', 'backfill', true)");
      await expect(c.query("UPDATE intercompany_messages SET status = 'dismissed', source_journal_entry_id = gen_random_uuid() WHERE id = $1", [m.id])).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });

  it('takes a journal only if it is provably the document\'s approval posting: a forged link (another document\'s journal) records nothing; a cleared link falls back to the row the send wrote', async () => {
    const forged = await sentInvoice(pool);
    const victim = await sentInvoice(pool);
    const cleared = await sentInvoice(pool);
    for (const m of [forged, victim, cleared]) await legacy(m.id);
    const journalOf = async (inv: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je as string;
    const victimJournal = await journalOf(victim.inv.id);
    // the forged message has no group row to fall back on (its payload names none), so only the document's link is left
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{groupTransactionId}', 'null'::jsonb) WHERE id = $1", [forged.id]));
    const clearedJournal = await journalOf(cleared.inv.id);
    // the sender points the forged invoice's (writable) link at the victim's journal, and the payload of the forged message at nothing it could use
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = $2 WHERE id = $1', [forged.inv.id, victimJournal]);
    // a cancelled invoice has no link any more: the group row (written by the send) still knows its journal
    await pool.query('UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE id = $1', [cleared.inv.id]);
    await pool.query(BACKFILL);
    expect((await row(forged.id)).source_journal_entry_id).toBeNull();
    expect((await row(victim.id)).source_journal_entry_id).toBeNull();   // two documents now claim the journal: neither is proved (fail closed)
    expect((await row(cleared.id)).source_journal_entry_id).toBe(clearedJournal);
  });

  it('records the sender\'s journal and the confirmed group row of a legacy message, and leaves a reference it cannot confirm NULL', async () => {
    const honest = await sentInvoice(pool);
    const forged = await sentInvoice(pool);
    const other = await sentInvoice(pool);
    await legacy(honest.id);
    await legacy(forged.id);
    // the legacy payload of `forged` names ANOTHER message's row (a row that is the sender's to the same receiver, but for another journal)
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      "UPDATE intercompany_messages SET payload = jsonb_set(payload, '{groupTransactionId}', to_jsonb($2::text)) WHERE id = $1", [forged.id, other.message.payload.groupTransactionId]));
    await pool.query(BACKFILL);
    const journalOf = async (inv: string) => (await pool.query('SELECT gl_journal_entry_id AS je FROM customer_invoices WHERE id = $1', [inv])).rows[0].je;
    expect(await row(honest.id)).toMatchObject({ source_journal_entry_id: await journalOf(honest.inv.id), group_transaction_id: honest.message.payload.groupTransactionId });
    expect(await row(forged.id)).toMatchObject({ source_journal_entry_id: await journalOf(forged.inv.id), group_transaction_id: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_intercompany_messages_guard' AND tgenabled = 'A'")).rows[0].n).toBe(1); // the guard never went off
  });
});
