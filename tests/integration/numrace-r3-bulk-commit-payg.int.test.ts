/**
 * NUMRACE round 3 (sec-numrace S3): bank-transactions-bulk-commit takes its year keys (and the 20-year refusal)
 * BEFORE the PAYG debit. Round 2 debited first: a held year then aborted the request transaction, the catch's refund
 * failed on it (25P02) and logged "Bulk commit refund failed" at ERROR — a false billing alarm — and a 21-year
 * statement committed a debit/refund pair for a request that never ran. Now neither refusal writes a ledger row.
 *
 * Real withErrorHandler; the withAuth commit rule (COMMIT below 500, else ROLLBACK) is reproduced here. Derived from
 * agents/sec-numrace/sec-numrace2-bulkcommit.int.test.ts.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, runOn } from './helpers/l1FifoFixture';
import { dropCrossYear, seedCrossYear, type CrossYear } from './helpers/numraceCrossYear';
import { holdKey } from './helpers/numraceGate';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => ({ planCode: 'payg' })) }));

const DATABASE_URL = process.env.DATABASE_URL;
const made: CrossYear[] = [];
type Row = Record<string, unknown>;

async function asRequest(c: CrossYear, csvContent: string) {
  const handler = (await import('../../pages/api/accounting/bank-transactions-bulk-commit')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  const client = await c.fx.pool.connect();
  await client.query('BEGIN');
  let thrown: unknown = null;
  try {
    await runOn(c.fx, client, () => handler({
      method: 'POST', query: {}, companyId: c.fx.companyId, user: { id: c.fx.userId }, headers: {},
      body: {
        bankAccountId: c.fx.bankAccountId, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'nr.csv',
        fileType: 'csv', statementDate: '2026-01-31', csvContent, bankFormat: 'generic', applyBankRules: false,
      },
    } as unknown as NextApiRequest, result.res));
  } catch (e) { thrown = e; }
  const status = result.state.statusCode as number | undefined;
  await client.query(!thrown && status !== undefined && status < 500 ? 'COMMIT' : 'ROLLBACK');
  client.release(true);
  return { status, body: result.state.body, thrown };
}

async function ledger(c: CrossYear) {
  const w = (await sql`SELECT balance_flows FROM flow_wallet WHERE company_id = ${c.fx.companyId}::UUID`) as Row[];
  const l = (await sql`SELECT type, flows FROM flow_ledger WHERE company_id = ${c.fx.companyId}::UUID`) as Row[];
  const b = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
    AND description LIKE 'NRPAYG%'`) as Row[];
  return { balance: Number(w[0]?.balance_flows), rows: l.map((r) => `${r.type}:${r.flows}`), imported: b[0]!.n };
}

describe.skipIf(!DATABASE_URL)('NUMRACE r3: bulk-commit refuses before it charges', () => {
  afterAll(async () => {
    for (const c of made) {
      await sql`DELETE FROM flow_ledger WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM flow_wallet WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`UPDATE bank_transactions SET import_batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM bank_import_batches WHERE company_id = ${c.fx.companyId}::UUID`;
      await dropCrossYear(c);
      await dropFixture(c.fx);
    }
  }, 60000);

  async function payg(): Promise<CrossYear> {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear('NUMRACE-PG', DATABASE_URL!);
    made.push(c);
    await sql`INSERT INTO flow_wallet (company_id, balance_flows) VALUES (${c.fx.companyId}::UUID, 100)`;
    return c;
  }

  it('a held year: 503, no debit or refund row, no "refund failed" ERROR', async () => {
    const c = await payg();
    const errors = vi.spyOn(log, 'error');
    const held = await holdKey(c.fx.pool, `${c.fx.companyId}:2025`, 857);
    let out;
    try {
      out = await asRequest(c, ['Date,Description,Amount', '2025-12-30,NRPAYG a1,-5.00', '2026-01-03,NRPAYG a2,-6.00'].join('\n'));
    } finally { await held.open(); }
    const refundFailed = errors.mock.calls.filter((call) => /refund failed/i.test(String(call[0])));
    errors.mockRestore();
    const l = await ledger(c);
    process.stdout.write(`PAYG-held ${JSON.stringify({ status: out.status, l, refundFailed: refundFailed.length })}\n`);
    expect(out.status).toBe(503);
    expect(l).toEqual({ balance: 100, rows: [], imported: 0 });
    expect(refundFailed).toHaveLength(0);
  }, 60000);

  it('a 21-year statement: 400, no debit or refund row', async () => {
    const c = await payg();
    const rows = ['Date,Description,Amount', ...Array.from({ length: 21 }, (_, i) => `${2000 + i}-03-01,NRPAYG y${i},-1.00`)];
    const out = await asRequest(c, rows.join('\n'));
    const l = await ledger(c);
    process.stdout.write(`PAYG-span ${JSON.stringify({ status: out.status, l })}\n`);
    expect(out.status).toBe(400);
    expect(l).toEqual({ balance: 100, rows: [], imported: 0 });
  }, 60000);
});
