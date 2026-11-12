// Migration 978: every automatic transfer link writes a bank_transfer_link_log row with the line's previous fields,
// and an undo puts the line back exactly, only while nothing has changed it since. The passes and the undo run as
// app_user inside a request transaction with the company's GUCs, as withAuth runs them, so the column grants, the
// guard trigger and the forced RLS policy are all on the path under test.
// Source: src/modules/accounting/services/bank/bankTransferLink{Passes,Service,Log,Undo}.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getPoolForTests } from '@/lib/neon';
import {
  autoLinkImportedBatchTransfers, relinkTransferCounterparts,
} from '@/modules/accounting/services/bank/bankTransferLinkService';
import { listTransferLinks, type TransferLinkTrigger } from '@/modules/accounting/services/bank/bankTransferLinkLog';
import { TransferLinkUndoError, undoTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkUndo';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { AMOUNT, DAY, addSecondLegToJournal, cleanup, pageLoad, seedScenario } from './helpers/k019TransferFixture';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const other = crypto.randomUUID();
const user = crypto.randomUUID();
const otherUser = crypto.randomUUID();
const USER = { id: user, email: `${user}@test.local` };

type Ctx = Parameters<typeof als.run>[0];
const FIELDS = `status, allocation_type, transfer_journal_entry_id, matched_journal_line_id, counterparty_account_id,
  allocated_entity_name, allocation_rule_id, allocation_rule_name`;

/** A request transaction as withAuth opens one: app_user, the member's claims, the active company. */
async function asApp<T>(companyId: string, sub: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const ctx = { client, userId: sub, companyId, claims: { sub } } as unknown as Ctx;
    const out = await als.run(ctx, () => fn(client));
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}
const inRequest = <T>(fn: () => Promise<T>, companyId = company, sub = user) => asApp(companyId, sub, () => fn());

async function fields(txId: string) {
  return (await pool.query(`SELECT ${FIELDS} FROM bank_transactions WHERE id = $1`, [txId])).rows[0];
}
async function logRows(txId: string) {
  return (await pool.query('SELECT * FROM bank_transfer_link_log WHERE bank_transaction_id = $1 ORDER BY linked_at', [txId])).rows;
}
async function undoErr(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (err) {
    if (err instanceof TransferLinkUndoError) return err.code;
    throw err;
  }
  return 'ok';
}
/** The SQLSTATE a statement fails with, or 'ok'; in a savepoint so the session stays usable. */
async function codeOf(c: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT probe');
  try { await c.query(text, params); await c.query('RELEASE SAVEPOINT probe'); return 'ok'; } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT probe');
    return String((err as { code?: string }).code);
  }
}

beforeAll(async () => {
  assertNotProductionDb('This suite seeds companies and writes bank_transactions and bank_transfer_link_log rows.');
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'Link log fixture', other, 'Link log other tenant']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true),($3,$4,'admin',true)",
    [user, `${user}@test.local`, otherUser, `${otherUser}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",
    [company, user, other, otherUser]);
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

describe('978 link writes its log row', () => {
  it('records the batch, the journal line, the previous fields and the updated_at the link left', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const trigger = pageLoad();
    const r = await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    expect(r).toMatchObject({ linked: 1, failed: false, batchId: trigger.linkBatchId });
    const [row] = await logRows(s.imported[0]);
    expect(row).toMatchObject({
      company_id: company, link_batch_id: trigger.linkBatchId, trigger_source: 'page_load', import_batch_id: null,
      bank_account_id: s.targetBank, journal_entry_id: s.journals[0], journal_line_id: s.freeLines[0],
      counterparty_account_id: s.sourceBanks[0], prev_status: 'imported', prev_allocation_type: null,
      prev_transfer_journal_entry_id: null, prev_matched_journal_line_id: null, prev_counterparty_account_id: null,
      prev_allocated_entity_name: null, prev_allocation_rule_id: null, prev_allocation_rule_name: null,
      linked_by: user, undone_at: null,
    });
    const same = await pool.query(
      `SELECT l.linked_row_updated_at = bt.updated_at AS same FROM bank_transfer_link_log l
         JOIN bank_transactions bt ON bt.id = l.bank_transaction_id WHERE l.id = $1`, [row.id]);
    expect(same.rows[0].same).toBe(true);
    const listed = await inRequest(() => listTransferLinks(company, s.targetBank));
    expect(listed.find((b) => b.batchId === trigger.linkBatchId)?.activeCount).toBe(1);
  });

  it('records an import as the import and its batch', async () => {
    // The import batch is a line's provenance, fixed at insert: the incoming line is born in the batch.
    const s = await seedScenario(pool, company, user, 1, 0);
    const importBatch = crypto.randomUUID();
    const incoming = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,import_batch_id,transaction_date,amount,description,status)
       VALUES($1,$2,$3,$4,DATE '${DAY}',${AMOUNT},'Import fixture','imported')`,
      [incoming, company, s.targetBank, importBatch]);
    s.imported.push(incoming);
    const trigger: TransferLinkTrigger = { source: 'import', linkBatchId: crypto.randomUUID(), importBatchId: importBatch };
    // The batch pass reads 'transfer' allocations; the fixture's source legs are.
    const r = await inRequest(() => autoLinkImportedBatchTransfers(company, importBatch, trigger));
    expect(r.linked).toBe(1);
    expect((await logRows(s.imported[0]))[0]).toMatchObject({ trigger_source: 'import', import_batch_id: importBatch });
  });

  it('rolls the link back when its log row cannot be written', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const r = await inRequest(() => relinkTransferCounterparts(company, s.targetBank,
      { source: 'x' as never, linkBatchId: crypto.randomUUID() }));
    expect(r).toMatchObject({ linked: 0, failed: true, batchId: null });
    expect((await fields(s.imported[0])).status).toBe('imported');
    expect(await logRows(s.imported[0])).toHaveLength(0);
  });
});

