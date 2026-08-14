/**
 * pentest M5: capture/upload must reject files whose real magic bytes don't
 * match the client-declared mimetype, not just filter on part.mimetype.
 *
 * Drives the route through the API-key auth path (validateCaptureApiKey
 * mocked) to avoid the cookie-session/withAuth machinery, and mocks
 * `formidable` to synchronously feed a fake file through the real
 * fileWriteStreamHandler so the module's internal fileBuffers WeakMap gets
 * populated exactly as it would in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { sqlMock, storeCapturedBytesMock, routeEventMock, validateCaptureApiKeyMock, fakeFile } = vi.hoisted(
  () => ({
    sqlMock: vi.fn(),
    storeCapturedBytesMock: vi.fn(),
    routeEventMock: vi.fn(),
    validateCaptureApiKeyMock: vi.fn(),
    // The fake "file" formidable hands back once a part passes the mimetype filter.
    fakeFile: { mimetype: 'application/pdf', originalFilename: 'evil.pdf', size: 37 },
  }),
);

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/documentStorage', () => ({
  sha256: vi.fn(() => 'deadbeef'),
  storeCapturedBytes: storeCapturedBytesMock,
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({
  routeEvent: routeEventMock,
}));
vi.mock('@/lib/auth/captureApiKeyAuth', () => ({
  validateCaptureApiKey: validateCaptureApiKeyMock,
  extractBearerToken: (h: string | undefined) => (h?.startsWith('Bearer ') ? h.slice(7) : null),
}));

type Writer = { write: (c: Buffer, e: string, cb: () => void) => void; end: (cb?: () => void) => void };

vi.mock('formidable', () => ({
  default: (opts: {
    filter: (part: { mimetype?: string | null }) => boolean;
    fileWriteStreamHandler: (file: unknown) => unknown;
  }) => ({
    parse: (_req: unknown, cb: (err: unknown, fields: unknown, files: unknown) => void) => {
      // Mirrors formidable: only construct the write stream for parts that
      // pass the declared-mimetype filter.
      expect(opts.filter({ mimetype: fakeFile.mimetype })).toBe(true);
      const writable = opts.fileWriteStreamHandler(fakeFile) as unknown as Writer;
      const maliciousBuffer = Buffer.from('<html><script>evil()</script></html>');
      writable.write(maliciousBuffer, 'buffer', () => {
        writable.end();
        cb(null, {}, { file: fakeFile });
      });
    },
  }),
}));

import handler from '../../../pages/api/accounting/capture/upload';

function makeRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res as NextApiResponse;
  }) as unknown as NextApiResponse['status'];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res as NextApiResponse;
  }) as unknown as NextApiResponse['json'];
  res.setHeader = vi.fn() as unknown as NextApiResponse['setHeader'];
  return res as NextApiResponse & { statusCode?: number; body?: unknown };
}

function makeReq(): NextApiRequest {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer isa_live_testkey' },
  } as unknown as NextApiRequest;
}

describe('pentest M5: POST /api/accounting/capture/upload magic-byte check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateCaptureApiKeyMock.mockResolvedValue({ companyId: 'company-1', keyId: 'key-1' });
  });

  it('rejects a PDF-declared upload whose real bytes are not a PDF', async () => {
    const req = makeReq();
    const res = makeRes();

    await handler(req, res);

    // Malformed/mismatched bytes must never reach persistence.
    expect(sqlMock).not.toHaveBeenCalled();
    expect(storeCapturedBytesMock).not.toHaveBeenCalled();
    expect(routeEventMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as unknown as { body: { success: boolean } }).body.success).toBe(false);
  });
});
