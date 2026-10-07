/**
 * R-035 PR6 round 4 (PR #660 adversarial REPRO 2 / blind MEDIUM; Hein's H2):
 *
 *  - The bank-rule auto-post sweep (bankRuleAutoPostLine) posting a HAND-KEYED
 *    line to an account is a manual journal nobody decided: under enforcement a
 *    matching rule skips it (counted as approval_required), before any write,
 *    whatever triggered the sweep — the twin of PR5's supplier arm. An imported
 *    line still auto-posts; so does everything with enforcement off.
 *  - A hand-keyed TRANSFER to another bank-subtype account is a manual journal
 *    to a GL account too (any account can be relabelled bank): refused 409
 *    before any write on Spend/Receive Money and on allocate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import bankTransactionsManual from '../../pages/api/accounting/bank-transactions-manual';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRule, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
  await cleanupPr6(pool, companies, [a]);
});

async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany & { bank2: string }> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, a);
  const { rows: [bank2] } = await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,'R035 BK2','asset','debit',true,'bank') RETURNING id`, [f.c, `B2${f.c.slice(0, 6)}`]);
  return { ...f, bank2: bank2.id };
}
const line = async (f: JournalCompany, provenance: 'manual' | 'import', amount = -1500) => (await pool.query(
  `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
   VALUES($1,$2,DATE '2026-09-01',$3,'R035 SWEEP me','imported',$4) RETURNING id`,
  [f.c, f.bank, amount, provenance === 'import' ? crypto.randomUUID() : null])).rows[0].id as string;
const statusOf = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status;
const call = (h: unknown, c: string, body: unknown, url: string) => callRoute(h as never, tokens[a]!, c, 'POST', body, url);
const sweep = async (f: JournalCompany) => {
  await pool.query(
    `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id, auto_create_entry, created_by)
     VALUES($1,'R035 sweep','description','contains','SWEEP',$2,true,$3)`, [f.c, f.expA, a]);
  return call(bankRulesAction, f.c, { action: 'apply', bankAccountId: f.bank }, '/api/accounting/bank-rules-action');
};

describe('the bank-rule sweep', () => {
  it('skips a hand-keyed line an account rule would post (counted); an imported line still posts', async () => {
    const f = await fixture();
    const manual = await line(f, 'manual');
    const imported = await line(f, 'import');
    const res = await sweep(f);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ autoPostSkippedApprovalRequired: number }>(res).autoPostSkippedApprovalRequired).toBe(1);
    expect(await statusOf(manual)).toBe('imported');
    expect(await statusOf(imported)).toBe('allocated');
  });

  it('enforcement off, or below the rule: the sweep posts a hand-keyed line as before', async () => {
    const off = await fixture({ enforced: false });
    const offLine = await line(off, 'manual');
    await sweep(off);
    expect(await statusOf(offLine)).toBe('allocated');
    const f = await fixture();
    const small = await line(f, 'manual', -500);
    await sweep(f);
    expect(await statusOf(small)).toBe('allocated');
  });
});

describe('a hand-keyed transfer to another bank account', () => {
  it('Spend Money as a transfer is refused 409 before the line is inserted', async () => {
    const f = await fixture();
    const res = await call(bankTransactionsManual, f.c, { type: 'spend', bankAccountId: f.bank, date: '2026-09-01', amount: 1500,
      description: 'keyed by hand', allocationType: 'transfer', contraAccountId: f.bank2 }, '/api/accounting/bank-transactions-manual');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(Number((await pool.query('SELECT count(*) AS n FROM bank_transactions WHERE company_id = $1', [f.c])).rows[0].n)).toBe(0);
  });

  it('an existing hand-keyed line allocated as a transfer is refused; an imported one transfers', async () => {
    const f = await fixture();
    const allocate = (id: string) => call(bankTransactionsAction, f.c, { action: 'allocate', bankTransactionId: id,
      allocationType: 'transfer', contraAccountId: f.bank2 }, '/api/accounting/bank-transactions-action');
    const manual = await line(f, 'manual');
    const refused = await allocate(manual);
    expect(refused.state.statusCode, JSON.stringify(refused.state.body)).toBe(409);
    expect(await statusOf(manual)).toBe('imported');
    const imported = await line(f, 'import');
    expect((await allocate(imported)).state.statusCode).toBe(200);
  });
});
