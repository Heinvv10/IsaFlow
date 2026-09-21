import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlMock, findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock, ingestTwilioPayload, COMPANY_ID, resetMocks } from './whatsAppInbound.helpers';

describe('verified WhatsApp ingestion', () => {
  beforeEach(resetMocks);
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
