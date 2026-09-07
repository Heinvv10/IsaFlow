import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logError = vi.fn();
const logInfo = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { error: (...a: unknown[]) => logError(...a), info: (...a: unknown[]) => logInfo(...a) },
}));

import { gotenbergTransport } from '@/lib/pdf/transports/gotenbergTransport';
import type { PdfRenderRequest } from '@/lib/pdf/pdfTransport';

const SECRET_TOKEN = 'tok.super-secret-signature';

const request: PdfRenderRequest = {
  url: 'https://app.isaflow.co.za/accounting/reports/report-packs?pack=management&print=1',
  landscape: false,
  allowedApiPaths: ['/api/accounting/reports-pack'],
  cookies: [{ name: 'sb-access-token', value: SECRET_TOKEN, httpOnly: true }],
};

const originalEnv = { ...process.env };

function pdfBytes(): ArrayBuffer {
  return new TextEncoder().encode('%PDF-1.7 fake pdf body').buffer;
}

beforeEach(() => {
  process.env.APP_URL = 'https://app.isaflow.co.za';
  process.env.GOTENBERG_URL = 'http://localhost:5002';
  logError.mockReset();
  logInfo.mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('gotenbergTransport.render', () => {
  it('posts to the convert endpoint even when GOTENBERG_URL has a trailing slash', async () => {
    process.env.GOTENBERG_URL = 'http://localhost:5002/';
    const fetchMock = vi.fn().mockResolvedValue(new Response(pdfBytes(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await gotenbergTransport.render(request);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('http://localhost:5002/forms/chromium/convert/url');
  });

  it('returns the PDF bytes on success and logs no cookie or token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(pdfBytes(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const bytes = await gotenbergTransport.render(request);

    expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain(SECRET_TOKEN);
  });

  it('rejects a response that is not a PDF, without leaking its body', async () => {
    const htmlBody = `<html>error page with token ${SECRET_TOKEN}</html>`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(htmlBody, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gotenbergTransport.render(request)).rejects.toThrow(/not a PDF/);
    expect(JSON.stringify(logError.mock.calls)).not.toContain(SECRET_TOKEN);
  });

  it('throws on a non-ok response using the status code only, never the body', async () => {
    const errorBody = `Bad Request: cookies field invalid ${SECRET_TOKEN}`;
    const fetchMock = vi.fn().mockResolvedValue(new Response(errorBody, { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await gotenbergTransport.render(request);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('400');
    expect((caught as Error).message).not.toContain(SECRET_TOKEN);
    expect((caught as Error).message).not.toContain('cookies field invalid');
    expect(JSON.stringify(logError.mock.calls)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(logError.mock.calls)).not.toContain('cookies field invalid');
  });
});

describe('gotenbergTransport — capabilities', () => {
  it('claims the metadata capability it actually has', () => {
    // Load-bearing metadata (PDF/A for archival retention) must be enforced at
    // the CALL SITE by reading this flag, not hoped for.
    // `guaranteed`, not merely truthy: Gotenberg's Chromium route takes the
    // Info dictionary as a form field, so a successful render IS a file with
    // the metadata in it. The Playwright transport post-processes the bytes
    // and can decline, which is `best-effort`.
    expect(gotenbergTransport.capabilities.metadata).toBe('guaranteed');
  });
});
