/**
 * WP6 round 4 (review LOWs): a month with no period is judged by the same window the single accept uses, even for a
 * non-calendar fiscal year (L3); a scan stopped by the held-line cap with lines already postable continues after the last
 * row it actually screened (L5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bulkAccept from '../../pages/api/accounting/bank-bulk-accept';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { bankCompany, cleanupBankControlsA, enforce, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const URL = '/api/accounting/bank-bulk-accept';

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_import_batches WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]);
});

async function fixture(): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await pool.query(
    `INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap)
     VALUES($1, true, 0.50, 0, false, 0.95, 0)`, [f.c]);
  return f;
}
const preview = async (f: BankCompany, query: Record<string, string> = {}) => dataOf<{
  lines: { id: string }[]; scanTruncated: boolean; nextScanAfter: string | null; excluded: { noPeriod: number };
}>(await callRoute(bulkAccept, tokens[a]!, f.c, 'GET', undefined, URL, { bankAccountId: f.bank, ...query }));
const insert = (f: BankCompany, count: number, idPrefix: string, date: string, batch: string | null = null) => pool.query(
  `INSERT INTO bank_transactions(id, company_id, bank_account_id, transaction_date, amount, description, status, suggested_gl_account_id, suggested_confidence, suggested_strategy, import_batch_id)
   SELECT ($1 || lpad(g::TEXT, 12, '0'))::UUID, $2, $3, $6::DATE, -1, 'BULK4 line', 'imported', $4, 0.97, 'history', $5 FROM generate_series(1, $7) g`,
  [idPrefix, f.c, f.bank, f.expA, batch, date, count]);

describe('round 4', () => {
  it('L3: a date one calendar year below the auto-create window is let through, the window being the single accept\'s', async () => {
    const f = await fixture();
    const year = new Date().getFullYear() - 11; // below isAutoCreatableYear, but a year chained from the next one can hold it
    await insert(f, 1, '33333333-3333-4333-8333-', `${year}-12-15`);
    await insert(f, 1, '44444444-4444-4444-8444-', `${year - 5}-12-15`); // far below: no year can place it
    const p = await preview(f);
    expect(p.lines.map((l) => l.id)).toEqual(['33333333-3333-4333-8333-000000000001']);
    expect(p.excluded.noPeriod).toBe(1);
  });

  it('L5: stopped by the held-line cap with more than 25 postable lines, the cursor is the last row screened, not the page end', async () => {
    const f = await fixture();
    await enforce(pool, f.c, a, ['manual_journal']);
    const batch = (await pool.query(
      `INSERT INTO bank_import_batches(company_id, bank_account_id, statement_date, transaction_count, imported_by, import_channel) VALUES($1,$2,DATE '2026-09-30',60,$3,'upload') RETURNING id`, [f.c, f.bank, a])).rows[0].id;
    await insert(f, 60, '22222222-2222-4222-8222-', '2026-09-01', batch); // held (imported by the caller), ids first
    await insert(f, 40, '55555555-5555-4555-8555-', '2026-09-01');        // postable
    const p = await preview(f);
    expect(p.lines).toHaveLength(25);
    expect(p.scanTruncated).toBe(true);
    expect(p.nextScanAfter).toBe('55555555-5555-4555-8555-000000000026'); // the 26th postable line, not the 40th row
  }, 60_000);
});
