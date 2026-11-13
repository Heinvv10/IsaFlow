// tests/integration/bank-feed-extension-revoke.int.test.ts
//
// #1285 follow-up: Statement Imports lists a company's paired browser-extension
// connections and revokes one. The screen calls the existing routes, so this
// proves them end to end on the production logins (s07b helpers): a pairing
// made through extension-pair imports, GET lists it for its own company only,
// DELETE revokes it so extension-ingest refuses the same token and writes
// nothing, and a DELETE from another company changes nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pairRoute from '../../pages/api/accounting/bank-feeds/extension-pair';
import listRoute from '../../pages/api/accounting/bank-feeds/index';
import connectionRoute from '../../pages/api/accounting/bank-feeds/[id]';
import ingestRoute from '../../pages/api/accounting/bank-feeds/[id]/extension-ingest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { ingestReq, mockRes } from './s06b-extension-token-standing.helpers';

const ids = newIds();
// me is an admin of company; owner owns company and (seeded below) other.
const { me, owner, company, other } = ids;
const bank: Record<string, string> = {};
let batchNo = 0;

type Paired = { companyId: string; connectionId: string; jwt: string };
type Listed = { id: string; companyId: string; provider: string };

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('EXTENSION_SIGNING_KEY', crypto.randomUUID() + crypto.randomUUID());
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [other, owner]);
  for (const co of [company, other]) {
    bank[co] = (await fixture.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type,
      account_subtype, normal_balance, level) VALUES ($1, 'REVOKE-BANK', 'Revoke bank', 'asset', 'bank', 'debit', 3)
      RETURNING id`, [co])).rows[0].id as string;
  }
}, 60000);

afterAll(async () => {
  const companies = [company, other];
  for (const t of ['bank_transactions', 'bank_import_batches', 'bank_feed_sync_logs', 'bank_feed_connections', 'gl_accounts']) {
    await fixture.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [companies]);
  }
  await fixture.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::text[])',
    [companies.map((c) => `extension-ingest:${c}`)]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});

async function pair(sub: string, companyId: string): Promise<Paired> {
  const r = await callRoute(pairRoute, { sub, method: 'POST', companyId,
    body: { bankId: 'absa', bankAccountId: bank[companyId], externalAccountId: '4051234567' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const { connectionId, jwt } = (r.body as { data: { connectionId: string; jwt: string } }).data;
  return { companyId, connectionId, jwt };
}

async function ingest(p: Paired): Promise<{ status: number; body: unknown }> {
  batchNo += 1;
  const res = mockRes();
  await (ingestRoute as unknown as (q: unknown, s: unknown) => Promise<unknown>)(
    ingestReq(p.jwt, p.connectionId, `REVOKE BATCH ${batchNo}`), res);
  return { status: res.statusCode, body: res.body };
}

async function list(sub: string, companyId: string): Promise<Listed[]> {
  const r = await callRoute(listRoute, { sub, method: 'GET', companyId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { data: { items: Listed[] } }).data.items;
}

const revoke = (sub: string, companyId: string, id: string) =>
  callRoute(connectionRoute, { sub, method: 'DELETE', companyId, query: { id } });

const txCount = async (companyId: string): Promise<number> =>
  (await fixture.query('SELECT count(*)::int AS n FROM bank_transactions WHERE company_id = $1', [companyId])).rows[0].n as number;

const connectionRow = async (id: string) =>
  (await fixture.query('SELECT company_id, is_active, status FROM bank_feed_connections WHERE id = $1', [id])).rows[0];

describe('#1285 follow-up: revoke a paired browser-extension connection', () => {
  it('a revoked connection drops off the list and its token is refused, writing nothing', async () => {
    const p = await pair(me, company);
    expect((await ingest(p)).status).toBe(200);
    expect((await list(me, company)).map((c) => c.id)).toContain(p.connectionId);

    const revoked = await revoke(me, company, p.connectionId);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(await connectionRow(p.connectionId)).toEqual({ company_id: company, is_active: false, status: 'disconnected' });
    expect((await list(me, company)).map((c) => c.id)).not.toContain(p.connectionId);

    const before = await txCount(company);
    const refused = await ingest(p);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({ success: false, error: { code: 'CONNECTION_INACTIVE' } });
    expect(await txCount(company)).toBe(before);
  });

  it('re-pairing after a revoke makes a new connection; the revoked token stays refused', async () => {
    const first = await pair(me, company);
    expect((await revoke(me, company, first.connectionId)).status).toBe(200);
    const second = await pair(me, company);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect((await ingest(second)).status).toBe(200);
    expect((await ingest(first)).status).toBe(403);
  });

  it("a revoke sent from another company leaves the connection active and its token working", async () => {
    const p = await pair(me, company);
    // owner is an owner of both companies, acting in `other`.
    const foreign = await revoke(owner, other, p.connectionId);
    expect(foreign.status).toBeLessThan(500);
    expect(await connectionRow(p.connectionId)).toEqual({ company_id: company, is_active: true, status: 'active' });
    expect((await list(me, company)).map((c) => c.id)).toContain(p.connectionId);
    expect((await ingest(p)).status).toBe(200);
  });

  it("each company's list holds only its own connections", async () => {
    const mine = await pair(me, company);
    const theirs = await pair(owner, other);
    const ownList = await list(me, company);
    const otherList = await list(owner, other);
    expect(ownList.map((c) => c.id)).toContain(mine.connectionId);
    expect(ownList.map((c) => c.id)).not.toContain(theirs.connectionId);
    expect(ownList.every((c) => c.companyId === company)).toBe(true);
    expect(otherList.map((c) => c.id)).toContain(theirs.connectionId);
    expect(otherList.every((c) => c.companyId === other)).toBe(true);
  });
});
