/**
 * K-160 — two deliveries of one Twilio message in flight at once, and a retry
 * after a partial ingest.
 *
 * The race is made deterministic by a barrier in findOpenQuery, which runs
 * after the already-ingested lookup: both deliveries have seen "nothing
 * ingested" before either inserts, so only the unique index (migration 842)
 * can keep the second copy out.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const { fetchMock, barrier } = vi.hoisted(() => {
  const barrier = { parties: 0, arrived: 0, release: () => {}, open: Promise.resolve() };
  const fetchMock = vi.fn(async (url: string) => ({
    buffer: Buffer.from(`%PDF-1.4 k160 race ${url}`),
    contentType: 'application/pdf',
  }));
  return { fetchMock, barrier };
});

vi.mock('@/modules/accounting/services/capture/twilioMediaFetch', () => ({
  fetchTwilioMedia: (url: string) => fetchMock(url),
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({
  routeEvent: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/capture/bankTxQueryReplyService', () => ({
  findOpenQuery: vi.fn(async () => {
    barrier.arrived += 1;
    if (barrier.arrived >= barrier.parties) barrier.release();
    await barrier.open;
    return null;
  }),
  attachReplyMedia: vi.fn(async () => true),
  markQueryReplied: vi.fn(async () => undefined),
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
const NUMBER = '+27000000162';
const TOKEN_HASH = `k160-race-${crypto.randomUUID()}`;
const binding = { companyId: company, inboxId: inbox, tokenHash: TOKEN_HASH };

function arm(parties: number) {
  barrier.parties = parties;
  barrier.arrived = 0;
  barrier.open = new Promise<void>((resolve) => { barrier.release = resolve; });
}

function payload(sid: string, extra: Record<string, string>) {
  return { From: 'whatsapp:+27000000163', To: `whatsapp:${NUMBER}`, MessageSid: sid, ...extra };
}

async function counts(sid: string) {
  const docs = await pool.query(
    'SELECT id FROM captured_documents WHERE company_id=$1 AND file_name LIKE $2',
    [company, `whatsapp_${sid}_%`],
  );
  const events = await pool.query(
    'SELECT provider_message_part FROM capture_events WHERE company_id=$1 AND provider_message_id=$2 ORDER BY 1',
    [company, sid],
  );
  return { docs: docs.rowCount, parts: events.rows.map((r) => Number(r.provider_message_part)) };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K160 race fixture']);
  await pool.query(
    `INSERT INTO capture_inboxes(id,company_id,channel,address,is_active,webhook_token_hash,provider_verified_at)
     VALUES($1,$2,'whatsapp',$3,true,$4,NOW())`,
    [inbox, company, NUMBER, TOKEN_HASH],
  );
});

beforeEach(() => {
  fetchMock.mockClear();
  arm(1);
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

async function ingest() {
  const mod = await import('../../src/modules/accounting/services/capture/whatsAppInboundService');
  return mod.ingestTwilioPayload;
}

it('two concurrent deliveries of one media message ingest it once and both resolve', async () => {
  const ingestTwilioPayload = await ingest();
  const sid = 'SMk160concurrentmedia0000000000001';
  const p = payload(sid, {
    Body: '', NumMedia: '1',
    MediaUrl0: 'https://api.twilio.com/k160/race0', MediaContentType0: 'application/pdf',
  });
  arm(2);

  const results = await Promise.all([ingestTwilioPayload(p, binding), ingestTwilioPayload(p, binding)]);

  // Both reached the insert — the lookup alone could not have stopped either.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await counts(sid)).toEqual({ docs: 1, parts: [0] });
  const ids = results.map((r) => ('captureEventIds' in r ? r.captureEventIds.length : -1));
  expect(ids.sort()).toEqual([0, 1]);
});

it('two concurrent deliveries of one text command create one event; the loser returns no command', async () => {
  const ingestTwilioPayload = await ingest();
  const sid = 'SMk160concurrenttext00000000000001';
  const p = payload(sid, { Body: 'paid R500 at Shell', NumMedia: '0' });
  arm(2);

  const results = await Promise.all([ingestTwilioPayload(p, binding), ingestTwilioPayload(p, binding)]);

  expect((await counts(sid)).parts).toEqual([-1]);
  const commands = results.map((r) => ('captureEventIds' in r ? r.parsedCommand !== null : null));
  expect(commands.sort()).toEqual([false, true]);
});

it('a retry after a partial ingest adds only the missing media part', async () => {
  const ingestTwilioPayload = await ingest();
  const sid = 'SMk160partialretry0000000000000001';
  const p = payload(sid, {
    Body: '', NumMedia: '2',
    MediaUrl0: 'https://api.twilio.com/k160/part0', MediaContentType0: 'application/pdf',
    MediaUrl1: 'https://api.twilio.com/k160/part1', MediaContentType1: 'application/pdf',
  });
  // First delivery: media 1 cannot be fetched, so only part 0 lands.
  fetchMock.mockImplementationOnce(async (url: string) => ({
    buffer: Buffer.from(`%PDF-1.4 k160 ${url}`), contentType: 'application/pdf',
  }));
  fetchMock.mockImplementationOnce(async () => null as never);
  await ingestTwilioPayload(p, binding);
  expect(await counts(sid)).toEqual({ docs: 1, parts: [0] });

  fetchMock.mockClear();
  const retry = await ingestTwilioPayload(p, binding);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.twilio.com/k160/part1');
  expect(await counts(sid)).toEqual({ docs: 2, parts: [0, 1] });
  expect('captureEventIds' in retry && retry.captureEventIds).toHaveLength(1);
});
