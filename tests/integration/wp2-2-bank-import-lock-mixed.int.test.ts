/**
 * WP2-2 round 2 (adversarial review): DIFFERENT import paths racing on one bank account. The sibling suites race a
 * path against itself; the lock only protects the account if every path takes the SAME key. Here a statement upload
 * (bulk-commit), the agent import, an OCR commit and a feed batch carry the same three lines at once, and the account
 * must end with three. The gate (helpers: arm, 4 writers) holds the first dedup read until every other writer has
 * either read the account too or queued on the key, so a writer that skipped the lock has read before anyone
 * inserted. Every wait is bounded. Disposable databases only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import commitStatement from '../../pages/api/accounting/bank-statements/[id]/commit';
import { importStatementForAgent } from '@/modules/accounting/services/bank/bankStatementImportService';
import { ingestBankBatch } from '@/modules/accounting/services/bank/feed/bankIngestionService';
import { contentHashIdentity } from '@/modules/accounting/services/bank/feed/bankIngestionValidation';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA } from './bank-controls-a.helpers';
import {
  arm, disarm, extractedImport, feedConnection, ingestKey, inRequest, lineCount, statementCsv, statementLines, type Race,
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
const TAG = 'WP22 mixed';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterEach(() => disarm(race));
afterAll(async () => {
  await pool.query('DELETE FROM bank_statement_imports WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM captured_documents WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_feed_sync_logs WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [user]); // also ends the pool
});

describe('WP2-2: four different import paths racing on one account land the statement once', () => {
  it('bulk-commit, the agent import, an OCR commit and a feed batch with the same 3 lines leave 3 lines', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    const importId = await extractedImport(pool, f.c, f.bank, user, TAG);
    const conn = await feedConnection(pool, f.c, f.bank);
    const feedRows = statementLines(TAG).map((l) => {
      const fields = { transactionDate: l.date, amount: l.amount, description: l.description };
      return { ...fields, identity: contentHashIdentity(fields), state: 'posted' as const, currency: 'ZAR' };
    });
    arm(race, pool, ingestKey(f.c, f.bank), 4);

    const [upload, agent, ocr, feed] = await Promise.all([
      callRoute(bulkCommit as never, tokens[user]!, f.c, 'POST', {
        bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'sept.csv', fileType: 'csv',
        statementDate: '2026-09-30', bankFormat: 'generic', csvContent: statementCsv(TAG),
      }, '/api/accounting/bank-transactions-bulk-commit'),
      inRequest(pool, f.c, user, () => importStatementForAgent({
        companyId: f.c, bankAccountId: f.bank, fileType: 'csv', content: statementCsv(TAG), statementDate: '2026-09-30', bankFormat: 'generic',
      })),
      callRoute(commitStatement as never, tokens[user]!, f.c, 'POST', {}, `/api/accounting/bank-statements/${importId}/commit`, { id: importId }),
      inRequest(pool, f.c, user, () => ingestBankBatch(f.c,
        { source: { kind: 'feed', connectionId: conn }, fetchedAt: '2026-09-11T08:00:00Z', transactions: feedRows },
        { userId: user, sourceLabel: 'wp22', bankFormat: null })),
    ]);

    expect(race.reads).toBeGreaterThanOrEqual(1); // the gate fired
    expect(upload.state.statusCode, JSON.stringify(upload.state.body)).toBe(200);
    expect(ocr.state.statusCode, JSON.stringify(ocr.state.body)).toBe(200);
    expect(await lineCount(pool, f.c)).toBe(3);
    // Exactly one writer inserted the three lines; the other three found them.
    const inserted = [
      (upload.state.body as { data: { transactionCount: number } }).data.transactionCount,
      agent.imported,
      (ocr.state.body as { data: { inserted: number } }).data.inserted,
      feed.counts.inserted,
    ];
    expect(inserted.sort()).toEqual([0, 0, 0, 3]);
  }, 30_000);
});
