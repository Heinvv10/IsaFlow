// tests/integration/s06b-extension-token-standing.int.test.ts
//
// S-06b (audit 2026-10-18, the gap #763 left): a bank-feed extension pairing
// token is a 90-day standing credential that bypasses withAuth. It acts with
// its pairer's CURRENT role and stops working (401 "Invalid or revoked pairing
// token") the moment the company is suspended or soft-deleted, or the pairer
// stops being an owner, admin or manager there with an account in good
// standing. Pairing (extension-pair.ts, withWriteAccess) admits the same three
// roles. The check runs in withExtensionToken before the handler, so a refused
// request writes nothing: no bank_transactions, no sync log, no import batch,
// no rate-limit charge, no connection stamp.
//
// Each case proves the SAME token imports first, changes one row, then
// presents the token again with a new batch.
//
// Real Postgres: the token wrapper's own pool, app_user + RLS, the
// membership read and ingestBankBatch all run exactly as in production.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { ingestReq, mockRes, type Res } from './s06b-extension-token-standing.helpers';

const DATABASE_URL = process.env.DATABASE_URL;
const REAL_DB = !!DATABASE_URL && !DATABASE_URL.includes('dummy');
const describeIfDb = REAL_DB ? describe : describe.skip;

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Paired = { companyId: string; userId: string; connectionId: string; token: string };

