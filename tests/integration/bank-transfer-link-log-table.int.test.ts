// Migration 978: the bank_transfer_link_log table itself as app_user (forced RLS, column grants, the guard trigger),
// and a link that outlives its line: a Reverse resets a linked line without touching the log, and the next pass must
// still link it, with the old row shown as changed and refused by the undo.
// Source: scripts/migrations/sql/978_bank_transfer_link_log.sql, src/modules/accounting/services/bank/bankTransferLink{Passes,Log,Undo}.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { relinkTransferCounterparts } from '@/modules/accounting/services/bank/bankTransferLinkService';
import { listTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkLog';
import { undoTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkUndo';
import { resetBankLine } from '@/modules/accounting/services/bank/bankChainLineReversal';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { addAccount, cleanup, pageLoad, seedScenario } from './helpers/k019TransferFixture';
import { asApp, codeOf, lineFields, logRowsOf, seedTenants, undoErr } from './helpers/transferLinkLogHarness';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const otherUser = crypto.randomUUID();
const USER = { id: user, email: `${user}@test.local` };

const fields = (txId: string) => lineFields(pool, txId);
const logRows = (txId: string) => logRowsOf(pool, txId);
const inRequest = <T>(fn: () => Promise<T>, companyId = company, sub = user) => asApp(companyId, sub, () => fn());

beforeAll(async () => {
  assertNotProductionDb('This suite seeds companies and writes bank_transactions and bank_transfer_link_log rows.');
  await seedTenants(pool, { company, other, user, otherUser });
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[company, other]]);
    await pool.query('DELETE FROM users WHERE id = $1', [otherUser]);
    await cleanup(pool, [company, other], user);
  } finally {
    await pool.end();
  }
});

describe('978 a link whose line was reset outside the log', () => {
  it('links the line again, shows the old row as changed and refuses to undo it, then undoes the new one', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const tx = s.imported[0];
    const first = pageLoad();
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, first))).linked).toBe(1);
    // What a Reverse (and an auto-post undo) does to the line: back to imported, the log untouched.
    await inRequest(() => resetBankLine(company, tx, false));
    expect((await fields(tx)).status).toBe('imported');

    const second = pageLoad();
    const r = await inRequest(() => relinkTransferCounterparts(company, s.targetBank, second));
    expect(r).toMatchObject({ linked: 1, failed: false });
    expect((await fields(tx)).matched_journal_line_id).toBe(s.freeLines[0]);
    const [oldRow, newRow] = await logRows(tx);
    expect([oldRow.link_batch_id, newRow.link_batch_id]).toEqual([first.linkBatchId, second.linkBatchId]);
    expect(oldRow.undone_at).toBeNull();

    const listed = await inRequest(() => listTransferLinks(company, s.targetBank));
    const stateOf = (batchId: string) => listed.find((b) => b.batchId === batchId);
    expect(stateOf(first.linkBatchId)).toMatchObject({ activeCount: 0, links: [{ state: 'changed' }] });
    expect(stateOf(second.linkBatchId)).toMatchObject({ activeCount: 1, links: [{ state: 'linked' }] });

    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: oldRow.id }, USER)))).toBe('CHANGED');
    expect(await inRequest(() => undoTransferLinks(company, { linkId: newRow.id }, USER))).toEqual({ undone: 1, refused: 0 });
    expect((await fields(tx)).status).toBe('imported');
  });

  it('counts a reconciled line as changed, not live', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const trigger = pageLoad();
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [s.imported[0]]);
    const listed = await inRequest(() => listTransferLinks(company, s.targetBank));
    expect(listed.find((b) => b.batchId === trigger.linkBatchId)).toMatchObject({ activeCount: 0, links: [{ state: 'changed' }] });
  });
});

