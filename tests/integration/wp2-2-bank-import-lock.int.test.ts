/**
 * WP2-2 (bank transactions audit 2026-11-15): two concurrent imports of one statement into one bank account land it
 * ONCE. The statement upload (`bank-transactions-bulk-commit`, through `withAuth` on its own connection each) and the
 * agent import (`importStatementForAgent`, the MCP path, on a request transaction each) read the account's lines,
 * then insert; the account's ingest lock — the feed writer's key — now serialises that read with the insert.
 * See wp2-2-bank-import-lock.helpers.ts for how the overlap is forced. Disposable databases only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import { importStatementForAgent } from '@/modules/accounting/services/bank/bankStatementImportService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';
import {
  arm, disarm, holdIngestKey, ingestKey, inRequest, lineCount, statementCsv, type Race,
} from './wp2-2-bank-import-lock.helpers';

const race = vi.hoisted((): Race => ({ armed: false, reads: 0, gate: null }));

// Every statement runs as written; the FIRST dedup read of an armed race then waits at the gate (helpers: arm).
// Lazy pass-through for everything else: `sql` returns a LazyQuery that sql.transaction reads `.text` from.
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

beforeAll(async () => { user = await createUser(pool, tokens); });
afterEach(() => disarm(race));
afterAll(async () => { await cleanupBankControlsA(pool, companies, [user]); }); // also ends the pool

const upload = (f: BankCompany, csv: string) => callRoute(bulkCommit as never, tokens[user]!, f.c, 'POST', {
  bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'sept.csv', fileType: 'csv',
  statementDate: '2026-09-30', bankFormat: 'generic', csvContent: csv,
}, '/api/accounting/bank-transactions-bulk-commit');

const agentImport = (f: BankCompany, csv: string) => inRequest(pool, f.c, user, () => importStatementForAgent({
  companyId: f.c, bankAccountId: f.bank, fileType: 'csv', content: csv, statementDate: '2026-09-30', bankFormat: 'generic',
}));

describe('WP2-2: one statement imported twice at once lands once', () => {
  it('bulk commit: two parallel uploads of a 3-line statement leave 3 lines, one upload imported and one skipped', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    arm(race, pool, ingestKey(f.c, f.bank));
    const csv = statementCsv('WP22 bulk');
    const answers = await Promise.all([upload(f, csv), upload(f, csv)]);
    expect(race.reads).toBeGreaterThanOrEqual(1); // the gate fired: the dedup read was really paused
    for (const a of answers) expect(a.state.statusCode, JSON.stringify(a.state.body)).toBe(200);
    expect(await lineCount(pool, f.c)).toBe(3);
    const data = answers.map((a) => (a.state.body as { data: { status: string; transactionCount: number; duplicateCount: number } }).data);
    expect(data.map((d) => d.status).sort()).toEqual(['imported', 'skipped']);
    expect(data.map((d) => d.duplicateCount).sort()).toEqual([0, 3]);
  });

  it('agent import: two parallel imports of a 3-line statement leave 3 lines (3 imported, 3 duplicates between them)', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    arm(race, pool, ingestKey(f.c, f.bank));
    const csv = statementCsv('WP22 agent');
    const results = await Promise.all([agentImport(f, csv), agentImport(f, csv)]);
    expect(race.reads).toBeGreaterThanOrEqual(1);
    expect(await lineCount(pool, f.c)).toBe(3);
    expect(results.map((r) => r.imported).sort()).toEqual([0, 3]);
    expect(results.map((r) => r.duplicates).sort()).toEqual([0, 3]);
  });

  it('a held ingest key (the feed writer\'s own spelling) stops an upload within its 5 s bound: 503 + Retry-After, nothing written', async () => {
    const f = await bankCompany(pool, [[user, 'admin']], companies);
    const held = await holdIngestKey(pool, f.c, f.bank);
    let answer: Awaited<ReturnType<typeof upload>>;
    const started = Date.now();
    try {
      answer = await upload(f, statementCsv('WP22 held'));
    } finally { await held.release(); }
    const took = Date.now() - started;
    expect(answer.state.statusCode, JSON.stringify(answer.state.body)).toBe(503);
    expect(answer.headers.get('retry-after')).toBe('2');
    expect((answer.state.body as { error?: { details?: { code?: string } } }).error?.details?.code).toBe('BANK_IMPORT_LOCK_TIMEOUT');
    expect(took).toBeGreaterThanOrEqual(4500); // it waited for the holder…
    expect(took).toBeLessThan(9000); // …and no longer than its bound
    expect(await lineCount(pool, f.c)).toBe(0);
  }, 20_000);
});
