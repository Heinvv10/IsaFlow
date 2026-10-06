/**
 * NUMRACE round 2 (brk-numrace M1): bank-transactions-bulk-commit takes every year its import sweep AND its rule
 * pass can post in BEFORE the import. The sweep numbered its 2026 journal first and the rule pass then took 2025's
 * key — out of order — so an ascending peer (2025, then 2026) deadlocked the request (brk attack A, on the route).
 *
 * Driven through the real handler the way withAuth runs it: one transaction, the auth wrappers mocked away.
 * Disposable fixture only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { response } from './mfa-impersonation-postgres.helpers';
import { dropFixture, seedSupplier } from './helpers/l1FifoFixture';
import { ascendingPeerVs, dropCrossYear, line, seedCrossYear, type CrossYear } from './helpers/numraceCrossYear';

vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/lib/billing/getCompanyPlan', () => ({ getCompanyPlan: vi.fn(async () => null) }));

const DATABASE_URL = process.env.DATABASE_URL;
const made: CrossYear[] = [];

async function bulkCommit(c: CrossYear, csvContent: string) {
  const handler = (await import('../../pages/api/accounting/bank-transactions-bulk-commit')).default as
    (req: NextApiRequest, res: unknown) => Promise<unknown>;
  const result = response();
  await handler({
    method: 'POST', query: {}, companyId: c.fx.companyId, user: { id: c.fx.userId },
    body: {
      bankAccountId: c.fx.bankAccountId, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'nr.csv',
      fileType: 'csv', statementDate: '2026-01-31', csvContent, bankFormat: 'generic', applyBankRules: true,
    },
  } as unknown as NextApiRequest, result.res);
  return { status: result.state.statusCode, body: result.state.body as Record<string, unknown> };
}

describe.skipIf(!DATABASE_URL)('NUMRACE r2: bulk-commit takes the sweep and rule-pass years before the import', () => {
  afterAll(async () => {
    for (const c of made) {
      await sql`UPDATE bank_transactions SET import_batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM bank_import_batches WHERE company_id = ${c.fx.companyId}::UUID`;
      await sql`DELETE FROM supplier_coding_history WHERE company_id = ${c.fx.companyId}::UUID`;
      await dropCrossYear(c);
      await dropFixture(c.fx);
    }
  }, 60000);

  it('import (sweep posts 2026) + rule pass over 2025 and 2026 vs an ascending peer: no deadlock, both rules post', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear('NUMRACE-BC', DATABASE_URL!);
    made.push(c);
    // The import sweep's predictor posts a provisional 2026 journal for this supplier's line.
    const supplierId = await seedSupplier(c.fx, 'Zebra Plumbing');
    for (let i = 0; i < 3; i++) {
      await sql`INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, posted_by)
        VALUES (${c.fx.companyId}::UUID, ${supplierId}::UUID, ${c.expense}::UUID, 'none', 'numrace')`;
    }
    await sql`INSERT INTO bank_auto_post_settings (company_id, enabled, min_confidence, amount_cap)
      VALUES (${c.fx.companyId}::UUID, true, 0.70, 10000)`;
    const r25 = await line(c, '33333333', '2025-12-28', 'NRRULE r25');
    const r26 = await line(c, '44444444', '2026-01-07', 'NRRULE r26');
    const csv = ['Date,Description,Amount', `2026-01-10,Zebra Plumbing ${c.fx.tag},-50.00`].join('\n');
    const { rp, rr, before, after } = await ascendingPeerVs(c, () => bulkCommit(c, csv));
    const posted = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions
      WHERE id IN (${r25}::UUID, ${r26}::UUID) AND matched_journal_line_id IS NOT NULL`) as { n: number }[];
    const swept = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
      AND description LIKE 'Zebra Plumbing%' AND provisional_je_id IS NOT NULL`) as { n: number }[];
    process.stdout.write(`BC ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after }, posted, swept })}\n`);
    expect(swept[0]!.n, 'the import sweep posted its 2026 journal (the shape needs it)').toBe(1);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? (rr.value as { status: number }).status : rr).toBe(200);
    expect(posted[0]!.n).toBe(2);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
});