describe('978 the table as app_user', () => {
  it('is forced-RLS with the tenant policy', async () => {
    const r = (await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT pg_get_expr(p.polqual, p.polrelid) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS qual
         FROM pg_class c WHERE c.oid = 'bank_transfer_link_log'::regclass`)).rows[0];
    expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(r.qual).toContain('app.current_company_id()');
    expect(r.qual).toContain('auth.user_companies()');
  });

  it("isolates tenants, stamps the session's actor, and allows nothing but one undo stamp", async () => {
    const s = await seedScenario(pool, company, user, 1, 2);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const linkedTx = (await pool.query(
      'SELECT bank_transaction_id AS id FROM bank_transfer_link_log WHERE bank_account_id = $1', [s.targetBank])).rows[0].id;
    const freeTx = s.imported.find((t) => t !== linkedTx)!;
    const [link] = await logRows(linkedTx);
    const insertCols = `company_id, link_batch_id, bank_transaction_id, bank_account_id, journal_entry_id, journal_line_id,
      trigger_source, prev_status, linked_row_updated_at`;
    const insertArgs = [company, crypto.randomUUID(), freeTx, s.targetBank, s.journals[0], s.freeLines[0]];
    const insertSql = `INSERT INTO bank_transfer_link_log (${insertCols}) VALUES ($1, $2, $3, $4, $5, $6, 'page_load', 'imported', now())`;

    await asApp(other, otherUser, async (c) => {
      expect((await c.query('SELECT count(*)::int n FROM bank_transfer_link_log WHERE id = $1', [link.id])).rows[0].n).toBe(0);
      expect((await c.query('UPDATE bank_transfer_link_log SET undone_at = now() WHERE id = $1', [link.id])).rowCount).toBe(0);
      expect(await codeOf(c, insertSql, insertArgs)).toMatch(/^(42501|23514|23503)$/);
    });

    await asApp(company, user, async (c) => {
      const ins = await c.query(`${insertSql} RETURNING linked_by, linked_at, undone_at`, insertArgs);
      expect(ins.rows[0]).toMatchObject({ linked_by: user, undone_at: null });
      expect(await codeOf(c, `INSERT INTO bank_transfer_link_log (${insertCols}, linked_by)
        VALUES ($1, $2, $3, $4, $5, $6, 'page_load', 'imported', now(), 'someone')`, insertArgs)).toBe('42501');
      expect(await codeOf(c, "UPDATE bank_transfer_link_log SET prev_status = 'allocated' WHERE id = $1", [link.id])).toBe('42501');
      expect(await codeOf(c, 'DELETE FROM bank_transfer_link_log WHERE id = $1', [link.id])).toBe('42501');
      expect(await codeOf(c, 'UPDATE bank_transfer_link_log SET undone_at = now() WHERE id = $1', [link.id])).toBe('ok');
      expect(await codeOf(c, 'UPDATE bank_transfer_link_log SET undone_at = now() WHERE id = $1', [link.id])).toBe('23514');
      throw new Error('rollback');
    }).catch((err: Error) => { if (err.message !== 'rollback') throw err; });
    expect((await logRows(linkedTx))[0].undone_at).toBeNull();
  });

  it("refuses a forged row naming another company's journal line, statement line, account or import batch", async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const o = await seedScenario(pool, other, otherUser, 1, 1);
    const cols = `company_id, link_batch_id, bank_transaction_id, bank_account_id, journal_entry_id, journal_line_id,
      trigger_source, prev_status, linked_row_updated_at`;
    const sqlText = `INSERT INTO bank_transfer_link_log (${cols}) VALUES ($1, $2, $3, $4, $5, $6, 'page_load', 'imported', now())`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await codeOf(client, sqlText,
        [company, crypto.randomUUID(), s.imported[0], s.targetBank, o.journals[0], o.freeLines[0]])).toBe('23514');
      // The guard trigger runs before the composite FK, so another tenant's statement line is refused as 23514.
      expect(await codeOf(client, sqlText,
        [company, crypto.randomUUID(), o.imported[0], s.targetBank, s.journals[0], s.freeLines[0]])).toBe('23514');
      // The bank account must be this company's account of the named line.
      expect(await codeOf(client, sqlText,
        [company, crypto.randomUUID(), s.imported[0], o.targetBank, s.journals[0], s.freeLines[0]])).toBe('23514');
      const mine = await addAccount(pool, company);
      expect(await codeOf(client, sqlText,
        [company, crypto.randomUUID(), s.imported[0], mine, s.journals[0], s.freeLines[0]])).toBe('23514');
      const withExtra = `INSERT INTO bank_transfer_link_log (${cols}, counterparty_account_id, import_batch_id)
        VALUES ($1, $2, $3, $4, $5, $6, 'import', 'imported', now(), $7, $8)`;
      const base = [company, crypto.randomUUID(), s.imported[0], s.targetBank, s.journals[0], s.freeLines[0]];
      expect(await codeOf(client, withExtra, [...base, o.sourceBanks[0], null])).toBe('23514');
      expect(await codeOf(client, withExtra, [...base, s.sourceBanks[0], crypto.randomUUID()])).toBe('23514');
      // The honest row passes all four checks.
      const batch = crypto.randomUUID();
      // The import batch is a line's provenance, fixed at insert: a line born in it makes it this company's.
      await client.query(
        `INSERT INTO bank_transactions(company_id,bank_account_id,import_batch_id,transaction_date,amount,description,status)
         VALUES($1,$2,$3,CURRENT_DATE,1,'Batch fixture','imported')`, [company, s.targetBank, batch]);
      expect(await codeOf(client, withExtra, [...base, s.sourceBanks[0], batch])).toBe('ok');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
