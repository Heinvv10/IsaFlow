// RED phase — written before implementation
/**
 * Unit tests for whatsAppInboundService.ts — PRD-05 Phase 8
 *
 * Covers: ingestTwilioPayload
 *   - Unknown To → rejected
 *   - Text-only (NumMedia=0) → parsedCommand set, no events
 *   - Media with TWILIO env unset → skipped gracefully
 *   - Media with TWILIO env set → document + event created, routeEvent called
 *   - Two media → two events
 *   - Media + text command → both paths fire
 *   - Workstream D: open query reply routing (attach media, mark replied)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
  sqlMock, storeMock, sha256Mock, routeEventMock,
  findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock,
} = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  const storeMock = vi.fn().mockResolvedValue({
    bucket: 'captured-documents',
    path: 'company/doc-id',
    hash: 'abc123',
    size: 1024,
    documentId: 'doc-id',
  });
  const sha256Mock = vi.fn().mockReturnValue('deadbeef');
  const routeEventMock = vi.fn().mockResolvedValue(undefined);
  const findOpenQueryMock = vi.fn();
  const attachReplyMediaMock = vi.fn(async () => true);
  const markQueryRepliedMock = vi.fn(async () => undefined);
  return {
    sqlMock, storeMock, sha256Mock, routeEventMock,
    findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock,
  };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/documentStorage', () => ({
  storeCapturedBytes: storeMock,
  sha256: sha256Mock,
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({
  routeEvent: routeEventMock,
}));
vi.mock('@/modules/accounting/services/capture/bankTxQueryReplyService', () => ({
  findOpenQuery: (...a: unknown[]) => findOpenQueryMock(...(a as [string, string])),
  attachReplyMedia: (...a: unknown[]) => attachReplyMediaMock(...(a as [])),
  markQueryReplied: (...a: unknown[]) => markQueryRepliedMock(...(a as [])),
}));

import {
  ingestTwilioPayload as ingestVerifiedPayload,
  type TwilioInboundPayload,
} from '@/modules/accounting/services/capture/whatsAppInboundService';

const ingestTwilioPayload = (payload: TwilioInboundPayload) => ingestVerifiedPayload(payload, { companyId: 'company-1', inboxId: 'inbox-1', tokenHash: 'fixture-proof' });


// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const INBOX_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const DOC_ID     = 'cccccccc-0000-0000-0000-000000000003';
const EVENT_ID   = 'dddddddd-0000-0000-0000-000000000004';
const WA_NUMBER  = '+27600000000';

function makePayload(overrides: Partial<TwilioInboundPayload> = {}): TwilioInboundPayload {
  return {
    From: 'whatsapp:+27611111111',
    To: `whatsapp:${WA_NUMBER}`,
    Body: '',
    NumMedia: '0',
    MessageSid: 'SM001',
    ...overrides,
  };
}

function makeInboxRow() {
  return { id: INBOX_ID, company_id: COMPANY_ID };
}

/** Set up a happy-path mock sequence for N media items. */
function mockMediaHappyPath(count: number) {
  // inbox lookup
  vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);
  for (let i = 0; i < count; i++) {
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: DOC_ID }] as never);  // INSERT captured_documents
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);                // UPDATE storage_bucket/path
    vi.mocked(sqlMock).mockResolvedValueOnce([{ id: EVENT_ID }] as never); // INSERT capture_events
  }
}

