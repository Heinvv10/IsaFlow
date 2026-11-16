/**
 * Audit WP2 row 9 — bank-rules-seed, bank-rules-action and bank-auto-post answered every unrecognised throw 4xx
 * (raw message, or badRequestFromError's generic one). A 4xx COMMITs the request (withAuth), so a crash after the
 * rules or the settings were written committed them. Now only the typed refusals keep their 4xx; anything else is a
 * 500 and rolls back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

vi.mock('@/lib/logger', async (orig) => (await import('./bank-catchall.helpers')).loggerWithFault(await orig()));
vi.mock('@/lib/neon', async (orig) => (await import('./bank-catchall.helpers')).neonWithFault(await orig()));

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { bankCompany, cleanupBankControlsA, refusalOf, type BankCompany } from './bank-controls-a.helpers';
import { faults, resetFaults } from './bank-catchall.helpers';
import rulesSeed from '../../pages/api/accounting/bank-rules-seed';
import rulesAction from '../../pages/api/accounting/bank-rules-action';
import autoPost from '../../pages/api/accounting/bank-auto-post';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let f: BankCompany;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  f = await bankCompany(pool, [[a, 'admin']], companies);
});
beforeEach(() => resetFaults());
afterAll(async () => {
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a]); // ends the pool
});

const call = (handler: unknown, method: string, body: unknown, url: string) =>
  callRoute(handler as never, tokens[a]!, f.c, method, body, url);
const rulesNamed = async (pattern: string) => (await pool.query(
  'SELECT id FROM bank_categorisation_rules WHERE company_id = $1 AND match_pattern = $2', [f.c, pattern])).rows as { id: string }[];

describe('bank-rules-seed: a crash after the rules are written is a 500 and rolls back', () => {
  it('the rules were created, then a TypeError — 500, and no rule is left', async () => {
    const glCode = String((await pool.query('SELECT account_code FROM gl_accounts WHERE id = $1', [f.expA])).rows[0].account_code);
    faults.afterLog = 'Seeded bank categorisation rules';
    const res = await call(rulesSeed, 'POST', { entries: [{ originalCategory: 'CATCHALL FUEL', glCode }] },
      '/api/accounting/bank-rules-seed');
    expect(faults.fired).toHaveLength(1);
    // The seed stores the category lower-cased as the pattern.
    expect({ status: res.state.statusCode, rules: await rulesNamed('catchall fuel') }).toEqual({ status: 500, rules: [] });
  });
});

describe('bank-rules-action: a crash after the write is a 500 and rolls back', () => {
  it('delete: the DELETE ran, then a TypeError — 500, and the rule is still there', async () => {
    const rule = (await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, gl_account_id, created_by)
       VALUES($1,'Catch-all rule','description','contains','CATCHALL DEL',$2,$3) RETURNING id`, [f.c, f.expA, a])).rows[0].id as string;
    faults.afterSql = /DELETE FROM bank_categorisation_rules/;
    const res = await call(rulesAction, 'POST', { action: 'delete', id: rule }, '/api/accounting/bank-rules-action');
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, rules: await rulesNamed('CATCHALL DEL') }).toEqual({ status: 500, rules: [{ id: rule }] });
  });

  it('a rule that is not there is still a refusal: 404', async () => {
    const res = refusalOf(await call(rulesAction, 'POST', { action: 'update', id: crypto.randomUUID(), ruleName: 'x' },
      '/api/accounting/bank-rules-action'));
    expect(res.status).toBe(404);
  });
});

describe('bank-auto-post: a crash after the write is a 500 and rolls back; typed refusals keep their 4xx', () => {
  const settings = async () => (await pool.query(
    'SELECT min_confidence::TEXT AS c FROM bank_auto_post_settings WHERE company_id = $1', [f.c])).rows as { c: string }[];

  it('PUT: the settings were written, then a TypeError — 500, and nothing is saved', async () => {
    faults.afterLog = 'Updated auto-post settings';
    const res = await call(autoPost, 'PUT', { minConfidence: 0.99 }, '/api/accounting/bank-auto-post');
    expect(faults.fired).toHaveLength(1);
    expect({ status: res.state.statusCode, settings: await settings() }).toEqual({ status: 500, settings: [] });
  });

  it('PUT out of range is 400; undo of an unknown run is 404 and of an undone run 409', async () => {
    expect(refusalOf(await call(autoPost, 'PUT', { minConfidence: 1.5 }, '/api/accounting/bank-auto-post')).status).toBe(400);
    const undo = (runId: string) => call(autoPost, 'POST', { action: 'undo', runId }, '/api/accounting/bank-auto-post');
    expect(refusalOf(await undo(crypto.randomUUID())).status).toBe(404);
    const run = (await pool.query(
      `INSERT INTO bank_auto_post_runs(company_id, source, min_confidence, amount_cap, posted_count, created_by, undone_at)
       VALUES($1,'categorization',0.9,0,0,$2,now()) RETURNING id`, [f.c, a])).rows[0].id as string;
    expect(refusalOf(await undo(run)).status).toBe(409);
  });
});
