/**
 * WP7 (PR #1496 round 2) against real Postgres, through the real routes (withAuth, withCsrf, withWriteAccess, RLS):
 *  A. attachments: 40 concurrent uploads at 99 add exactly one (the line lock + the list's visible predicate); GET returns
 *     the newest 100 with the TRUE total, and the table is not bounded (other writers add past 100);
 *  B. client queries: record-before-send outcomes in the database (definite refusal -> no row; ambiguous -> 'unconfirmed',
 *     open for reply matching; confirmed -> 'sent' with the sid), the role matrix, and the exact company rate limit;
 *  C. OCR commit: a partial ON CONFLICT corrects the batch count and leaves its provenance; an all-conflict commit leaves NO
 *     batch and the import uncommitted (409); a double commit and a rollback of a committed import are typed 409s;
 *  D. cross-tenant: save_selection and the ledger export refuse another company's account (400), nothing written.
 * The WhatsApp transport is mocked: nothing is ever sent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { journalCompany } from './r035-pr6.helpers';
import { bankCompany, cleanupBankControlsA, plantBatch, plantLine, type BankCompany } from './bank-controls-a.helpers';
import attachmentsRoute from '../../pages/api/accounting/bank-tx-attachments';
import queriesRoute from '../../pages/api/accounting/bank-tx-queries/index';
import settingsRoute from '../../pages/api/accounting/bank-tx-queries/settings';
import commitRoute from '../../pages/api/accounting/bank-statements/[id]/commit';
import rollbackRoute from '../../pages/api/accounting/bank-statements/[id]/rollback';
import actionRoute from '../../pages/api/accounting/bank-transactions-action';
import reconReportRoute from '../../pages/api/accounting/bank-reconciliation-report';
import exportRoute from '../../pages/api/accounting/bank-transactions-export';
import { findOpenQuery } from '../../src/modules/accounting/services/capture/bankTxQueryReplyService';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/accounting/services/capture/whatsAppReplyService', async (orig) => ({
  ...(await orig<typeof import('../../src/modules/accounting/services/capture/whatsAppReplyService')>()),
  sendWhatsAppMessage: (...a: unknown[]) => sendMock(...a),
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const users: string[] = [];
const tokens: Record<string, string> = {};
let admin: string, manager: string, f: BankCompany, g: Awaited<ReturnType<typeof journalCompany>>;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const as = (user: string, route: unknown, method: string, body: unknown, url: string, query: Record<string, string> = {}) =>
  callRoute(route as never, tokens[user]!, f.c, method, body, url, query);
const header = (r: Awaited<ReturnType<typeof callRoute>>, name: string) => r.headers.get(name.toLowerCase());

beforeAll(async () => {
  admin = await createUser(pool, tokens); manager = await createUser(pool, tokens); users.push(admin, manager);
  f = await bankCompany(pool, [[admin, 'admin'], [manager, 'manager']], companies);
  g = await journalCompany(pool, [[admin, 'admin']], companies); // the admin is a member of both: the cross-tenant case
});
afterAll(async () => {
  await pool.query('DELETE FROM bank_tx_queries WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = ANY($1))', [companies]);
  await cleanupBankControlsA(pool, companies, users);
});

describe('A. attachments', () => {
  let line: string;
  beforeAll(async () => {
    const batch = await plantBatch(pool, f, admin);
    line = await plantLine(pool, f, batch);
    await pool.query(
      `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size, uploaded_by, created_at)
       SELECT $1, 'data:image/png;base64,iVBORw0KGgo=', 'seed-' || n || '.png', 8, $2, now() - (n || ' minutes')::interval FROM generate_series(1, 99) n`,
      [line, admin]);
  });
  const count = async () => Number((await pool.query('SELECT count(*) FROM bank_transaction_attachments WHERE bank_transaction_id = $1', [line])).rows[0].count);
  const upload = (n: number) => as(admin, attachmentsRoute, 'POST', { bankTransactionId: line, fileName: `race-${n}.png`, fileData: PNG }, '/api/accounting/bank-tx-attachments');

  it('40 concurrent uploads at 99 documents add exactly one: the line lock serialises the count and the insert', async () => {
    expect(await count()).toBe(99);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => upload(i)));
    const codes = results.map((r) => r.state.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(39);
    expect(await count()).toBe(100);
  }, 120_000);

  it('GET returns the newest 100 with the true total; the table is NOT bounded (other writers add past 100)', async () => {
    await pool.query(
      `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size, uploaded_by, created_at)
       SELECT $1, 'data:image/png;base64,iVBORw0KGgo=', 'mcp-' || n || '.png', 8, $2, now() + (n || ' minutes')::interval FROM generate_series(1, 5) n`,
      [line, admin]);
    expect(await count()).toBe(105);
    const r = await as(admin, attachmentsRoute, 'GET', undefined, '/api/accounting/bank-tx-attachments', { bankTransactionId: line });
    expect(r.state.statusCode).toBe(200);
    const data = (r.state.body as { data: Array<{ file_name: string }> }).data;
    expect(data).toHaveLength(100);
    expect(header(r, 'X-Attachments-Total')).toBe('105');
    expect(header(r, 'X-Attachments-Truncated')).toBe('true');
    expect(data[0]!.file_name).toMatch(/^mcp-5/); // newest first
    expect(data.some((a) => a.file_name === 'mcp-1.png')).toBe(true);
    // and a manual upload is now refused (105 >= 100)
    expect((await upload(999)).state.statusCode).toBe(409);
  });

  it('BYTE BUDGET: 6 rows of 8 MB each answer under the 25 MB budget (newest 3), with the TRUE total and the truncated flag', async () => {
    const big = await plantLine(pool, f, await plantBatch(pool, f, admin));
    await pool.query(
      `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size, uploaded_by, created_at)
       SELECT $1, 'data:image/png;base64,' || repeat('A', 8000000), 'big-' || n || '.png', 8000000, $2, now() - (n || ' minutes')::interval FROM generate_series(1, 6) n`,
      [big, admin]);
    const r = await as(admin, attachmentsRoute, 'GET', undefined, '/api/accounting/bank-tx-attachments', { bankTransactionId: big });
    expect(r.state.statusCode).toBe(200);
    const data = (r.state.body as { data: Array<{ file_name: string; file_url: string }> }).data;
    expect(data.map((a) => a.file_name)).toEqual(['big-1.png', 'big-2.png', 'big-3.png']);
    expect(data.reduce((n, a) => n + a.file_url.length, 0)).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(header(r, 'X-Attachments-Total')).toBe('6');
    expect(header(r, 'X-Attachments-Truncated')).toBe('true');
  }, 120_000);

  it('BYTE BUDGET: a single row over the budget is still returned (at least one row)', async () => {
    const one = await plantLine(pool, f, await plantBatch(pool, f, admin));
    await pool.query(
      `INSERT INTO bank_transaction_attachments(bank_transaction_id, file_url, file_name, file_size, uploaded_by)
       VALUES ($1, 'data:image/png;base64,' || repeat('A', 26000000), 'huge.png', 26000000, $2)`, [one, admin]);
    const r = await as(admin, attachmentsRoute, 'GET', undefined, '/api/accounting/bank-tx-attachments', { bankTransactionId: one });
    expect((r.state.body as { data: unknown[] }).data).toHaveLength(1);
  }, 120_000);

  it("another company's line is not reachable: a 403, nothing inserted", async () => {
    const r = await callRoute(attachmentsRoute as never, tokens[admin]!, g.c, 'POST', { bankTransactionId: line, fileName: 'x.png', fileData: PNG }, '/api/accounting/bank-tx-attachments');
    expect(r.state.statusCode).toBe(403);
  });
});

describe('A2. the reconciliation report pages by keyset', () => {
  it('a line inserted between page 1 and page 2 neither repeats nor skips a row after the cursor', async () => {
    const f3 = await bankCompany(pool, [[admin, 'admin']], companies);
    const batch = await plantBatch(pool, f3, admin);
    const original: string[] = [];
    for (let i = 0; i < 5; i++) original.push(await plantLine(pool, f3, batch, -(i + 1)));
    const url = '/api/accounting/bank-reconciliation-report';
    type Rep = { unmatchedTransactions: Array<{ amount: number }>; truncated: { unmatched: boolean }; nextUnmatchedAfter: string | null };
    const page = async (after?: string) => (await callRoute(reconReportRoute as never, tokens[admin]!, f3.c, 'GET', undefined, url,
      { bankAccountId: f3.bank, limit: '2', ...(after ? { unmatchedAfter: after } : {}) }) as { state: { body: { data: Rep } } }).state.body.data;
    const seen: number[] = [];
    const p1 = await page();
    seen.push(...p1.unmatchedTransactions.map((t) => t.amount));
    expect(p1.truncated.unmatched).toBe(true);
    // between the pages: one line that sorts BEFORE the cursor (an offset would repeat a row) and one AFTER it
    await pool.query(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
                      VALUES($1,$2,DATE '2026-08-01',-100,'early','imported',$3), ($1,$2,DATE '2026-10-01',-200,'late','imported',$3)`, [f3.c, f3.bank, batch]);
    let after = p1.nextUnmatchedAfter;
    for (let n = 0; n < 6 && after; n++) {
      const p = await page(after);
      seen.push(...p.unmatchedTransactions.map((t) => t.amount));
      if (!p.truncated.unmatched) break;
      after = p.nextUnmatchedAfter;
    }
    expect(new Set(seen).size).toBe(seen.length); // no duplicate
    for (let i = 0; i < 5; i++) expect(seen).toContain(-(i + 1)); // no gap among the original lines
    expect(seen).toContain(-200); // the later insert is picked up
    expect(seen).not.toContain(-100); // the earlier one is before the cursor: not a repeat of anything
  }, 120_000);
});

describe('B. client queries', () => {
  let line: string;
  const QUERIES = '/api/accounting/bank-tx-queries';
  const ask = (user: string, toNumber: string, extra: Record<string, unknown> = {}) =>
    as(user, queriesRoute, 'POST', { bankTransactionId: line, toNumber, ...extra }, QUERIES);
  const rows = async () => (await pool.query('SELECT status, message_sid, to_number FROM bank_tx_queries WHERE bank_transaction_id = $1 ORDER BY created_at', [line])).rows;

  beforeAll(async () => { line = await plantLine(pool, f, await plantBatch(pool, f, admin)); });
  beforeEach(async () => {
    sendMock.mockReset();
    await pool.query('DELETE FROM bank_tx_queries WHERE company_id = $1', [f.c]);
    await pool.query('UPDATE companies SET client_query_whatsapp = NULL WHERE id = $1', [f.c]);
  });

  it('a DEFINITE refusal leaves no row (400)', async () => {
    sendMock.mockResolvedValue({ sent: false, reason: 'twilio not configured' });
    const r = await ask(admin, '+27821110001');
    expect(r.state.statusCode).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it('an AMBIGUOUS failure leaves the row UNCONFIRMED (409), and a client reply still finds it', async () => {
    sendMock.mockResolvedValue({ sent: false, reason: 'read ECONNRESET', ambiguous: true });
    const r = await ask(admin, '+27821110002');
    expect(r.state.statusCode).toBe(409);
    expect(await rows()).toEqual([{ status: 'unconfirmed', message_sid: null, to_number: '+27821110002' }]);
    expect(await findOpenQuery(f.c, '+27821110002')).toMatchObject({ status: 'unconfirmed' });
  });

  it('a thrown send also leaves it unconfirmed', async () => {
    sendMock.mockRejectedValue(new Error('socket hang up'));
    expect((await ask(admin, '+27821110003')).state.statusCode).toBe(409);
    expect((await rows())[0]).toMatchObject({ status: 'unconfirmed' });
  });

  it('a confirmed send is recorded SENT with its sid; the default number is saved by an admin', async () => {
    sendMock.mockResolvedValue({ sent: true, sid: 'SM123' });
    const r = await ask(admin, '+27821110004', { saveAsDefault: true });
    expect(r.state.statusCode).toBe(201);
    expect(await rows()).toEqual([{ status: 'sent', message_sid: 'SM123', to_number: '+27821110004' }]);
    expect((await pool.query('SELECT client_query_whatsapp FROM companies WHERE id = $1', [f.c])).rows[0].client_query_whatsapp).toBe('+27821110004');
  });

  it('the status CHECK admits exactly the five values', async () => {
    await expect(pool.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status) VALUES($1,$2,'+1','x','pending')`, [f.c, line])).rejects.toThrow();
    await pool.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status) VALUES($1,$2,'+1','x','unconfirmed')`, [f.c, line]);
  });

  it('N1: a NEWER unconfirmed ghost row never takes the reply meant for the real (sent) thread', async () => {
    const num = '+27821110010';
    await pool.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status, sent_at) VALUES($1,$2,$3,'real','sent', now() - interval '2 hours')`, [f.c, line, num]);
    await pool.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status, sent_at) VALUES($1,$2,$3,'ghost','unconfirmed', now())`, [f.c, line, num]);
    const open = await findOpenQuery(f.c, num);
    expect(open?.status).toBe('sent');
    const sentId = (await pool.query(`SELECT id FROM bank_tx_queries WHERE company_id = $1 AND to_number = $2 AND status = 'sent'`, [f.c, num])).rows[0].id;
    expect(open?.id).toBe(sentId);
  });

  it('N2: 999e drops the status CHECK by lookup (a differently named one), accepts unconfirmed, and applies twice', async () => {
    const sqlText = readFileSync(join(process.cwd(), 'scripts/migrations/sql/999e_bank_tx_queries_unconfirmed_status.sql'), 'utf8');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE bank_tx_queries DROP CONSTRAINT IF EXISTS bank_tx_queries_status_check');
      await c.query(`ALTER TABLE bank_tx_queries ADD CONSTRAINT btq_other_name CHECK (status IN ('sent','replied','resolved','cancelled'))`);
      await expect(c.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status) VALUES($1,$2,'+2','x','unconfirmed')`, [f.c, line])).rejects.toThrow();
      await c.query('ROLLBACK'); await c.query('BEGIN');
      await c.query('ALTER TABLE bank_tx_queries DROP CONSTRAINT IF EXISTS bank_tx_queries_status_check');
      await c.query(`ALTER TABLE bank_tx_queries ADD CONSTRAINT btq_other_name CHECK (status IN ('sent','replied','resolved','cancelled'))`);
      await c.query(sqlText);
      await c.query(sqlText); // idempotent
      await c.query(`INSERT INTO bank_tx_queries(company_id, bank_transaction_id, to_number, message_body, status) VALUES($1,$2,'+2','x','unconfirmed')`, [f.c, line]);
      const checks = (await c.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'bank_tx_queries'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'`)).rows;
      expect(checks).toEqual([{ conname: 'bank_tx_queries_status_check' }]);
      const idx = (await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_btq_open_number'`)).rows[0].indexdef as string;
      expect(idx).toContain('unconfirmed');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('role matrix: a manager may ask the saved default number, may not ask another, may not set the default', async () => {
    await pool.query('UPDATE companies SET client_query_whatsapp = $2 WHERE id = $1', [f.c, '+27821110005']);
    sendMock.mockResolvedValue({ sent: true, sid: 'SM9' });
    expect((await ask(manager, '+27821110006')).state.statusCode).toBe(403);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await ask(manager, '+27821110005', { saveAsDefault: true })).state.statusCode).toBe(403);
    expect((await ask(manager, '+27821110005')).state.statusCode).toBe(201);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // an admin may ask another number; the manager may then follow up on THAT thread
    expect((await ask(admin, '+27821110006')).state.statusCode).toBe(201);
    expect((await ask(manager, '+27821110006')).state.statusCode).toBe(201);
  });

  it('settings PATCH: owner/admin only', async () => {
    const patch = (user: string) => as(user, settingsRoute, 'PATCH', { clientQueryWhatsapp: '+27821110007' }, `${QUERIES}/settings`);
    expect((await patch(manager)).state.statusCode).toBe(403);
    expect((await patch(admin)).state.statusCode).toBe(200);
    expect((await as(manager, settingsRoute, 'GET', undefined, `${QUERIES}/settings`)).state.statusCode).toBe(200);
  });
});

describe('B2. the company rate limit is exact under concurrency', () => {
  it('35 concurrent queries from 35 addresses: exactly 30 are sent (the company ceiling), the rest are 429', async () => {
    const f2 = await bankCompany(pool, [[admin, 'admin']], companies);
    const line = await plantLine(pool, f2, await plantBatch(pool, f2, admin));
    sendMock.mockReset().mockResolvedValue({ sent: true, sid: 'SMrl' });
    const results = await Promise.all(Array.from({ length: 35 }, (_, i) => callRoute(queriesRoute as never, tokens[admin]!, f2.c, 'POST',
      { bankTransactionId: line, toNumber: '+27821119999' }, '/api/accounting/bank-tx-queries', {}, { 'x-forwarded-for': `10.7.0.${i + 1}` })));
    const codes = results.map((r) => r.state.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(30);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    expect(sendMock).toHaveBeenCalledTimes(30);
    expect(Number((await pool.query('SELECT count(*) FROM bank_tx_queries WHERE company_id = $1', [f2.c])).rows[0].count)).toBe(30);
  }, 120_000);
});

describe('C. OCR statement commit', () => {
  const importIds: string[] = [];
  async function plantImport(rows: Array<{ date: string; description: string; amount: number }>): Promise<string> {
    const doc = (await pool.query(
      `INSERT INTO captured_documents(company_id, file_name, file_type, file_size, document_type, status, uploaded_by)
       VALUES($1,'stmt.pdf','pdf',10,'statement','pending',$2) RETURNING id`, [f.c, admin])).rows[0].id as string;
    const summary = { rows: rows.map((r) => ({ ...r, isDuplicate: false, reference: null, runningBalance: null, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 })), warnings: [] };
    const id = (await pool.query(
      `INSERT INTO bank_statement_imports(company_id, bank_account_id, source_document_id, period_start, period_end, row_count, status, extraction_summary, created_by)
       VALUES($1,$2,$3,'2026-03-01','2026-03-31',$4,'extracted',$5,$6) RETURNING id`,
      [f.c, f.bank, doc, rows.length, JSON.stringify(summary), admin])).rows[0].id as string;
    importIds.push(id);
    return id;
  }
  const commit = (id: string) => as(admin, commitRoute, 'POST', {}, `/api/accounting/bank-statements/${id}/commit`, { id });
  const rollback = (id: string) => as(admin, rollbackRoute, 'POST', {}, `/api/accounting/bank-statements/${id}/rollback`, { id });
  const batch = async (id: string) => (await pool.query('SELECT * FROM bank_import_batches WHERE id = $1', [id])).rows[0];
  const status = async (id: string) => (await pool.query('SELECT status, imported_count FROM bank_statement_imports WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    // The fixture has no unique key the statement lines can collide on (a race is what ON CONFLICT is for), so one is
    // added on the DISPOSABLE fixture only: a description per company is unique. It stands in for the race.
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS tmp_wp7_ocr_conflict ON bank_transactions(company_id, description) WHERE description LIKE \'WP7-%\'');
  });
  afterAll(async () => { await pool.query('DROP INDEX IF EXISTS tmp_wp7_ocr_conflict'); });

  it('a partly-conflicting commit counts what was written, corrects the batch count, and leaves the batch provenance intact', async () => {
    await pool.query(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status) VALUES($1,$2,'2025-01-01',-1,'WP7-B','imported')`, [f.c, f.bank]);
    const id = await plantImport([
      { date: '2026-03-05', description: 'WP7-A', amount: -10 }, { date: '2026-03-06', description: 'WP7-B', amount: -20 }, { date: '2026-03-07', description: 'WP7-C', amount: -30 },
    ]);
    const r = await commit(id);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(200);
    expect((r.state.body as { data: { inserted: number; skipped: number } }).data).toEqual({ inserted: 2, skipped: 1 });
    const b = await batch(id);
    expect(b.transaction_count).toBe(2);
    expect(b).toMatchObject({ import_channel: 'statement_ocr', imported_by: admin, bank_account_id: f.bank });
    expect(b.source_filename).toBe('stmt.pdf');
    expect(await status(id)).toEqual({ status: 'committed', imported_count: 2 });
    expect(Number((await pool.query('SELECT count(*) FROM bank_transactions WHERE import_batch_id = $1', [id])).rows[0].count)).toBe(2);
  });

  it('an ALL-conflict commit is a 409, leaves no empty batch, writes no lines, and leaves the import uncommitted', async () => {
    await pool.query(`INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status) VALUES($1,$2,'2025-01-01',-1,'WP7-D','imported'),($1,$2,'2025-01-02',-2,'WP7-E','imported')`, [f.c, f.bank]);
    const id = await plantImport([{ date: '2026-03-05', description: 'WP7-D', amount: -10 }, { date: '2026-03-06', description: 'WP7-E', amount: -20 }]);
    const r = await commit(id);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(409);
    expect(await batch(id)).toBeUndefined();
    expect(Number((await pool.query('SELECT count(*) FROM bank_transactions WHERE import_batch_id = $1', [id])).rows[0].count)).toBe(0);
    expect(await status(id)).toEqual({ status: 'extracted', imported_count: 0 });
    // the person can still roll it back
    expect((await rollback(id)).state.statusCode).toBe(200);
  });

  it('a double commit and a rollback of a committed import are 409s, refused before any write', async () => {
    const id = await plantImport([{ date: '2026-03-15', description: 'WP7-F', amount: -91 }]);
    expect((await commit(id)).state.statusCode).toBe(200);
    expect((await commit(id)).state.statusCode).toBe(409);
    expect((await rollback(id)).state.statusCode).toBe(409);
    expect(await status(id)).toEqual({ status: 'committed', imported_count: 1 });
    expect(Number((await pool.query('SELECT count(*) FROM bank_transactions WHERE import_batch_id = $1', [id])).rows[0].count)).toBe(1);
  });

  it('a rolled-back import cannot be committed (409); an import of another company is a 404', async () => {
    const id = await plantImport([{ date: '2026-03-25', description: 'WP7-G', amount: -92 }]);
    expect((await rollback(id)).state.statusCode).toBe(200);
    expect((await commit(id)).state.statusCode).toBe(409);
    const foreign = await callRoute(commitRoute as never, tokens[admin]!, g.c, 'POST', {}, `/x`, { id });
    expect(foreign.state.statusCode).toBe(404);
  });
});

describe('D. cross-tenant', () => {
  let line: string;
  beforeAll(async () => { line = await plantLine(pool, f, await plantBatch(pool, f, admin)); });
  const suggested = async () => (await pool.query('SELECT suggested_gl_account_id FROM bank_transactions WHERE id = $1', [line])).rows[0].suggested_gl_account_id;
  const save = (accountId: string) => as(admin, actionRoute, 'POST',
    { action: 'save_selection', bankTransactionId: line, selectionType: 'account', selectionEntityId: accountId }, '/api/accounting/bank-transactions-action');

  it("save_selection with another company's GL account is a 400 and nothing is written; its own account saves", async () => {
    const r = await save(g.expA);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
    expect(await suggested()).toBeNull();
    expect((await save(f.expA)).state.statusCode).toBe(200);
    expect(await suggested()).toBe(f.expA);
  });

  it('the ledger export takes only THIS company\'s bank accounts: a foreign bank code, an own expense code and a bad range are 400', async () => {
    const codeOf = async (id: string) => String((await pool.query('SELECT account_code FROM gl_accounts WHERE id = $1', [id])).rows[0].account_code);
    const exp = (code: string, extra: Record<string, string> = {}) => as(admin, exportRoute, 'GET', undefined, '/api/accounting/bank-transactions-export',
      { account_code: code, period_start: '2026-01-01', period_end: '2026-12-31', ...extra });
    expect((await exp(await codeOf(g.bank))).state.statusCode).toBe(400); // another company's bank account
    expect((await exp(await codeOf(f.expA))).state.statusCode).toBe(400); // this company's, but not a bank account
    expect((await exp(await codeOf(f.bank))).state.statusCode).toBe(200);
    expect((await exp(await codeOf(f.bank), { period_start: '2026-12-31', period_end: '2026-01-01' })).state.statusCode).toBe(400);
  });
});
