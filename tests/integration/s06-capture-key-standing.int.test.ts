// tests/integration/s06-capture-key-standing.int.test.ts
//
// S-06 (audit 2026-10-18): a capture API key (`isa_live_…`) is a standing
// credential that bypasses withAuth. It acts with its creator's CURRENT role
// in its company, and stops working (401 "Invalid or revoked API key") the
// moment the company is suspended or soft-deleted, or the creator stops being
// an owner, admin or manager there in good standing. A legacy key with no
// recorded creator keeps working as 'manager' (live integrations), with a
// warning on every use, but only while its company is live. The check runs at
// use time in validateCaptureApiKey, so each case changes the row and presents
// the SAME key again.
//
// Real Postgres: the key lookup, the company-standing predicate and the
// membership read all run on the app's own `sql` pool, exactly as in
// production. Only object storage and the VLM router are mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { mockRes, slowUploadReq, uploadReq } from './s06-capture-key-standing.helpers';

const { storeCapturedBytes, routeEvent } = vi.hoisted(() => ({
  storeCapturedBytes: vi.fn(),
  routeEvent: vi.fn(),
}));

vi.mock('@/lib/documentStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documentStorage')>()),
  storeCapturedBytes,
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent }));

const DATABASE_URL = process.env.DATABASE_URL;
const REAL_DB = !!DATABASE_URL && !DATABASE_URL.includes('dummy');
const describeIfDb = REAL_DB ? describe : describe.skip;

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Key = { raw: string; id: string; prefix: string; companyId: string };
const HEADERS = ['bearer', 'x-api-key'] as const;

