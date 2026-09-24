/**
 * K-160 RED — a Twilio webhook retry re-ingests the same WhatsApp document.
 *
 * ingestTwilioPayload (whatsAppInboundService.ts:72) never checks
 * payload.MessageSid against anything already ingested; the route
 * (pages/api/accounting/capture/inbound/whatsapp.ts:112) does not either, and
 * neither captured_documents nor capture_events carries a unique constraint on
 * the Twilio message id or on the file hash. Twilio retries any non-2xx or
 * timed-out delivery, so a retry duplicates the captured document, the capture
 * event and the downstream VLM extraction.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/modules/accounting/services/capture/twilioMediaFetch', () => ({
  fetchTwilioMedia: vi.fn(async () => ({
    buffer: Buffer.from('%PDF-1.4 k160 disposable invoice'),
    contentType: 'application/pdf',
  })),
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({
  routeEvent: vi.fn(async () => undefined),
}));
vi.mock('@/lib/documentStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documentStorage')>();
  return {
    ...actual,
    storeCapturedBytes: vi.fn(async (_c: string, docId: string) => ({
      bucket: 'k160-disposable',
      path: `k160/${docId}.pdf`,
    })),
  };
});

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const inbox = crypto.randomUUID();
const NUMBER = '+27000000160';
const TOKEN_HASH = `k160-${crypto.randomUUID()}`;
const SID = 'SMk160disposableretrytest0000000001';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K160 fixture']);
  await pool.query(
    `INSERT INTO capture_inboxes(id,company_id,channel,address,is_active,webhook_token_hash,provider_verified_at)
     VALUES($1,$2,'whatsapp',$3,true,$4,NOW())`,
    [inbox, company, NUMBER, TOKEN_HASH],
  );
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM capture_events WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM captured_documents WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM capture_inboxes WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
  } finally {
    await pool.end();
  }
});

it('ingests a retried Twilio delivery exactly once', async () => {
  const { ingestTwilioPayload } = await import(
    '../../src/modules/accounting/services/capture/whatsAppInboundService'
  );
  const payload = {
    From: 'whatsapp:+27000000161',
    To: `whatsapp:${NUMBER}`,
    MessageSid: SID,
    NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/disposable/k160',
    MediaContentType0: 'application/pdf',
  };
  const binding = { companyId: company, inboxId: inbox, tokenHash: TOKEN_HASH };

  const first = await ingestTwilioPayload(payload, binding);
  // Twilio redelivers the identical payload after a timeout / 5xx.
  const retry = await ingestTwilioPayload(payload, binding);

  const docs = await pool.query(
    'SELECT id FROM captured_documents WHERE company_id=$1 AND file_name LIKE $2',
    [company, `whatsapp_${SID}_%`],
  );
  const events = await pool.query(
    'SELECT id FROM capture_events WHERE company_id=$1 AND subject=$2',
    [company, SID],
  );

  expect(docs.rowCount).toBe(1);
  expect(events.rowCount).toBe(1);
  expect('captureEventIds' in first && first.captureEventIds).toHaveLength(1);
  expect('captureEventIds' in retry && retry.captureEventIds).toHaveLength(0);
});
