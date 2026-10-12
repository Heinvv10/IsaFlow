/**
 * The bank import answers with the cost-centre picks its auto-post sweep could
 * not apply (PR #688 follow-up F3), through the real route: a statement upload
 * (bank-transactions-bulk-commit) whose outflow the predictor codes to a
 * centre that has since been withdrawn posts the line WITHOUT the centre and
 * says so in `data.autoPost.warnings`, per bank transaction — the shape
 * postingWarningsNotice reads. With an active centre the answer carries none.
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { formatCurrency } from '@/utils/formatters';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
const INACTIVE_WARNING = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';

beforeAll(async () => { user = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM supplier_coding_history WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [user]); // also ends the pool
});

/** Auto-post on, and a supplier whose history codes it to expA under a centre that is `active` or not. */
async function company(active: boolean): Promise<{ f: BankCompany; centre: string }> {
  const f = await bankCompany(pool, [[user, 'admin']], companies);
  await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
    llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
  const centre = (await pool.query(
    `INSERT INTO cost_centres(company_id, code, name, cc_type, is_active) VALUES($1, 'OLD', 'Withdrawn', 'cc1', $2) RETURNING id`,
    [f.c, active])).rows[0].id as string;
  const { rows: [sup] } = await pool.query("INSERT INTO suppliers(company_id,name) VALUES($1,'Acmeprov Holdings') RETURNING id", [f.c]);
  await pool.query(
    'INSERT INTO supplier_coding_history(company_id,supplier_id,gl_account_id,cost_centre_id,posted_by) VALUES($1,$2,$3,$4,$5)',
    [f.c, sup.id, f.expA, centre, user]);
  return { f, centre };
}

const upload = (f: BankCompany) => callRoute(bulkCommit as never, tokens[user]!, f.c, 'POST', {
  bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'sept.csv', fileType: 'csv',
  statementDate: '2026-09-30', bankFormat: 'generic',
  csvContent: ['Date,Description,Amount', '2026-09-08,Acmeprov Holdings,-500.00', '2026-09-09,Acmeprov Holdings,-250.00'].join('\n'),
}, '/api/accounting/bank-transactions-bulk-commit');

type Answer = { batchId: string; autoPost: { warnings: Array<{ txId: string; journalEntryId: string; label: string; description: string | null; warnings: string[] }> } };
const answer = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: Answer }).data;
};

describe('bulk-commit answers with the picks its auto-post could not apply', () => {
  it('a withdrawn centre: both outflows post without it, and each is reported under its line and journal', async () => {
    const { f } = await company(false);
    const data = answer(await upload(f));
    const lines = (await pool.query(
      `SELECT id::TEXT AS id, status, provisional_je_id::TEXT AS je, transaction_date::TEXT AS day, abs(amount)::FLOAT8 AS amt, description
       FROM bank_transactions WHERE import_batch_id = $1 ORDER BY amount`, [data.batchId])).rows as Array<{ id: string; status: string; je: string; day: string; amt: number; description: string }>;
    expect(lines.map((l) => l.status)).toEqual(['provisional', 'provisional']);
    expect(lines.map((l) => l.day)).toEqual(['2026-09-08', '2026-09-09']); // the labels below are of THESE lines
    expect([...data.autoPost.warnings].sort((a, b) => a.txId.localeCompare(b.txId))).toEqual(
      lines.map((l) => ({ txId: l.id, journalEntryId: l.je, label: `${l.day} ${formatCurrency(l.amt)}`, description: l.description, warnings: [INACTIVE_WARNING] })).sort((a, b) => a.txId.localeCompare(b.txId)));
    const { rows: [carried] } = await pool.query(
      'SELECT count(*)::INT AS n FROM gl_journal_lines WHERE company_id = $1 AND cc1_id IS NOT NULL', [f.c]);
    expect(carried.n).toBe(0);
  });

  it('an active centre: the lines carry it and the answer has no warnings', async () => {
    const { f, centre } = await company(true);
    const data = answer(await upload(f));
    expect(data.autoPost).toEqual({ warnings: [] });
    const { rows: [carried] } = await pool.query(
      'SELECT count(*)::INT AS n FROM gl_journal_lines WHERE company_id = $1 AND cc1_id = $2', [f.c, centre]);
    expect(carried.n).toBe(2);
  });
});
