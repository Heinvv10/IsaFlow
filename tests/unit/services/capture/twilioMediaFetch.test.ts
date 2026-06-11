import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { fetchTwilioMedia } from '@/modules/accounting/services/capture/twilioMediaFetch';

const VALID_URL = 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM123/Media/ME456';
const CDN_URL = 'https://media.twiliocdn.com/foo/bar.jpeg';
const EVIL_URL = 'https://evil.example.com/steal-creds';
const INVALID_URL = 'not a url';

function stubFetch(buffer: Buffer, contentType: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    headers: { get: (_h: string) => contentType },
    arrayBuffer: async () => buffer.buffer,
  }));
}

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tokentest';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

describe('fetchTwilioMedia — SSRF allowlist', () => {
  it('fetches from api.twilio.com successfully', async () => {
    const fakeBuffer = Buffer.from('fakeimage');
    stubFetch(fakeBuffer, 'image/jpeg');

    const result = await fetchTwilioMedia(VALID_URL);

    expect(result).not.toBeNull();
    expect(result?.contentType).toBe('image/jpeg');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      VALID_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Basic ') }) }),
    );
  });

  it('fetches from *.twiliocdn.com successfully', async () => {
    const fakeBuffer = Buffer.from('cdnimage');
    stubFetch(fakeBuffer, 'image/jpeg');

    const result = await fetchTwilioMedia(CDN_URL);

    expect(result).not.toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('returns null for a non-Twilio host WITHOUT calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchTwilioMedia(EVIL_URL);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for an invalid URL WITHOUT calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchTwilioMedia(INVALID_URL);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when TWILIO env vars are absent', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchTwilioMedia(VALID_URL);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when fetch responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
    }));

    const result = await fetchTwilioMedia(VALID_URL);

    expect(result).toBeNull();
  });
});