describeIfDb('S-06b: an extension pairing token answers for its company standing and its pairer', () => {
  let admin: Pool;
  let route: Route;
  let sign: typeof import('@/lib/auth/extensionJwt').signExtensionToken;
  let warn: ReturnType<typeof vi.spyOn>;
  const savedKey = process.env.EXTENSION_SIGNING_KEY;
  const companies: string[] = [];
  const users: string[] = [];
  let batchNo = 0;

  beforeAll(async () => {
    assertNotProductionDb('This suite inserts and deletes companies, users, memberships and bank-feed rows.');
    process.env.EXTENSION_SIGNING_KEY = randomUUID() + randomUUID(); // random per run, ≥32 chars
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    ({ signExtensionToken: sign } = await import('@/lib/auth/extensionJwt'));
    route = (await import('../../pages/api/accounting/bank-feeds/[id]/extension-ingest')).default as unknown as Route;
    const { log } = await import('@/lib/logger');
    warn = vi.spyOn(log, 'warn');
  }, 60000);

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.EXTENSION_SIGNING_KEY;
    else process.env.EXTENSION_SIGNING_KEY = savedKey;
    if (!admin) return;
    for (const t of ['bank_transactions', 'bank_import_batches', 'bank_feed_sync_logs', 'bank_feed_connections', 'gl_accounts']) {
      await admin.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [companies]);
    }
    await admin.query('DELETE FROM rate_limit_counters WHERE key = ANY($1::text[])', [companies.map((c) => `extension-ingest:${c}`)]);
    await admin.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
    await admin.end();
    const { getPoolForTests } = await import('@/lib/neon');
    await getPoolForTests().end();
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    companies.push(id);
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [id, `S06b fixture ${id.slice(0, 8)}`]);
    return id;
  }

  async function seedUser(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [id, `s06b-${id}@test.local`]);
    return id;
  }

  async function join(companyId: string, userId: string, role: string): Promise<void> {
    await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)`, [companyId, userId, role]);
  }

  async function seedConnection(companyId: string, userId: string): Promise<string> {
    const bank = randomUUID();
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, account_subtype, is_active)
       VALUES ($1, $2, '1110', 'S06b Bank', 'asset', 'debit', 'bank', true)`, [bank, companyId]);
    const { rows } = await admin.query(
      `INSERT INTO bank_feed_connections (company_id, bank_account_id, provider, status, is_active, config, created_by)
       VALUES ($1, $2, 'extension', 'active', true, '{"bankId":"absa"}', $3::uuid) RETURNING id`, [companyId, bank, userId]);
    return rows[0].id as string;
  }

  async function pair(companyId: string, userId: string, connectionId: string): Promise<Paired> {
    const token = await sign({ userId, companyId, connectionId, bankId: 'absa', scope: 'bank-feed-ingest' });
    return { companyId, userId, connectionId, token };
  }

  /** A company whose `role` pairer holds a token that imports today. */
  async function paired(role = 'manager'): Promise<Paired> {
    const companyId = await seedCompany();
    const userId = await seedUser();
    await join(companyId, userId, role);
    const p = await pair(companyId, userId, await seedConnection(companyId, userId));
    await expectImports(p);
    return p;
  }

  async function send(p: Paired): Promise<Res> {
    batchNo += 1;
    const res = mockRes();
    await route(ingestReq(p.token, p.connectionId, `S06B BATCH ${batchNo}`), res);
    return res;
  }

  /** Every row an ingest writes for the company, and the connection's stamp. */
  async function footprint(p: Paired) {
    const n = async (q: string, v: unknown) => (await admin.query(q, [v])).rows[0].n as number;
    return {
      tx: await n('SELECT count(*)::int AS n FROM bank_transactions WHERE company_id = $1', p.companyId),
      logs: await n('SELECT count(*)::int AS n FROM bank_feed_sync_logs WHERE company_id = $1', p.companyId),
      batches: await n('SELECT count(*)::int AS n FROM bank_import_batches WHERE company_id = $1', p.companyId),
      rate: await n('SELECT COALESCE(sum(count), 0)::int AS n FROM rate_limit_counters WHERE key = $1', `extension-ingest:${p.companyId}`),
      stamp: String((await admin.query('SELECT updated_at FROM bank_feed_connections WHERE id = $1', [p.connectionId])).rows[0].updated_at),
    };
  }

  async function expectImports(p: Paired): Promise<void> {
    const before = await footprint(p);
    const res = await send(p);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { data: { imported: number } }).data.imported).toBe(1);
    const after = await footprint(p);
    expect(after.tx).toBe(before.tx + 1);
    expect(after.logs).toBe(before.logs + 1);
    expect(after.rate).toBe(before.rate + 1);
  }

  /** 401, one warn naming `reason` and never the token, and not one row written. */
  async function expectRefused(p: Paired, reason: string): Promise<void> {
    const before = await footprint(p);
    warn.mockClear();
    const res = await send(p);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(401);
    expect(res.body).toEqual({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or revoked pairing token' } });
    const refusals = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('token refused'));
    expect(refusals).toHaveLength(1);
    expect(JSON.stringify(refusals[0])).toContain(reason);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(p.token);
    expect(await footprint(p)).toEqual(before);
  }

  it.each(['owner', 'admin', 'manager'])('a token paired by an %s imports, and keeps importing', async (role) => {
    const p = await paired(role);
    await expectImports(p);
  });

  it('(1) is refused once its company is suspended', async () => {
    const p = await paired();
    await admin.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW() WHERE id = $1`, [p.companyId]);
    await expectRefused(p, 'pairer is not a member of a live company');
  });

  it('(2) is refused once its company is soft-deleted', async () => {
    const p = await paired();
    await admin.query(`UPDATE companies SET status = 'deleted' WHERE id = $1`, [p.companyId]);
    await expectRefused(p, 'pairer is not a member of a live company');
  });

  it.each(['viewer', 'storeman'])('(3) is refused once its pairer is demoted to %s', async (role) => {
    const p = await paired('admin');
    await admin.query('UPDATE company_users SET role = $3 WHERE company_id = $1 AND user_id = $2', [p.companyId, p.userId, role]);
    await expectRefused(p, 'pairer is no longer an owner, admin or manager');
  });

  it("(4) is refused once its pairer's membership is deleted", async () => {
    const p = await paired();
    await admin.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [p.companyId, p.userId]);
    await expectRefused(p, 'pairer is not a member of a live company');
  });

  it('(5) is refused when its pairer leaves and re-joins as a viewer', async () => {
    const p = await paired('owner');
    await admin.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [p.companyId, p.userId]);
    await join(p.companyId, p.userId, 'viewer');
    await expectRefused(p, 'pairer is no longer an owner, admin or manager');
  });

  it("(6) is refused once its pairer's account is deactivated", async () => {
    const p = await paired();
    await admin.query('UPDATE users SET is_active = false WHERE id = $1', [p.userId]);
    await expectRefused(p, 'pairer account is not in good standing');
  });

  it("(7) is refused once its pairer's account is suspended or disabled", async () => {
    const p = await paired();
    await admin.query('UPDATE users SET suspended_at = NOW() WHERE id = $1', [p.userId]);
    await expectRefused(p, 'pairer account is not in good standing');
    await admin.query(`UPDATE users SET suspended_at = NULL, status = 'disabled' WHERE id = $1`, [p.userId]);
    await expectRefused(p, 'pairer account is not in good standing');
  });

  it('(8) is refused when its pairer has no users row behind the membership', async () => {
    const p = await paired();
    await admin.query('DELETE FROM users WHERE id = $1', [p.userId]);
    await expectRefused(p, 'pairer has no users profile');
  });

  it('works again once its pairer is restored to a write role (the 401 revokes nothing)', async () => {
    const p = await paired();
    await admin.query(`UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [p.companyId, p.userId]);
    await expectRefused(p, 'pairer is no longer an owner, admin or manager');
    await admin.query(`UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2`, [p.companyId, p.userId]);
    const { rows } = await admin.query('SELECT is_active FROM bank_feed_connections WHERE id = $1', [p.connectionId]);
    expect(rows[0].is_active).toBe(true);
    await expectImports(p);
  });

  it("a token whose company is not its connection's writes nothing in either company", async () => {
    // The pairer owns both companies, so RLS shows them B's connection.
    const a = await paired('owner');
    const b = await seedCompany();
    await join(b, a.userId, 'owner');
    const foreign = await pair(a.companyId, a.userId, await seedConnection(b, a.userId));
    const inB = { ...foreign, companyId: b };
    const [beforeA, beforeB] = [await footprint(a), await footprint(inB)];
    const res = await send(foreign);
    expect(res.statusCode).toBe(403);
    expect(await footprint(inB)).toEqual(beforeB);
    expect((await footprint(a)).tx).toBe(beforeA.tx);
  });
});
