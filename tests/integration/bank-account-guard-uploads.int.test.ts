/**
 * WP2 row 1 (audit 2026-11-15), the statement upload paths. bank-statements
 * (the PDF upload) checked only that the id was ANY account of the company, so
 * a revenue or a deactivated account became the bank of a statement import.
 * Bulk preview and bulk commit already refused correctly with an inline query;
 * they now use the shared guard (bank/bankAccountGuard), and this pins that
 * their refusal stayed a 400 that writes nothing and their success still runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
// Storage is the only network call replaced; the extraction job (the VLM) is never started.
vi.mock('@/lib/supabaseStorage', async (orig) => (await import('./capture-read-storage.helpers')).fakeSupabaseStorage(await orig()));
vi.mock('@/lib/afterCommit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/afterCommit')>();
  return {
    ...real,
    runAfterCommit: (label: string, fn: () => Promise<unknown>) => {
      if (label !== 'bank statement extraction') real.runAfterCommit(label, fn);
    },
  };
});
import statementsRoute from '../../pages/api/accounting/bank-statements/index';
import bulkPreview from '../../pages/api/accounting/bank-transactions-bulk-preview';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import ocrCommit from '../../pages/api/accounting/bank-statements/[id]/commit';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import {
  cleanupGuardFixture, guardFixture, legacySpelledAccount, messageOf, refusedIds, seedStatementImport, writtenRows, type GuardFixture,
} from './bank-account-guard.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let x: GuardFixture;

beforeAll(async () => { x = await guardFixture(pool); });
afterAll(() => cleanupGuardFixture(pool, x));

type Result = { state: { statusCode: number; body: unknown } };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const csv = (tag: string) => ['Date,Description,Amount', `2026-09-02,BAG ${tag} ONE,-120.00`, `2026-09-03,BAG ${tag} TWO,450.00`].join('\n');

/** A real multipart POST: the route parses its body with formidable, which reads the stream. */
async function upload(bankAccountId: string): Promise<Result> {
  const boundary = `----bag${crypto.randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bankAccountId"\r\n\r\n${bankAccountId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sept.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    PDF, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const base = request({ 'sb-access-token': x.tokens[x.user]!, active_company_id: x.f.c }, 'POST') as never as Record<string, unknown>;
  const req = Object.assign(Readable.from([payload]), base, {
    url: '/api/accounting/bank-statements', query: {},
    headers: { ...(base.headers as Record<string, string>), 'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length) },
  });
  const result = response();
  await (statementsRoute as unknown as (rq: never, rs: never) => Promise<unknown>)(req as never, result.res as never);
  return result;
}

const preview = (bankAccountId: string, tag: string) => callRoute(bulkPreview as never, x.tokens[x.user]!, x.f.c, 'POST', {
  bankAccountId, fileType: 'csv', filename: `${tag}.csv`, csvContent: csv(tag), bankFormat: 'unknown',
}, '/api/accounting/bank-transactions-bulk-preview');

const commit = (bankAccountId: string, tag: string) => callRoute(bulkCommit as never, x.tokens[x.user]!, x.f.c, 'POST', {
  bankAccountId, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: `${tag}.csv`, fileType: 'csv',
  statementDate: '2026-09-30', csvContent: csv(tag), bankFormat: 'generic',
}, '/api/accounting/bank-transactions-bulk-commit');

async function expectRefusedEverywhere(call: (id: string) => Promise<Result>) {
  for (const [what, id] of refusedIds(x)) {
    const before = await writtenRows(pool, x);
    const res = await call(id);
    expect(res.state.statusCode, `${what}: ${JSON.stringify(res.state.body)}`).toBe(400);
    expect(messageOf(res), what).toMatch(/bank account/i);
    expect(await writtenRows(pool, x), `${what} wrote a row`).toEqual(before);
  }
}

describe('bank-statements POST (PDF upload): the bank of a statement import', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => upload(id));
  });

  it('refuses an id that is not a UUID with a 400, not a database error', async () => {
    const res = await upload('not-a-uuid');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
  });

  it('still stores the statement and queues its import on a real bank account', async () => {
    const res = await upload(x.f.bank);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
    const { rows } = await pool.query(
      'SELECT bank_account_id, status FROM bank_statement_imports WHERE company_id = $1', [x.f.c]);
    expect(rows).toEqual([{ bank_account_id: x.f.bank, status: 'extracting' }]);
  });
});

describe('bank-transactions-bulk-preview: unchanged refusal through the shared guard', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => preview(id, `p${id.slice(0, 6)}`));
  });

  it('still previews against a real bank account, naming it', async () => {
    const res = await preview(x.f.bank, 'pok');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((res.state.body as { data: { totalParsed: number } }).data.totalParsed).toBe(2);
  });
});

describe('bank-transactions-bulk-commit: unchanged refusal through the shared guard', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, nothing written', async () => {
    await expectRefusedEverywhere((id) => commit(id, `c${id.slice(0, 6)}`));
  });

  it('still imports into a real bank account', async () => {
    const res = await commit(x.f.bank, 'cok');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { batchId } = (res.state.body as { data: { batchId: string } }).data;
    const { rows: [row] } = await pool.query(
      'SELECT bank_account_id, (SELECT count(*)::INT FROM bank_transactions WHERE import_batch_id = $1) AS lines '
      + 'FROM bank_import_batches WHERE id = $1 AND company_id = $2', [batchId, x.f.c]);
    expect(row).toEqual({ bank_account_id: x.f.bank, lines: 2 });
  });
});

// Round 2 (brk-1444 HIGH): the commit wrote the batch and the lines on the import's STORED bank_account_id, unchecked.
const commitImport = (id: string) => callRoute(ocrCommit as never, x.tokens[x.user]!, x.f.c, 'POST', undefined,
  `/api/accounting/bank-statements/${id}/commit`, { id });
const importStatus = async (id: string) =>
  (await pool.query('SELECT status FROM bank_statement_imports WHERE id = $1', [id])).rows[0].status as string;

describe('bank-statements/[id]/commit: the stored bank of an import is re-checked when it is committed', () => {
  it('refuses an import made before the guard on a revenue account: 400, nothing written, still uncommitted', async () => {
    const id = await seedStatementImport(pool, x, x.revenue, 'rev');
    const before = await writtenRows(pool, x);
    const res = await commitImport(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toMatch(/bank account/i);
    expect(await writtenRows(pool, x)).toEqual(before);
    expect(await importStatus(id)).toBe('extracted');
  });

  it('refuses an import whose bank account was deactivated after the upload: 400, nothing written', async () => {
    const bank = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
       VALUES ($1,$2,'BAG later deactivated','asset','debit',true,'bank') RETURNING id`, [x.f.c, `LD${x.f.c.slice(0, 6)}`],
    )).rows[0].id as string;
    const id = await seedStatementImport(pool, x, bank, 'late');
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [bank]);
    const before = await writtenRows(pool, x);
    const res = await commitImport(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(await writtenRows(pool, x)).toEqual(before);
    expect(await importStatus(id)).toBe('extracted');
  });

  it('still commits an import on a real bank account', async () => {
    const id = await seedStatementImport(pool, x, x.f.bank2, 'ok');
    const res = await commitImport(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const { rows } = await pool.query(
      'SELECT bank_account_id FROM bank_transactions WHERE import_batch_id = $1 AND company_id = $2', [id, x.f.c]);
    expect(rows).toEqual([{ bank_account_id: x.f.bank2 }]);
    expect(await importStatus(id)).toBe('committed');
  });
});

describe('the guard reads the subtype as every bank picker does (isBankSubtype), not by exact spelling', () => {
  it("accepts a legacy row spelled 'Bank Account', which canonicalises to bank", async () => {
    const legacy = await legacySpelledAccount(pool, x.f.c, 'Bank Account');
    const res = await preview(legacy, 'legacy');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });
});
