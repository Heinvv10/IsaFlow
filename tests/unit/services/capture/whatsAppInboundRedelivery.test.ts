import { describe, it, expect, vi, beforeEach } from 'vitest';
const { removeMock } = vi.hoisted(() => ({ removeMock: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabaseStorage', () => ({
  removeCapturedDocument: (...a: unknown[]) => removeMock(...(a as [])),
}));

import { sqlMock, routeEventMock, findOpenQueryMock, attachReplyMediaMock, markQueryRepliedMock, ingestedPartsMock, ingestTwilioPayload, COMPANY_ID, DOC_ID, makePayload, makeInboxRow, makeMediaPayload, resetMocks } from './whatsAppInbound.helpers';

// K-160: a Twilio redelivery of an already-ingested message must not re-ingest,
// re-acknowledge (the route acks on captureEventIds / parsedCommand) or re-append
// the bank-tx query reply.
describe('Twilio redelivery (K-160)', () => {
  const OPEN_QUERY = { id: 'q1', bankTransactionId: 'tx1', status: 'sent' as const };
  beforeEach(() => {
    resetMocks();
    removeMock.mockReset().mockResolvedValue(undefined);
  });

  it('looks up ingested parts for this company and MessageSid', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);
    await ingestTwilioPayload(makePayload({ MessageSid: 'SM-lookup' }));
    expect(ingestedPartsMock).toHaveBeenCalledWith(COMPANY_ID, 'SM-lookup');
  });

  it('skips an already-ingested media part without fetching it', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    vi.mocked(ingestedPartsMock).mockResolvedValueOnce(new Set([0]));
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestTwilioPayload(makeMediaPayload(1, 'paid R850 Shell'));

    expect(result).toEqual({ captureEventIds: [], companyId: COMPANY_ID, parsedCommand: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(routeEventMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not re-insert a text command or re-append the query reply', async () => {
    vi.mocked(ingestedPartsMock).mockResolvedValueOnce(new Set([-1]));
    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);
    vi.mocked(sqlMock).mockResolvedValueOnce([makeInboxRow()] as never);

    const result = await ingestTwilioPayload(makePayload({ Body: 'paid R500 at Shell' }));

    expect(result).toEqual({ captureEventIds: [], companyId: COMPANY_ID, parsedCommand: null });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(markQueryRepliedMock).not.toHaveBeenCalled();
  });

  function mockLostRace() {
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Buffer.from('fakeimage').buffer,
    }));
    vi.mocked(findOpenQueryMock).mockResolvedValue(OPEN_QUERY);
    vi.mocked(sqlMock)
      .mockResolvedValueOnce([makeInboxRow()] as never)  // inbox
      .mockResolvedValueOnce([{ id: DOC_ID }] as never)  // INSERT captured_documents
      .mockResolvedValueOnce([] as never)                // UPDATE storage pointer
      .mockResolvedValueOnce([] as never)                // INSERT capture_events → conflict
      .mockResolvedValueOnce([] as never);               // DELETE own document
  }

  it('a delivery that loses the insert race discards its document and object and does not route it', async () => {
    mockLostRace();
    const result = await ingestTwilioPayload(makeMediaPayload(1, 'here is the slip'));

    expect(result).toEqual({ captureEventIds: [], companyId: COMPANY_ID, parsedCommand: null });
    const deleteCall = vi.mocked(sqlMock).mock.calls[4]!;
    expect((deleteCall[0] as unknown as string[]).join('?')).toMatch(/DELETE FROM captured_documents/);
    expect(deleteCall.slice(1)).toEqual([DOC_ID, COMPANY_ID]);
    expect(removeMock).toHaveBeenCalledWith('captured-documents', 'company/doc-id', COMPANY_ID);
    expect(routeEventMock).not.toHaveBeenCalled();
    expect(attachReplyMediaMock).not.toHaveBeenCalled();
    expect(markQueryRepliedMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a failed object delete is logged and the delivery still resolves', async () => {
    mockLostRace();
    removeMock.mockRejectedValueOnce(new Error('storage down'));

    const result = await ingestTwilioPayload(makeMediaPayload(1));

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ captureEventIds: [], companyId: COMPANY_ID, parsedCommand: null });
    vi.unstubAllGlobals();
  });
});
