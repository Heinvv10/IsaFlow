/**
 * WP2-2 (bank transactions audit 2026-11-15), the other writers that dedupe against an account and then insert into
 * it: the classified worksheet import (`bank-transactions-import-classified`), the OCR statement commit
 * (`bank-statements/[id]/commit`) and the feed writer (`ingestBankBatch`). Each takes the account's ONE ingest lock
 * before its dedup read, bounded at 5 s. Companion of wp2-2-bank-import-lock.int.test.ts (bulk commit, agent import);
 * see its helpers for how the overlap is forced. Disposable databases only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import importClassified from '../../pages/api/accounting/bank-transactions-import-classified';
import commitStatement from '../../pages/api/accounting/bank-statements/[id]/commit';
import { ingestBankBatch } from '@/modules/accounting/services/bank/feed/bankIngestionService';
import { contentHashIdentity } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';
import {
  arm, disarm, holdIngestKey, ingestKey, inRequest, lineCount, type Race,
} from './wp2-2-bank-import-lock.helpers';

const race = vi.hoisted((): Race => ({ armed: false, reads: 0, gate: null }));

// As in wp2-2-bank-import-lock.int.test.ts: a lazy pass-through, the first armed dedup read waits at the gate.
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<typeof import('@/lib/neon')>();
  const { DEDUP_READ } = await import('./wp2-2-bank-import-lock.helpers');
  const realSql = real.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<unknown>;
  const wrapped = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = realSql(strings, ...values);
    if (!race.armed || !DEDUP_READ.test(strings.join('?'))) return query;
    return (async () => {
      const rows = await query;
      race.reads += 1;
      if (race.reads === 1 && race.gate) await race.gate();
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(wrapped, realSql) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';

beforeAll(async () => {
  // PRE-EXISTING DEFECT, as bank-controls-import-provenance.int.test.ts records: import-classified writes
  // bank_transactions.suggested_cost_centre, which no migration creates. Added on the disposable fixture only.
  await pool.query('ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS suggested_cost_centre TEXT');
  user = await createUser(pool, tokens);
});
afterEach(() => disarm(race));
afterAll(async () => {
  await pool.query('DELETE FROM bank_statement_imports WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [user]); // also ends the pool
});

// Amounts a JS number prints differently from NUMERIC(15,2)::text (2400.1 vs '2400.10', -1500 vs '-1500.00').
const WORKSHEET = [
  { transactionDate: '2026-09-08', description: 'WP22 cls rent', debit: 1500 },
  { transactionDate: '2026-09-09', description: 'WP22 cls deposit', credit: 2400.1 },
  { transactionDate: '2026-09-10', description: 'WP22 cls fee', debit: 35.5 },
];
const classify = (f: BankCompany) => callRoute(importClassified as never, tokens[user]!, f.c, 'POST',
  { bankAccountId: f.bank, transactions: WORKSHEET }, '/api/accounting/bank-transactions-import-classified');
const insertedOf = (a: Awaited<ReturnType<typeof classify>>) => {
  expect(a.state.statusCode, JSON.stringify(a.state.body)).toBe(201);
  return (a.state.body as { data: { inserted: number; skippedDuplicates: number } }).data;
};

/** An OCR import of the 3-line statement, read and waiting for its commit, as the extraction job leaves one. */
async function extractedImport(f: BankCompany): Promise<string> {
  const doc = crypto.randomUUID();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'sept.pdf', 'application/pdf')`, [doc, f.c]);
  const rows = [['2026-09-08', 'WP22 ocr rent', -1500], ['2026-09-09', 'WP22 ocr deposit', 2400.1], ['2026-09-10', 'WP22 ocr fee', -35.5]]
    .map(([date, description, amount]) => ({ date, description, amount, reference: null, runningBalance: null,
      isDuplicate: false, duplicateOfBankTxId: null, duplicateMatchConfidence: 0 }));
  return (await pool.query(
    `INSERT INTO bank_statement_imports (company_id, bank_account_id, source_document_id, row_count, status, extraction_summary, created_by)
     VALUES ($1, $2, $3, 3, 'extracted', $4::JSONB, $5) RETURNING id`,
    [f.c, f.bank, doc, JSON.stringify({ rows, warnings: [] }), user])).rows[0].id as string;
}
const commit = (f: BankCompany, importId: string) => callRoute(commitStatement as never, tokens[user]!, f.c, 'POST', {},
  `/api/accounting/bank-statements/${importId}/commit`, { id: importId });
const committedOf = (a: Awaited<ReturnType<typeof commit>>) => {
  expect(a.state.statusCode, JSON.stringify(a.state.body)).toBe(200);
  return (a.state.body as { data: { inserted: number; skipped: number } }).data;
};

describe('WP2-2: the classified import and the OCR commit land a statement once', () => {
  it('classified: two parallel posts of a 3-line worksheet leave 3 lines', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    arm(race, pool, ingestKey(f.c, f.bank));
    const answers = (await Promise.all([classify(f), classify(f)])).map(insertedOf);
    expect(race.reads).toBeGreaterThanOrEqual(1);
    expect(await lineCount(pool, f.c)).toBe(3);
    expect(answers.map((a) => a.inserted).sort()).toEqual([0, 3]);
  });

  it('classified: the same worksheet posted again inserts nothing (its dedup hash is the statement hash, 2 dp)', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    expect(insertedOf(await classify(f))).toMatchObject({ inserted: 3, skippedDuplicates: 0 });
    expect(insertedOf(await classify(f))).toMatchObject({ inserted: 0, skippedDuplicates: 3 });
    expect(await lineCount(pool, f.c)).toBe(3);
  });

  it('OCR: two extracted copies of one statement committed in parallel leave 3 lines', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    const [a, b] = [await extractedImport(f), await extractedImport(f)];
    arm(race, pool, ingestKey(f.c, f.bank));
    const answers = (await Promise.all([commit(f, a), commit(f, b)])).map(committedOf);
    expect(await lineCount(pool, f.c)).toBe(3);
    expect(race.reads).toBeGreaterThanOrEqual(1); // the commit re-read the account, and the gate held it there
    expect(answers.map((x) => x.inserted).sort()).toEqual([0, 3]);
  });

  it('OCR: a copy read before the first was committed inserts nothing when committed after it', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    const [a, b] = [await extractedImport(f), await extractedImport(f)];
    expect(committedOf(await commit(f, a))).toEqual({ inserted: 3, skipped: 0 });
    expect(committedOf(await commit(f, b))).toEqual({ inserted: 0, skipped: 3 });
    expect(await lineCount(pool, f.c)).toBe(3);
  });
});

describe('WP2-2: the feed writer shares the key, and its wait is bounded', () => {
  it('a held ingest key refuses a feed batch within 5 s (BANK_IMPORT_LOCK_TIMEOUT), nothing written', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    const conn = crypto.randomUUID();
    await pool.query(`INSERT INTO bank_feed_connections (id, company_id, bank_account_id, provider, status, is_active, config)
      VALUES ($1, $2, $3, 'extension', 'active', true, '{"bankId":"absa"}')`, [conn, f.c, f.bank]);
    const fields = { transactionDate: '2026-09-05', amount: -50, description: 'WP22 feed fee' };
    const batch = { source: { kind: 'feed' as const, connectionId: conn }, fetchedAt: '2026-09-11T08:00:00Z',
      transactions: [{ ...fields, identity: contentHashIdentity(fields), state: 'posted' as const, currency: 'ZAR' }] };
    const held = await holdIngestKey(pool, f.c, f.bank);
    const started = Date.now();
    let outcome: unknown;
    try {
      const ingest = inRequest(pool, f.c, user, () => ingestBankBatch(f.c, batch, { userId: user, sourceLabel: 'wp22', bankFormat: null }));
      ingest.catch(() => undefined); // settled below or after the holder lets go; never an unhandled rejection
      outcome = await Promise.race([
        ingest.then(() => 'ingested', (err: unknown) => err),
        new Promise((resolve) => setTimeout(() => resolve('still waiting after 9 s'), 9000)),
      ]);
    } finally { await held.release(); }
    expect((outcome as { code?: string }).code ?? outcome).toBe('BANK_IMPORT_LOCK_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(9000);
    expect(await lineCount(pool, f.c)).toBe(0);
  }, 20_000);
});
