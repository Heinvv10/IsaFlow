/**
 * Importer ≠ allocator holds for extension feed lines (Hein, 2026-11-16).
 *
 * A write-access user could pair the Chrome extension, push a fabricated
 * outflow through the real extension-ingest route and allocate it themselves:
 * feed lines were exempt from the importer rule, and bank-evidenced lines skip
 * the approval gates. ingest records the token's user as the batch's
 * imported_by, so the same rule as for a statement now applies: while the arm
 * is enforced the pusher is refused 403 IMPORTER_MAY_NOT_ALLOCATE with nothing
 * written; another member allocates; a sole approver, enforcement off, and a
 * feed line with no batch (a system feed: no person) are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  actionRoute, cleanupBankControlsA, lineStatus, PAY_TYPES, plantBatch, plantLine, refusalOf, type BankCompany,
} from './bank-controls-a.helpers';
import { EXT_REFUSAL, FeedHarness, type FeedCompany } from './bank-controls-feed-importer.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const h = new FeedHarness(pool);
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;

beforeAll(async () => {
  await h.start();
  ({ a, b } = h);
  act = actionRoute(h.tokens);
}, 60000);
afterAll(() => h.stop(cleanupBankControlsA));

const fixture = (types: string[], members?: [string, string][]) => h.fixture(types, members);
const push = (f: FeedCompany, pusher: string, amount: number) => h.push(f, pusher, amount);
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
const allocate = (user: string, f: BankCompany, line: string, extra: Record<string, unknown> = { contraAccountId: f.expA }) =>
  act(user, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', ...extra });
const refused = (res: Parameters<typeof refusalOf>[0], arm = 'manual-journal') => {
  expect(refusalOf(res), JSON.stringify(res.state.body)).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
  expect(refusalOf(res).message).toBe(EXT_REFUSAL(arm)); // the extension wording, not the statement one
};

describe('the forged-extension repro', () => {
  it('records the pusher as the batch importer', async () => {
    const f = await fixture(['manual_journal']);
    const line = await push(f, a, -9999);
    const r = (await pool.query(
      `SELECT b.imported_by, b.import_channel, t.bank_feed_connection_id FROM bank_transactions t
       JOIN bank_import_batches b ON b.id = t.import_batch_id WHERE t.id = $1`, [line])).rows[0];
    expect(r).toMatchObject({ imported_by: a, import_channel: 'extension', bank_feed_connection_id: f.conn });
  });

  it('manual_journal: the pusher is refused 403 on account, split and transfer, nothing written; another member allocates', async () => {
    const f = await fixture(['manual_journal']);
    const line = await push(f, a, -9999);
    refused(await allocate(a, f, line));
    refused(await allocate(a, f, line, { allocationType: 'transfer', contraAccountId: f.bank2 }));
    refused(await act(a, f.c, { action: 'split_allocate', bankTransactionId: line,
      lines: [{ contraAccountId: f.expA, amount: 5000 }, { contraAccountId: f.expB, amount: 4999 }] }));
    expect(await journals(f.c)).toBe(0);
    expect(await lineStatus(pool, line)).toBe('imported');
    expect((await allocate(b, f, line)).state.statusCode).toBe(200);
    expect(await journals(f.c)).toBe(1);
  });

  it('supplier_payment: the pusher is refused paying a supplier from the forged line; another member pays it', async () => {
    const f = await fixture(PAY_TYPES);
    const line = await push(f, a, -9999);
    refused(await allocate(a, f, line, { allocationType: 'supplier', entityId: f.supplier }), 'supplier-payment');
    expect(await journals(f.c)).toBe(0);
    expect((await pool.query('SELECT count(*)::INT AS n FROM supplier_payments WHERE company_id = $1', [f.c])).rows[0].n).toBe(0);
    expect((await allocate(b, f, line, { allocationType: 'supplier', entityId: f.supplier })).state.statusCode).toBe(200);
  });

  it('customer refund (money out to a customer, the manual_journal arm): the pusher is refused, nothing written', async () => {
    const f = await fixture(['manual_journal']);
    const line = await push(f, a, -9999);
    refused(await allocate(a, f, line, { allocationType: 'customer', entityId: f.customer }));
    expect(await journals(f.c)).toBe(0);
    expect(await lineStatus(pool, line)).toBe('imported');
  });
});

describe('what stays as it was', () => {
  it('a sole approver on the admin floor allocates their own push', async () => {
    const f = await fixture(['manual_journal'], [[a, 'admin'], [b, 'viewer']]);
    expect((await allocate(a, f, await push(f, a, -9999))).state.statusCode).toBe(200);
  });

  it('enforcement off: the pusher allocates', async () => {
    const f = await fixture([]);
    expect((await allocate(a, f, await push(f, a, -9999))).state.statusCode).toBe(200);
  });

  it('a feed line with no batch (a system feed, no person on record) is not gated', async () => {
    const f = await fixture(['manual_journal']);
    expect((await allocate(a, f, await plantLine(pool, f, 'feed'))).state.statusCode).toBe(200);
  });

  it('a feed batch whose importer is an mcp: label names no person and is not gated', async () => {
    const f = await fixture(['manual_journal']);
    const batch = await plantBatch(pool, f, 'mcp:feed:v1', 'extension');
    const line = (await pool.query(
      `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id,
         bank_feed_connection_id) VALUES($1,$2,DATE '2026-09-01',-9999,'BC mcp feed','imported',$3,$4) RETURNING id`,
      [f.c, f.bank, batch, f.conn])).rows[0].id as string;
    expect((await allocate(a, f, line)).state.statusCode).toBe(200);
  });
});
