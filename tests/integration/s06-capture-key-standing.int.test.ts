// tests/integration/s06-capture-key-standing.int.test.ts
//
// S-06 (audit 2026-10-18): a capture API key (`isa_live_…`) is a standing
// credential that bypasses withAuth. It must stop working (401 "Invalid or
// revoked API key") the moment its company is suspended or soft-deleted, or
// its creator stops being an owner, admin or manager of that company. The
// check runs at use time in validateCaptureApiKey, so each case below changes
// the row and presents the SAME key again.
//
// Real Postgres: the key lookup, the company-standing predicate and the
// membership read all run on the app's own `sql` pool, exactly as in
// production. Only object storage and the VLM router are mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import type { NextApiRequest, NextApiResponse } from 'next';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const BOUNDARY = 's06boundary';

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
type Res = NextApiResponse & { statusCode: number; body: unknown };
type Header = 'bearer' | 'x-api-key';

function mockRes(): Res {
  const res = { statusCode: 200, body: undefined, headersSent: false } as unknown as Res;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; }) as unknown as Res['status'];
  res.json = vi.fn((body: unknown) => { res.body = body; return res; }) as unknown as Res['json'];
  res.setHeader = vi.fn(() => res) as unknown as Res['setHeader'];
  res.end = vi.fn(() => res) as unknown as Res['end'];
  return res;
}

/** A real multipart/form-data body carrying one PDF, as a readable request. */
function uploadReq(rawKey: string, header: Header): NextApiRequest {
  const body = Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="s06.pdf"\r\n`
      + 'Content-Type: application/pdf\r\n\r\n'),
    PDF,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
  const auth = header === 'bearer' ? { authorization: `Bearer ${rawKey}` } : { 'x-api-key': rawKey };
  return Object.assign(Readable.from([body]), {
    method: 'POST',
    url: '/api/accounting/capture/upload',
    query: {},
    cookies: {},
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(body.length), ...auth },
  }) as unknown as NextApiRequest;
}

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

  async function seedMember(companyId: string, role: string): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await admin.query(`INSERT INTO users (id, email, is_active) VALUES ($1, $2, true)`, [id, `s06-${id}@test.local`]);
    await admin.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)`, [companyId, id, role]);
    return id;
  }

  async function issueKey(companyId: string, createdBy: string): Promise<{ raw: string; id: string }> {
    const { raw, hash, prefix } = generateCaptureApiKey();
    const { rows } = await admin.query(
      `INSERT INTO capture_api_keys (company_id, key_hash, key_prefix, label, created_by)
       VALUES ($1, $2, $3, 'S06 fixture', $4) RETURNING id`,
      [companyId, hash, prefix, createdBy],
    );
    return { raw, id: rows[0].id as string };
  }

  /** A company with a manager who has issued a key that, today, works. */
  async function workingKey() {
    const companyId = await seedCompany();
    const userId = await seedMember(companyId, 'manager');
    const key = await issueKey(companyId, userId);
    expect(await validateCaptureApiKey(key.raw)).toMatchObject({ companyId, keyId: key.id });
    // Let the accepted call's fire-and-forget stamp land before clearing it, so
    // a refusal below cannot be blamed for a stamp the acceptance wrote.
    await vi.waitFor(async () => expect(await lastUsedAt(key.id)).not.toBeNull());
    await admin.query('UPDATE capture_api_keys SET last_used_at = NULL WHERE id = $1', [key.id]);
    return { companyId, userId, ...key };
  }

  async function lastUsedAt(keyId: string): Promise<unknown> {
    const { rows } = await admin.query('SELECT last_used_at FROM capture_api_keys WHERE id = $1', [keyId]);
    return rows[0].last_used_at;
  }

  /** The key is refused by the validator AND by the route, on both key headers, and nothing is written. */
  async function expectRefused(key: { raw: string; id: string; companyId: string }) {
    warn.mockClear();
    expect(await validateCaptureApiKey(key.raw)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain(key.raw.slice(9));
    expect(logged).not.toContain(key.raw.slice(0, 16));

    for (const header of ['bearer', 'x-api-key'] as const) {
      const res = mockRes();
      await route(uploadReq(key.raw, header), res);
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.body)).toContain('Invalid or revoked API key');
    }
    expect(storeCapturedBytes).not.toHaveBeenCalled();
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM captured_documents WHERE company_id = $1', [key.companyId]);
    expect(rows[0].n).toBe(0);
    await new Promise((r) => setTimeout(r, 200)); // the accepted path's update is fire-and-forget
    expect(await lastUsedAt(key.id)).toBeNull();
  }

  it('a working key still uploads through the route, on both key headers', async () => {
    const key = await workingKey();
    for (const header of ['bearer', 'x-api-key'] as const) {
      const res = mockRes();
      await route(uploadReq(key.raw, header), res);
      expect(res.statusCode).toBe(201);
      const data = (res.body as { data: { documentIds: string[] } }).data;
      expect(data.documentIds).toHaveLength(1);
    }
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

  it('(1) is refused once its company is suspended', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE companies SET status = 'suspended', suspended_at = NOW() WHERE id = $1`, [key.companyId]);
    await expectRefused(key);
  });

  it('(2) is refused once its company is soft-deleted', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE companies SET status = 'deleted' WHERE id = $1`, [key.companyId]);
    await expectRefused(key);
  });

  it("(3) is refused once its creator's membership row is deleted", async () => {
    const key = await workingKey();
    await admin.query('DELETE FROM company_users WHERE company_id = $1 AND user_id = $2', [key.companyId, key.userId]);
    await expectRefused(key);
  });

  it('(4) is refused once its creator is demoted to viewer', async () => {
    const key = await workingKey();
    await admin.query(`UPDATE company_users SET role = 'viewer' WHERE company_id = $1 AND user_id = $2`, [key.companyId, key.userId]);
    await expectRefused(key);
  });

  it("(5) is refused when its creator is a manager of a different company, not the key's", async () => {
    const companyId = await seedCompany();
    const elsewhere = await seedCompany();
    const outsider = await seedMember(elsewhere, 'manager');
    const key = await issueKey(companyId, outsider);
    await expectRefused({ ...key, companyId });
  });

  it("(6) is refused once its creator's own account is suspended", async () => {
    const key = await workingKey();
    await admin.query('UPDATE users SET is_active = false, suspended_at = NOW() WHERE id = $1', [key.userId]);
    await expectRefused(key);
  });

  it('owner- and admin-issued keys still work; a revoked key is still refused', async () => {
    for (const role of ['owner', 'admin']) {
      const companyId = await seedCompany();
      const key = await issueKey(companyId, await seedMember(companyId, role));
      expect(await validateCaptureApiKey(key.raw)).toMatchObject({ companyId, keyId: key.id });
    }
    const key = await workingKey();
    await admin.query('UPDATE capture_api_keys SET is_active = false, revoked_at = NOW() WHERE id = $1', [key.id]);
    await expectRefused(key);
  });
});
