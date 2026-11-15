/**
 * WP2-1 round 2 (PR #1444 review LOWs).
 *  - bank-feeds POST and bank-feeds/extension-pair checked company + bank subtype but not is_active, so a feed could
 *    be connected to a deactivated bank account. Both now use bank/bankAccountGuard. extension-pair keeps its 404;
 *    the feeds POST answered an unknown account with a 500 (a bare Error) and now answers 400.
 *  - The guard holds the account FOR SHARE to the end of the request, so a deactivation or retype cannot land
 *    between its check and the request's write (FOR KEY SHARE would not block either UPDATE).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import feedsRoute from '../../pages/api/accounting/bank-feeds/index';
import pairRoute from '../../pages/api/accounting/bank-feeds/extension-pair';
import { assertBankAccountInCompany } from '../../src/modules/accounting/services/bank/bankAccountGuard';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { inRequest } from './r035-pr5.helpers';
import { cleanupGuardFixture, guardFixture, refusedIds, type GuardFixture } from './bank-account-guard.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let x: GuardFixture;

beforeAll(async () => {
  vi.stubEnv('EXTENSION_SIGNING_KEY', `bag-disposable-extension-signing-${crypto.randomUUID()}`);
  x = await guardFixture(pool);
});
afterAll(async () => { vi.unstubAllEnvs(); await cleanupGuardFixture(pool, x); });

type Result = { state: { statusCode: number; body: unknown } };
const connections = async () => Number((await pool.query(
  'SELECT count(*) AS n FROM bank_feed_connections WHERE company_id = ANY($1)', [x.companies])).rows[0].n);

const connect = (accountId: string) => callRoute(feedsRoute as never, x.tokens[x.user]!, x.f.c, 'POST',
  { provider: 'manual_csv', accountId }, '/api/accounting/bank-feeds');
const pair = (bankAccountId: string) => callRoute(pairRoute as never, x.tokens[x.user]!, x.f.c, 'POST',
  { bankId: 'absa', bankAccountId, externalAccountId: '40501234' }, '/api/accounting/bank-feeds/extension-pair');

async function expectRefused(call: (id: string) => Promise<Result>, status: number) {
  for (const [what, id] of refusedIds(x)) {
    const before = await connections();
    const res = await call(id);
    expect(res.state.statusCode, `${what}: ${JSON.stringify(res.state.body)}`).toBe(status);
    expect(await connections(), `${what} wrote a connection`).toBe(before);
  }
}

describe('bank-feeds POST: the bank a feed connection posts into', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 400, no connection', async () => {
    await expectRefused(connect, 400);
  });

  it('still connects a real bank account', async () => {
    const res = await connect(x.f.bank);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
  });
});

describe('bank-feeds/extension-pair: the bank the extension feeds', () => {
  it('refuses a revenue account, a foreign bank account and an inactive bank account: 404 as before, no connection', async () => {
    await expectRefused(pair, 404);
  });

  it('still pairs a real bank account', async () => {
    const res = await pair(x.f.bank2);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
  });
});

describe('the guard holds the account until the request ends', () => {
  for (const [what, change] of [
    ['a deactivation', 'UPDATE gl_accounts SET is_active = false WHERE id = $1'],
    ['a retype', "UPDATE gl_accounts SET account_subtype = 'current_asset' WHERE id = $1"],
  ] as const) {
    it(`${what} waits for a request that passed the guard, and lands once it ends`, async () => {
      // Its own account per case, so a change that lands under a mutant cannot leak into the next case.
      const bank = (await pool.query(
        `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
         VALUES ($1,$2,'BAG race','asset','debit',true,'bank') RETURNING id`, [x.f.c, `R${what.length}${x.f.c.slice(0, 6)}`],
      )).rows[0].id as string;
      const other = await pool.connect();
      try {
        await other.query("SET lock_timeout = '300ms'");
        await inRequest(pool, x.user, x.f.c, async () => {
          await assertBankAccountInCompany(x.f.c, bank);
          await expect(other.query(change, [bank])).rejects.toMatchObject({ code: '55P03' });
        });
        await other.query('BEGIN');
        await other.query(change, [bank]);
        await other.query('ROLLBACK');
      } finally {
        await other.query('RESET lock_timeout');
        other.release();
      }
    });
  }
});