describeIfDb('S-06: a capture API key answers for its company standing and its creator', () => {
  let admin: Pool;
  let route: Route;
  let validateCaptureApiKey: typeof import('@/lib/auth/captureApiKeyAuth').validateCaptureApiKey;
  let generateCaptureApiKey: typeof import('@/lib/auth/captureApiKeyAuth').generateCaptureApiKey;
  let warn: ReturnType<typeof vi.spyOn>;
  const companies: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    assertNotProductionDb('This suite inserts and deletes companies, users, memberships and capture keys.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    ({ validateCaptureApiKey, generateCaptureApiKey } = await import('@/lib/auth/captureApiKeyAuth'));
    route = (await import('../../pages/api/accounting/capture/upload')).default as unknown as Route;
    const { log } = await import('@/lib/logger');
    warn = vi.spyOn(log, 'warn');
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DELETE FROM capture_events WHERE company_id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM captured_documents WHERE company_id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM capture_api_keys WHERE company_id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
    await admin.end();
    const { getPoolForTests } = await import('@/lib/neon');
    await getPoolForTests().end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storeCapturedBytes.mockImplementation(async (companyId: string, documentId: string) => ({
      bucket: 'captured-documents', path: `${companyId}/${documentId}.pdf`,
    }));
    routeEvent.mockResolvedValue(undefined);
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    companies.push(id);
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [id, `S06 fixture ${id.slice(0, 8)}`]);
    return id;
  }

  /** A member of companyId; with `profile: false` the membership has no users row behind it. */
  async function seedMember(companyId: string, role: string, profile = true): Promise<string> {
    const id = randomUUID();
    users.push(id);
    if (profile) await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [id, `s06-${id}@test.local`]);
    await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)`, [companyId, id, role]);
    return id;
  }

  async function issueKey(companyId: string, createdBy: string | null): Promise<Key> {
    const { raw, hash, prefix } = generateCaptureApiKey();
    const { rows } = await admin.query(
      `INSERT INTO capture_api_keys (company_id, key_hash, key_prefix, label, created_by)
       VALUES ($1, $2, $3, 'S06 fixture', $4) RETURNING id`,
      [companyId, hash, prefix, createdBy],
    );
    return { raw, id: rows[0].id as string, prefix, companyId };
  }

  async function lastUsedAt(keyId: string): Promise<unknown> {
    const { rows } = await admin.query('SELECT last_used_at FROM capture_api_keys WHERE id = $1', [keyId]);
    return rows[0].last_used_at;
  }

  /** A key that, today, works: accepted, then its fire-and-forget stamp cleared. */
  async function working(key: Key, role: string): Promise<Key> {
    expect(await validateCaptureApiKey(key.raw)).toMatchObject({ companyId: key.companyId, keyId: key.id, role });
    // Let the acceptance's stamp land before clearing it, so a refusal below
    // cannot be blamed for a stamp the acceptance wrote.
    await vi.waitFor(async () => expect(await lastUsedAt(key.id)).not.toBeNull());
    await admin.query('UPDATE capture_api_keys SET last_used_at = NULL WHERE id = $1', [key.id]);
    return key;
  }

  /** A company with a manager who has issued a key that, today, works. */
  async function workingKey(): Promise<Key & { userId: string }> {
    const companyId = await seedCompany();
    const userId = await seedMember(companyId, 'manager');
    return { ...(await working(await issueKey(companyId, userId), 'manager')), userId };
  }

  /** Uploads on both key headers; each must answer 201 with companyRole `role` on the request. */
  async function expectUploads(key: Key, role: string) {
    for (const header of HEADERS) {
      const req = uploadReq(key.raw, header);
      const res = mockRes();
      await route(req, res);
      expect(res.statusCode).toBe(201);
      expect((res.body as { data: { documentIds: string[] } }).data.documentIds).toHaveLength(1);
      expect(req.companyRole).toBe(role);
    }
  }

  /** Refused by the validator (one warn naming `reason`) AND by the route on both headers; nothing written. */
  async function expectRefused(key: Key, reason: string) {
    warn.mockClear();
    expect(await validateCaptureApiKey(key.raw)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain(reason);
    expect(logged).not.toContain(key.raw.slice(9));
    expect(logged).not.toContain(key.prefix);

    for (const header of HEADERS) {
      const res = mockRes();
      await route(uploadReq(key.raw, header), res);
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.body)).toContain('Invalid or revoked API key');
    }
    expect(storeCapturedBytes).not.toHaveBeenCalled();
    expect(routeEvent).not.toHaveBeenCalled();
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM captured_documents WHERE company_id = $1', [key.companyId]);
    expect(rows[0].n).toBe(0);
    await new Promise((r) => setTimeout(r, 200)); // the accepted path's update is fire-and-forget
    expect(await lastUsedAt(key.id)).toBeNull();
  }

  it('a manager-issued key uploads through the route on both headers, acting as manager', async () => {
    const key = await workingKey();
    await expectUploads(key, 'manager');
    expect(storeCapturedBytes).toHaveBeenCalledTimes(2);
    expect(storeCapturedBytes.mock.calls[0]![0]).toBe(key.companyId);
    const { rows } = await admin.query(
      `SELECT d.uploaded_by, e.channel, e.sender FROM captured_documents d
         JOIN capture_events e ON e.captured_document_id = d.id
        WHERE d.company_id = $1`,
      [key.companyId],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toEqual({ uploaded_by: null, channel: 'api', sender: `api_key:${key.id}` });
    await vi.waitFor(async () => expect(await lastUsedAt(key.id)).not.toBeNull());
  });

  it.each(['owner', 'admin'])("(v) a key issued by an %s acts with that role", async (role) => {
    const companyId = await seedCompany();
    const key = await working(await issueKey(companyId, await seedMember(companyId, role)), role);
    await expectUploads(key, role);
  });

  it('(i) a legacy key with no creator still uploads as manager, warning with its id and prefix', async () => {
    const key = await working(await issueKey(await seedCompany(), null), 'manager');
    warn.mockClear();
    await expectUploads(key, 'manager');
    const legacy = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('legacy key with no creator'));
    expect(legacy).toHaveLength(4); // per upload: at auth, and the re-check before the first write
    for (const call of legacy) {
      expect(call[1]).toEqual({ keyId: key.id, keyPrefix: key.prefix });
      expect(JSON.stringify(call)).not.toContain(key.raw);
    }
  });

  it('(1) is refused once its company is suspended', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW() WHERE id = $1`, [key.companyId]);
    await expectRefused(key, 'company is suspended or deleted');
  });

  it('(2) is refused once its company is soft-deleted', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE companies SET status = 'deleted' WHERE id = $1`, [key.companyId]);
    await expectRefused(key, 'company is suspended or deleted');
  });

  it('(ii) a legacy no-creator key is refused once its company is suspended', async () => {
    const key = await working(await issueKey(await seedCompany(), null), 'manager');
    await admin.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW() WHERE id = $1`, [key.companyId]);
    await expectRefused(key, 'company is suspended or deleted');
  });

  it("(3) is refused once its creator's membership row is deleted", async () => {
    const key = await workingKey();
    await admin.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [key.companyId, key.userId]);
    await expectRefused(key, 'creator is not a member of the company');
  });

  it('(4) is refused once its creator is demoted to viewer', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [key.companyId, key.userId]);
    await expectRefused(key, 'creator is no longer an owner, admin or manager');
  });

  it("(5) is refused when its creator is a manager of a different company, not the key's", async () => {
    const companyId = await seedCompany();
    const outsider = await seedMember(await seedCompany(), 'manager');
    await expectRefused(await issueKey(companyId, outsider), 'creator is not a member of the company');
  });

  it("(6) is refused once its creator's own account is suspended", async () => {
    const key = await workingKey();
    await admin.query('UPDATE users SET is_active = false, suspended_at = NOW() WHERE id = $1', [key.userId]);
    await expectRefused(key, 'creator account is not in good standing');
  });

  it('(iii) is refused when its creator is a member with no users profile', async () => {
    const companyId = await seedCompany();
    await expectRefused(await issueKey(companyId, await seedMember(companyId, 'manager', false)), 'creator has no users profile');
  });

  it("(iv) is refused once its creator's users.status is anything but 'active'", async () => {
    const key = await workingKey();
    await admin.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [key.userId]);
    await expectRefused(key, 'creator account is not in good standing');
  });

  it('a key revoked_at but still is_active is refused', async () => {
    const key = await workingKey();
    await admin.query('UPDATE capture_api_keys SET revoked_at = NOW() WHERE id = $1', [key.id]);
    await expectRefused(key, 'invalid or revoked key presented');
  });

  it('standing lost while the body is still streaming: refused before the first write', async () => {
    const key = await workingKey();
    const { req, release } = slowUploadReq(key.raw);
    const res = mockRes();
    const done = route(req, res);
    await new Promise((r) => setTimeout(r, 300)); // key accepted, body still arriving
    await admin.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW() WHERE id = $1`, [key.companyId]);
    release();
    await done;
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM captured_documents WHERE company_id = $1', [key.companyId]);
    expect({ status: res.statusCode, docs: rows[0].n }).toEqual({ status: 401, docs: 0 });
    expect(JSON.stringify(res.body)).toContain('Invalid or revoked API key');
    expect(storeCapturedBytes).not.toHaveBeenCalled();
  });

  it('a creator demoted owner -> manager while the body streams: the write acts as manager', async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, 'owner');
    const key = await working(await issueKey(companyId, owner), 'owner');
    const { req, release } = slowUploadReq(key.raw);
    const res = mockRes();
    const done = route(req, res);
    await new Promise((r) => setTimeout(r, 300));
    await admin.query(`UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2`, [companyId, owner]);
    release();
    await done;
    expect({ status: res.statusCode, role: req.companyRole }).toEqual({ status: 201, role: 'manager' });
  });

  it('a revoked key is still refused', async () => {
    const key = await workingKey();
    await admin.query('UPDATE capture_api_keys SET is_active = false, revoked_at = NOW() WHERE id = $1', [key.id]);
    await expectRefused(key, 'invalid or revoked key presented');
  });
});