function makeMediaPayload(count: number, body = ''): TwilioInboundPayload {
  const p: TwilioInboundPayload = makePayload({ NumMedia: String(count), Body: body });
  for (let i = 0; i < count; i++) {
    p[`MediaUrl${i}`] = `https://api.twilio.com/media/MM00${i}`;
    p[`MediaContentType${i}`] = 'image/jpeg';
  }
  return p;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestTwilioPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    // Restore storeMock default after clearAllMocks
    vi.mocked(storeMock).mockResolvedValue({
      bucket: 'captured-documents',
      path: 'company/doc-id',
      hash: 'abc123',
      size: 1024,
      documentId: DOC_ID,
    });
    vi.mocked(routeEventMock).mockResolvedValue(undefined);
    // Workstream D mocks: default to no open query
    vi.mocked(findOpenQueryMock).mockResolvedValue(null);
    vi.mocked(attachReplyMediaMock).mockResolvedValue(true);
    vi.mocked(markQueryRepliedMock).mockResolvedValue(undefined);
  });

  // ── Unknown To ───────────────────────────────────────────────────────────────

  it('returns {rejected} when no active whatsapp inbox matches the To address', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await ingestTwilioPayload(makePayload());

    expect(result).toEqual({ rejected: 'no matching inbox' });
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  it('issues no document inserts on rejection', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);
    await ingestTwilioPayload(makePayload({ Body: 'paid R500 Shell' }));
    // Only the inbox lookup — no document/event writes
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Text-only (NumMedia=0) ────────────────────────────────────────────────────

  it('text-only with parseable expense body → parsedCommand set + 1 text-command capture_event', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeInboxRow()] as never)   // inbox lookup
      .mockResolvedValueOnce([{ id: 'evt-1' }] as never); // text-command event INSERT

    const result = await ingestTwilioPayload(
      makePayload({ Body: 'paid R850 at Shell', NumMedia: '0' }),
    );

    expect('rejected' in result).toBe(false);
    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toEqual(['evt-1']);
      expect(result.parsedCommand).not.toBeNull();
      expect(result.parsedCommand?.amount).toBe(850);
      expect(result.companyId).toBe(COMPANY_ID);
    }
  });

  it('text-only with noise body → parsedCommand null, captureEventIds empty', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestTwilioPayload(
      makePayload({ Body: 'hello there', NumMedia: '0' }),
    );

    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toHaveLength(0);
      expect(result.parsedCommand).toBeNull();
    }
  });

  // ── Media with TWILIO env unset ───────────────────────────────────────────────

  it('1 media item, TWILIO env unset → skips download, captureEventIds empty', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestTwilioPayload(makeMediaPayload(1));

    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toHaveLength(0);
    }
    // No document or event inserts — only inbox lookup
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
  });

  // ── Media with TWILIO env set ─────────────────────────────────────────────────

  it('1 media, TWILIO env set, fetch succeeds → 1 event, routeEvent called once', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'token';

    // Mock global fetch to return a jpeg buffer
    const fakeBuffer = Buffer.from('fakeimage');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => fakeBuffer.buffer,
    }));

    mockMediaHappyPath(1);

    const result = await ingestTwilioPayload(makeMediaPayload(1));

    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toHaveLength(1);
      expect(result.companyId).toBe(COMPANY_ID);
    }
    expect(vi.mocked(routeEventMock)).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('2 media items → 2 events, routeEvent called twice', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'token';

    const fakeBuffer = Buffer.from('fakeimage');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => fakeBuffer.buffer,
    }));

    // inbox + 2×(doc, storage-update, event)
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);
    for (let i = 0; i < 2; i++) {
      vi.mocked(sqlMock)
        .mockResolvedValueOnce([{ id: `doc-${i}` }] as never)
        .mockResolvedValueOnce([] as never)
        .mockResolvedValueOnce([{ id: `event-${i}` }] as never);
    }

    const result = await ingestTwilioPayload(makeMediaPayload(2));

    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toHaveLength(2);
    }
    expect(vi.mocked(routeEventMock)).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  // ── Media + text command together ─────────────────────────────────────────────

  it('media + expense text → both captureEventIds and parsedCommand are populated', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN  = 'token';

    const fakeBuffer = Buffer.from('fakeimage');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => fakeBuffer.buffer,
    }));

    mockMediaHappyPath(1);

    const result = await ingestTwilioPayload(
      makeMediaPayload(1, 'paid R850 Shell'),
    );

    if ('captureEventIds' in result) {
      expect(result.captureEventIds).toHaveLength(1);
      expect(result.parsedCommand).not.toBeNull();
      expect(result.parsedCommand?.amount).toBe(850);
    }

    vi.unstubAllGlobals();
  });

  // ── Workstream D: bank-tx query reply routing ─────────────────────────────────

  const OPEN_QUERY = { id: 'q1', bankTransactionId: 'tx1', status: 'sent' as const };
  const QUERY_COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('attaches reply media and marks the query replied', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN  = 'token_test';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('fakejpegbytes'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })));

    // sqlMock: inbox lookup → doc insert → storage update → event insert
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never)
      .mockResolvedValueOnce([{ id: 'doc-1' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'event-1' }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);

    const res = await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      Body: 'here is the slip', NumMedia: '1', MessageSid: 'SM1',
      MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg',
    });

    expect('rejected' in res).toBe(false);
    expect(findOpenQueryMock).toHaveBeenCalledWith(QUERY_COMPANY_ID, '+27821234567');
    expect(attachReplyMediaMock).toHaveBeenCalledTimes(1);
    expect(markQueryRepliedMock).toHaveBeenCalledWith(
      QUERY_COMPANY_ID, 'q1', 'here is the slip', 'event-1',
    );

    vi.unstubAllGlobals();
  });

  it('marks a text-only non-command reply as replied (no capture event required)', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);

    await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      Body: 'that was the printer repair', NumMedia: '0', MessageSid: 'SM2',
    });

    expect(attachReplyMediaMock).not.toHaveBeenCalled();
    expect(markQueryRepliedMock).toHaveBeenCalledWith(
      QUERY_COMPANY_ID, 'q1', 'that was the printer repair', null,
    );
  });

  it('does nothing query-related when no open query matches', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(null);

    await ingestTwilioPayload({
      From: 'whatsapp:+27829999999', To: 'whatsapp:+14155238886',
      Body: 'hello', NumMedia: '0', MessageSid: 'SM3',
    });

    expect(attachReplyMediaMock).not.toHaveBeenCalled();
    expect(markQueryRepliedMock).not.toHaveBeenCalled();
  });

  it('still ingests normally when query lookup matches but media attach fails', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN  = 'token_test';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('fakejpegbytes'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })));

    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never)
      .mockResolvedValueOnce([{ id: 'doc-1' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'event-1' }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);
    vi.mocked(attachReplyMediaMock).mockResolvedValue(false); // e.g. over 2MB

    const res = await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      NumMedia: '1', MessageSid: 'SM4',
      MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg',
    });

    expect('rejected' in res).toBe(false); // capture pipeline unaffected
    expect(markQueryRepliedMock).toHaveBeenCalled(); // still replied (doc captured)

    vi.unstubAllGlobals();
  });

  it('capture pipeline continues even when query lookup throws', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN  = 'token_test';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('fakejpegbytes'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })));

    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never)
      .mockResolvedValueOnce([{ id: 'doc-1' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ id: 'event-1' }] as never);

    vi.mocked(findOpenQueryMock).mockRejectedValue(new Error('DB down'));

    const res = await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      Body: 'here is the slip', NumMedia: '1', MessageSid: 'SM5',
      MediaUrl0: 'https://api.twilio.com/m/0', MediaContentType0: 'image/jpeg',
    });

    expect('rejected' in res).toBe(false);
    if ('captureEventIds' in res) {
      expect(res.captureEventIds).toHaveLength(1); // document still ingested
    }
    expect(attachReplyMediaMock).not.toHaveBeenCalled();
    expect(markQueryRepliedMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('ingest returns non-rejected result even when markQueryReplied rejects', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);
    vi.mocked(markQueryRepliedMock).mockRejectedValue(new Error('DB constraint'));

    const res = await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      Body: 'some text reply', NumMedia: '0', MessageSid: 'SM6',
    });

    expect('rejected' in res).toBe(false);
  });

  it('open query + empty Body + NumMedia 0 → markQueryReplied NOT called', async () => {
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([{ id: 'inbox-1', company_id: QUERY_COMPANY_ID }] as never);

    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);

    await ingestTwilioPayload({
      From: 'whatsapp:+27821234567', To: 'whatsapp:+14155238886',
      Body: '', NumMedia: '0', MessageSid: 'SM7',
    });

    expect(markQueryRepliedMock).not.toHaveBeenCalled();
  });
});

it('requires a verified binding even when the destination exists', async () => {
  sqlMock.mockClear();
  expect(await ingestVerifiedPayload({From:'whatsapp:+27821111111',To:'whatsapp:+27820000000',MessageSid:'SM-unproven'})).toEqual({rejected:'destination verification required'});
  expect(sqlMock).not.toHaveBeenCalled();
});
