/**
 * Bank controls step 2 (Hein, decision 2; the [agent decides] answered): an
 * unattended sweep is the PERSON who triggered it, and under enforcement it
 * skips — and counts — the lines that person imported, as `approval_required`,
 * consistent with the sweeps' hand-keyed skips. Who posts does not change
 * (the import sweep still posts, and records its run, as the system user).
 *   - an import's own auto-post sweep (bulk-commit) runs for the importer;
 *   - the rule sweep (bank-rules-action "apply") runs for the session user;
 *   - the categorisation sweep (smart-categorize) runs for the session user.
 * Another member, enforcement off, or the sole approver: the sweep posts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '../../src/lib/auth';
import bulkCommit from '../../pages/api/accounting/bank-transactions-bulk-commit';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  bankCompany, cleanupBankControlsA, enforce, lineStatus, plantBatch, plantLine, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const NOBODY = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
});
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

/** Auto-post on at confidence 0.5, a supplier whose history predicts expA, and (unless off) manual_journal enforced. */
async function fixture(opts: { enforced?: boolean; members?: [string, string][] } = {}): Promise<BankCompany> {
  const f = await bankCompany(pool, opts.members ?? [[a, 'admin'], [b, 'admin']], companies);
  if (opts.enforced !== false) await enforce(pool, f.c, a, ['manual_journal']);
  await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
    llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
  const { rows: [sup] } = await pool.query("INSERT INTO suppliers(company_id,name) VALUES($1,'Acmeprov Holdings') RETURNING id", [f.c]);
  await pool.query('INSERT INTO supplier_coding_history(company_id,supplier_id,gl_account_id,posted_by) VALUES($1,$2,$3,$4)',
    [f.c, sup.id, f.expA, a]);
  return f;
}
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;

describe("an import's auto-post sweep runs for the importer", () => {
  const importAs = async (user: string, f: BankCompany) => {
    const res = await callRoute(bulkCommit as never, tokens[user]!, f.c, 'POST', {
      bankAccountId: f.bank, bulkImportId: crypto.randomUUID(), bulkSequence: 1, filename: 'sept.csv', fileType: 'csv',
      statementDate: '2026-09-30', bankFormat: 'generic',
      csvContent: ['Date,Description,Amount', '2026-09-08,Acmeprov Holdings,-500.00'].join('\n'),
    }, '/api/accounting/bank-transactions-bulk-commit');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const batch = (res.state.body as { data: { batchId: string } }).data.batchId;
    return (await pool.query('SELECT id FROM bank_transactions WHERE import_batch_id = $1', [batch])).rows[0].id as string;
  };

  it('under enforcement the importer\'s own outflow is skipped: nothing posted, the line still imported', async () => {
    const f = await fixture();
    const line = await importAs(a, f);
    expect(await lineStatus(pool, line)).toBe('imported');
    expect(await journals(f.c)).toBe(0);
  });

  it('enforcement off, or the importer the sole approver: it posts, still as the system user', async () => {
    for (const f of [await fixture({ enforced: false }), await fixture({ members: [[a, 'admin'], [b, 'viewer']] })]) {
      const line = await importAs(a, f);
      expect(await lineStatus(pool, line)).toBe('provisional');
      const { rows: [run] } = await pool.query('SELECT created_by::TEXT AS by FROM bank_auto_post_runs WHERE company_id = $1', [f.c]);
      expect(run.by).toBe(NOBODY);
    }
  });
});

describe('the rule sweep runs for the session user', () => {
  const apply = async (user: string, f: BankCompany) => {
    const res = await callRoute(bankRulesAction as never, tokens[user]!, f.c, 'POST', { action: 'apply', bankAccountId: f.bank },
      '/api/accounting/bank-rules-action');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return dataOf<{ applied: number; autoPostSkippedApprovalRequired: number }>(res);
  };

  it('the importer\'s apply skips their own line (counted); another member\'s apply posts it', async () => {
    const f = await fixture();
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id,
         auto_create_entry, created_by) VALUES($1,'BC sweep','description','contains','BC line',$2,true,$3)`, [f.c, f.expA, a]);
    const line = await plantLine(pool, f, await plantBatch(pool, f, a));
    expect(await apply(a, f)).toMatchObject({ applied: 0, autoPostSkippedApprovalRequired: 1 });
    expect(await lineStatus(pool, line)).toBe('imported');
    expect(await apply(b, f)).toMatchObject({ applied: 1, autoPostSkippedApprovalRequired: 0 });
    expect(await lineStatus(pool, line)).toBe('allocated');
  });
});

describe('the categorisation sweep runs for the session user', () => {
  /** smart-categorize's own call — sweep(company, ids, 'categorization', session user) — inside withAuth. */
  const categorise = withAuth(async (req: CompanyAuthedRequest, res: NextApiResponse) => {
    res.status(200).json({ data: await sweep(req.companyId, req.body.ids as string[], 'categorization', req.user.id) });
  });
  const run = async (user: string, f: BankCompany, ids: string[]) => {
    const res = await callRoute(categorise as never, tokens[user]!, f.c, 'POST', { ids }, '/api/accounting/smart-categorize');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    return (res.state.body as { data: { posted: number; skipped: { txId: string; reason: string }[] } }).data;
  };

  it('the importer\'s own suggested line is skipped as approval_required; another member\'s sweep posts it', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, await plantBatch(pool, f, a), -300);
    await pool.query("UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1",
      [line, f.expA]);
    const mine = await run(a, f, [line]);
    expect(mine.posted).toBe(0);
    expect(mine.skipped).toEqual([{ txId: line, reason: expect.stringMatching(/^approval_required: You imported this bank statement/) }]);
    expect(await lineStatus(pool, line)).toBe('imported');
    expect((await run(b, f, [line])).posted).toBe(1);
    expect(await lineStatus(pool, line)).toBe('allocated');
  });
});
