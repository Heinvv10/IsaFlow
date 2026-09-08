import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlMock, routeEventMock, ingestTwilioPayload, ingestVerifiedPayload, COMPANY_ID, makePayload, makeInboxRow, mockMediaHappyPath, makeMediaPayload, resetMocks } from './whatsAppInbound.helpers';

describe('verified WhatsApp ingestion', () => {
  beforeEach(resetMocks);

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

it('requires a verified binding even when the destination exists', async () => {
  sqlMock.mockClear();
  expect(await ingestVerifiedPayload({From:'whatsapp:+27821111111',To:'whatsapp:+27820000000',MessageSid:'SM-unproven'})).toEqual({rejected:'destination verification required'});
  expect(sqlMock).not.toHaveBeenCalled();
});
});