describe('978 undo', () => {
  it('per line: restores the exact previous fields, stamps the log once and writes the audit row', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const tx = s.imported[0];
    // Non-NULL previous values, so "exactly as before" is proven on values, not only on NULLs.
    await pool.query("UPDATE bank_transactions SET allocated_entity_name = 'Prior name', allocation_rule_name = 'Prior rule' WHERE id = $1", [tx]);
    const before = await fields(tx);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    expect((await fields(tx)).status).toBe('allocated');
    const [link] = await logRows(tx);

    expect(await inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER))).toEqual({ undone: 1, refused: 0 });
    expect(await fields(tx)).toEqual(before);
    const [after] = await logRows(tx);
    expect(after.undone_at).not.toBeNull();
    expect(after.undone_by).toBe(user);
    const audit = await pool.query(
      "SELECT changes FROM audit_log WHERE company_id = $1 AND entity_type = 'bank_transaction' AND entity_id = $2", [company, tx]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes.metadata).toMatchObject({ source: 'transfer_link_undo', linkId: link.id });

    // A second undo of the same link finds nothing live.
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER)))).toBe('NOT_FOUND');
  });

  it('per batch: one undo restores every line of the batch', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    const trigger = pageLoad();
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger))).linked).toBe(2);
    expect(await inRequest(() => undoTransferLinks(company, { batchId: trigger.linkBatchId }, USER))).toEqual({ undone: 2, refused: 0 });
    for (const tx of s.imported) expect((await fields(tx)).status).toBe('imported');
  });

  it('never relinks an undone pair, but the line may still link to another free leg', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const tx = s.imported[0];
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const [link] = await logRows(tx);
    await inRequest(() => undoTransferLinks(company, { linkId: link.id }, USER));

    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()))).linked).toBe(0);
    expect((await fields(tx)).status).toBe('imported');

    // A second leg on the same journal: the veto is per pair, so the line links to that leg.
    const secondLeg = await addSecondLegToJournal(pool, company, s.journals[0], s.targetBank);
    expect((await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()))).linked).toBe(1);
    expect((await fields(tx)).matched_journal_line_id).toBe(secondLeg);
  });

  it('refuses after a later change to the line, and leaves the line and the log untouched', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    const [a] = await logRows(s.imported[0]);
    const [b] = await logRows(s.imported[1]);

    await pool.query("UPDATE bank_transactions SET notes = 'edited later' WHERE id = $1", [s.imported[0]]);
    const changedA = await fields(s.imported[0]);
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: a.id }, USER)))).toBe('CHANGED');
    expect(await fields(s.imported[0])).toEqual(changedA);
    expect((await logRows(s.imported[0]))[0].undone_at).toBeNull();

    await pool.query("UPDATE bank_transactions SET status = 'reconciled' WHERE id = $1", [s.imported[1]]);
    expect(await undoErr(inRequest(() => undoTransferLinks(company, { linkId: b.id }, USER)))).toBe('CHANGED');
    expect((await fields(s.imported[1])).status).toBe('reconciled');
  });

  it('undoes the unchanged lines of a batch and reports the changed one refused', async () => {
    const s = await seedScenario(pool, company, user, 2, 2);
    const trigger = pageLoad();
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    await pool.query("UPDATE bank_transactions SET notes = 'edited later' WHERE id = $1", [s.imported[0]]);
    expect(await inRequest(() => undoTransferLinks(company, { batchId: trigger.linkBatchId }, USER))).toEqual({ undone: 1, refused: 1 });
    expect((await fields(s.imported[0])).status).toBe('allocated');
    expect((await fields(s.imported[1])).status).toBe('imported');
  });

  it("refuses another tenant's undo and shows it nothing", async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    const trigger = pageLoad();
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, trigger));
    const [link] = await logRows(s.imported[0]);
    const OTHER = { id: otherUser };
    expect(await undoErr(inRequest(() => undoTransferLinks(other, { linkId: link.id }, OTHER), other, otherUser))).toBe('NOT_FOUND');
    expect(await undoErr(inRequest(() => undoTransferLinks(other, { batchId: trigger.linkBatchId }, OTHER), other, otherUser))).toBe('NOT_FOUND');
    expect(await inRequest(() => listTransferLinks(other, s.targetBank), other, otherUser)).toEqual([]);
    expect((await fields(s.imported[0])).status).toBe('allocated');
    expect((await logRows(s.imported[0]))[0].undone_at).toBeNull();
  });

  it('lets a statement line be deleted, taking its log rows with it', async () => {
    const s = await seedScenario(pool, company, user, 1, 1);
    await inRequest(() => relinkTransferCounterparts(company, s.targetBank, pageLoad()));
    expect(await logRows(s.imported[0])).toHaveLength(1);
    await pool.query('DELETE FROM bank_transactions WHERE id = $1', [s.imported[0]]);
    expect(await logRows(s.imported[0])).toHaveLength(0);
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

  it("refuses a forged row naming another company's journal line or statement line", async () => {
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
      expect(await codeOf(client, sqlText,
        [company, crypto.randomUUID(), o.imported[0], s.targetBank, s.journals[0], s.freeLines[0]])).toBe('23503');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
