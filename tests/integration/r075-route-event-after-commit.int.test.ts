/**
 * R-075 — the cookie-session capture upload fire-and-forgot routeEvent. Its
 * statements went through the request's ALS client after withAuth had COMMITted
 * and released it, so they ran inside the NEXT request's transaction under that
 * request's claims (the event stuck in 'extracting', or the other request 500'd
 * and rolled back), autocommitted as the pool's role, or died on a reaped
 * client. See docs/audits/remediation/R-075/fix.md.
 *
 * Drives the real upload route through the real withAuth; only storage and the
 * VLM boundary are replaced. The VLM is gated so a concurrent request can hold
 * its transaction open across the moment routeEvent writes.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import {
  PNG, concurrentRequest, deferred, installWriteLog, removeWriteLog, response, uploadReq, waitFor,
} from './r075-route-event.helpers';

const vlm = { gated: false, started: deferred<void>(), gate: deferred<void>() };
const storage = { failOnCall: 0, calls: 0 };

vi.mock('@/lib/supabaseStorage', () => ({
  CAPTURED_DOCS_BUCKET: 'captured-documents',
  uploadCapturedDocument: async (companyId: string, documentId: string) => {
    storage.calls += 1;
    if (storage.calls === storage.failOnCall) throw new Error('storage outage (fixture)');
    return { bucket: 'captured-documents', path: `${companyId}/${documentId}` };
  },
  downloadCapturedDocument: async () => Buffer.from(PNG),
  getStorageClient: () => { throw new Error('storage client not available in fixture'); },
}));

const EXTRACTED = { vendorName: 'R075 Vendor', referenceNumber: 'R075', vendorVatNumber: '4000000000',
  totalAmount: 115, vatAmount: 15, date: '2026-09-01', lineItems: [], confidence: 0.9 };
vi.mock('@/modules/accounting/services/core/ocrService', () => ({
  extractFromText: async () => { throw new Error('text not used'); },
  extractFromPdf: async () => EXTRACTED,
  extractFromImage: async () => {
    vlm.started.resolve();
    if (vlm.gated) await vlm.gate.promise;
    return EXTRACTED;
  },
}));

// Same function, observable: a rolled-back upload must never reach it.
vi.mock('@/modules/accounting/services/capture/captureRouterService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/capture/captureRouterService')>();
  return { ...real, routeEvent: vi.fn(real.routeEvent) };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const coA = crypto.randomUUID(), coB = crypto.randomUUID();
let token = '';
const INBOX = `r075-${crypto.randomUUID()}@inbox.isaflow.co.za`;
const API_KEY = `isa_live_r075${crypto.randomUUID().replace(/-/g, '')}`;

beforeAll(async () => {
  await pool.query("INSERT INTO users (id,email,role,is_active) VALUES ($1,$2,'admin',true)", [user, `r075-${user}@test.local`]);
  await pool.query('INSERT INTO companies (id,name) VALUES ($1,$2),($3,$4)', [coA, 'R075 A', coB, 'R075 B']);
  // One user acting for two companies: the bureau shape under which the stray
  // write failed WITH CHECK and aborted the other company's request.
  await pool.query("INSERT INTO company_users (company_id,user_id,role) VALUES ($1,$3,'admin'),($2,$3,'admin')", [coA, coB, user]);
  await pool.query("INSERT INTO capture_inboxes (company_id,channel,address) VALUES ($1,'email',$2)", [coA, INBOX]);
  await pool.query("INSERT INTO capture_api_keys (company_id,key_hash,key_prefix,label) VALUES ($1,$2,$3,'R075 fixture')",
    [coA, createHash('sha256').update(API_KEY).digest('hex'), API_KEY.slice(0, 16)]);
  token = await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET!));
  await installWriteLog(pool, [coA, coB]);
});

afterAll(async () => {
  try {
    await removeWriteLog(pool);
    for (const t of ['capture_events', 'captured_documents', 'capture_inboxes', 'capture_api_keys', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[coA, coB]]);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[coA, coB]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
  } finally {
    await pool.end();
    const { getAuthPool } = await import('@/lib/auth/authPool');
    await getAuthPool().end().catch(() => undefined);
  }
});

async function upload(req: Record<string, unknown>) {
  const route = (await import('../../pages/api/accounting/capture/upload')).default;
  const res = response();
  await route(req as never, res as never);
  return { status: res.statusCode, body: res.body as { data?: { eventIds: string[]; documentIds: string[] } } };
}

async function settled(eventId: string) {
  let status = '';
  await waitFor(async () => {
    status = (await pool.query('SELECT status FROM capture_events WHERE id=$1', [eventId])).rows[0]?.status ?? '';
    return status === 'extracted' || status === 'failed';
  }, 15000);
  return status;
}

it('routeEvent writes on its own connection after COMMIT; a concurrent request for another company is untouched', async () => {
  vlm.gated = true; vlm.started = deferred(); vlm.gate = deferred();
  const a = await upload(uploadReq({ token, company: coA }));
  expect(a.status).toBe(201);
  const eventId = a.body.data!.eventIds[0]!, documentId = a.body.data!.documentIds[0]!;
  await vlm.started.promise;
  // B takes the connection A's request just released, and holds its tx open
  // while routeEvent finishes.
  const b = await concurrentRequest(pool, token, coB);
  vlm.gate.resolve();
  const status = await settled(eventId);
  const bRes = await b.finish();

  expect(bRes).toMatchObject({ status: 200, markerPersisted: true });
  expect(bRes.error).toBeUndefined();
  expect(status).toBe('extracted');
  const doc = (await pool.query('SELECT vendor_name FROM captured_documents WHERE id=$1', [documentId])).rows[0];
  expect(doc.vendor_name).toBe('R075 Vendor');

  const writes = (await pool.query('SELECT * FROM r075_write_log WHERE row_id = ANY($1::uuid[]) ORDER BY id',
    [[eventId, documentId]])).rows;
  // First the request's own storage-path UPDATE, in its own transaction as
  // app_user for A. Then routeEvent's three writes, none of them in B's
  // transaction or backend, and none under B's company GUC.
  expect(writes.map((w) => w.new_status)).toEqual(['pending', 'extracting', 'pending', 'extracted']);
  expect(writes[0]).toMatchObject({ role: 'app_user', company: coA });
  for (const w of writes.slice(1)) {
    expect(w.txid).not.toBe(bRes.txid);
    expect(w.txid).not.toBe(writes[0].txid);
    expect(w.pid).not.toBe(bRes.pid);
    expect(w.company).not.toBe(coB);
  }
}, 30000);

it('a rolled-back upload never starts routeEvent', async () => {
  const { routeEvent } = await import('@/modules/accounting/services/capture/captureRouterService');
  vi.mocked(routeEvent).mockClear();
  vlm.gated = false;
  const before = (await pool.query('SELECT count(*)::int AS n FROM capture_events WHERE company_id=$1', [coA])).rows[0].n;
  // File 1 is inserted and queued; file 2's storage write throws, the route
  // answers 500 and withAuth rolls the whole request back.
  storage.calls = 0; storage.failOnCall = 2;
  const res = await upload(uploadReq({ token, company: coA }, 2));
  storage.failOnCall = 0;
  expect(res.status).toBe(500);
  await new Promise((r) => setTimeout(r, 500));
  expect(routeEvent).not.toHaveBeenCalled();
  const after = (await pool.query('SELECT count(*)::int AS n FROM capture_events WHERE company_id=$1', [coA])).rows[0].n;
  expect(after).toBe(before);
}, 30000);

it('the API-key upload (no request transaction) still extracts', async () => {
  vlm.gated = false;
  const res = await upload(uploadReq({ apiKey: API_KEY }));
  expect(res.status).toBe(201);
  expect(await settled(res.body.data!.eventIds[0]!)).toBe('extracted');
}, 30000);

it('the Postmark inbound-email webhook still extracts', async () => {
  process.env.POSTMARK_INBOUND_TOKEN = 'r075-postmark-fixture-token';
  const route = (await import('../../pages/api/accounting/capture/inbound-email')).default;
  const res = response();
  await route({
    method: 'POST', url: '/api/accounting/capture/inbound-email', query: {}, cookies: {},
    headers: { 'x-postmark-token': 'r075-postmark-fixture-token' },
    body: { To: INBOX, From: 'supplier@example.test', Subject: 'R075', Attachments: [{
      Name: 'r075.pdf', ContentType: 'application/pdf',
      Content: Buffer.from('%PDF-1.4 r075 fixture').toString('base64'), ContentLength: 21,
    }] },
  } as never, res as never);
  expect(res.statusCode).toBe(200);
  const ids = (res.body as { data: { captureEventIds: string[] } }).data.captureEventIds;
  expect(ids).toHaveLength(1);
  expect(await settled(ids[0]!)).toBe('extracted');
}, 30000);
