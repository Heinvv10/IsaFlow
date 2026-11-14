// Admin audit 2026-11-14, item 3.4 + #1370 review M1: the Sage target lock was
// UI-only. sage-commit took `companyId` and `pulled` straight from the body, so a
// crafted request could post any payload into any company. The pull now returns a
// token (HMAC over the company, a SHA-256 of each pulled section and the time) and
// the commit refuses (409) a token that is missing, forged, for another company,
// over a changed payload, or older than two hours.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import sageCommit from '../../pages/api/admin/migration/sage-commit';
import { issuePullToken, PULL_TOKEN_MAX_AGE_MS } from '@/modules/admin/services/sagePullBinding';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callAdmin, createAdmin, dropAdmin } from './wp11-admin-route.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companyA = randomUUID();
const companyB = randomUUID();
let admin = { id: '', token: '' };

const account = (code: string) => ({
  accountCode: code, accountName: `WP11 binding ${code}`, accountType: 'revenue', normalBalance: 'credit', category: 'Sales',
});
const pulledWith = (code: string) => ({ accounts: { step: 'accounts', total: 1, records: [account(code)] } });
const accountsIn = async (companyId: string, code: string) => Number((await pool.query(
  'SELECT count(*) AS n FROM gl_accounts WHERE company_id = $1 AND account_code = $2', [companyId, code])).rows[0].n);
const commit = (body: Record<string, unknown>) => callAdmin(sageCommit, admin.token, { body });

beforeAll(async () => {
  admin = await createAdmin(pool, 'wp11-sage-bind');
  await pool.query(`INSERT INTO companies (id, name, status) VALUES ($1, 'WP11 bind A', 'active'), ($2, 'WP11 bind B', 'active')`,
    [companyA, companyB]);
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))', [[companyA, companyB]]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[companyA, companyB]]);
    await dropAdmin(pool, admin.id);
  } finally { await pool.end(); }
});

describe('Sage commit is bound to what was pulled, for whom', () => {
  it('refuses a commit with no pull token, writing nothing', async () => {
    const r = await commit({ companyId: companyB, pulled: pulledWith('4901') });
    expect(r.status).toBe(409);
    expect(await accountsIn(companyB, '4901')).toBe(0);
  });

  it('refuses a forged pull token, writing nothing', async () => {
    const r = await commit({ companyId: companyB, pulled: pulledWith('4902'), pullToken: 'eyJ2IjoxfQ.deadbeef' });
    expect(r.status).toBe(409);
    expect(await accountsIn(companyB, '4902')).toBe(0);
  });

  it('refuses a token pulled for another company: the crafted commit to B gets 409', async () => {
    const pulled = pulledWith('4903');
    const r = await commit({ companyId: companyB, pulled, pullToken: issuePullToken(companyA, pulled) });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/different company/);
    expect(await accountsIn(companyB, '4903')).toBe(0);
    expect(await accountsIn(companyA, '4903')).toBe(0);
  });

  it('refuses a payload changed after the pull', async () => {
    const pullToken = issuePullToken(companyA, pulledWith('4904'));
    const r = await commit({ companyId: companyA, pulled: pulledWith('4905'), pullToken });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/not what was pulled \(accounts\)/);
    expect(await accountsIn(companyA, '4905')).toBe(0);
  });

  it('refuses a section the pull did not produce', async () => {
    const pulled = pulledWith('4906');
    const pullToken = issuePullToken(companyA, pulled);
    const r = await commit({ companyId: companyA, pulled: { ...pulled, bankTransactions: { bankAccountId: randomUUID(), records: [] } }, pullToken });
    expect(r.status).toBe(409);
    expect(await accountsIn(companyA, '4906')).toBe(0);
  });

  it('refuses a pull older than two hours', async () => {
    const pulled = pulledWith('4907');
    const pullToken = issuePullToken(companyA, pulled, Date.now() - PULL_TOKEN_MAX_AGE_MS - 60_000);
    const r = await commit({ companyId: companyA, pulled, pullToken });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/two hours/);
    expect(await accountsIn(companyA, '4907')).toBe(0);
  });

  it('commits the pulled data into the company it was pulled for, also a subset of its sections', async () => {
    const pulled = { ...pulledWith('4908'), customers: { step: 'customers', total: 0, records: [] } };
    const pullToken = issuePullToken(companyA, pulled);
    const r = await commit({ companyId: companyA, pulled: { accounts: pulled.accounts }, pullToken });
    expect(r.status).toBe(200);
    expect(await accountsIn(companyA, '4908')).toBe(1);
  });
});
