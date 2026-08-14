/**
 * pentest M6: /api/admin/payroll/sars-codes/import must not accept
 * application/octet-stream (a wildcard binary MIME that neutralizes the
 * allowlist) and must reject non-ZIP/OOXML bytes before parsing, even when
 * the declared mimetype is otherwise allowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import type { AuthenticatedNextApiRequest } from '@/lib/auth';

const {
  parseSarsCodesXlsxBufferMock,
  importRowsMock,
  diffAgainstYearMock,
  logAdminActionMock,
  fakeFile,
} = vi.hoisted(() => ({
  parseSarsCodesXlsxBufferMock: vi.fn(),
  importRowsMock: vi.fn(),
  diffAgainstYearMock: vi.fn(),
  logAdminActionMock: vi.fn(),
  fakeFile: {
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    originalFilename: 'sars_codes.xlsx',
    filepath: '/tmp/fake-sars-codes-upload',
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/admin/services/sarsCodesParser', () => ({
  parseSarsCodesXlsxBuffer: parseSarsCodesXlsxBufferMock,
}));
vi.mock('@/modules/admin/services/sarsCodesAdminService', () => ({
  importRows: importRowsMock,
  diffAgainstYear: diffAgainstYearMock,
}));
vi.mock('@/modules/admin/services/auditService', () => ({
  logAdminAction: logAdminActionMock,
}));
vi.mock('@/utils/getIp', () => ({ getIp: vi.fn(() => '127.0.0.1') }));
// Identity wrappers — this test drives the inner handler directly, auth/CSRF
// are covered by withAdmin's/withCsrf's own tests.
vi.mock('@/modules/admin/middleware/withAdmin', () => ({
  withAdmin: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({
  withCsrf: (h: unknown) => h,
}));

let capturedFilter: ((part: { mimetype?: string | null }) => boolean) | null = null;

vi.mock('formidable', () => ({
  default: (opts: { filter: (part: { mimetype?: string | null }) => boolean }) => {
    capturedFilter = opts.filter;
    return {
      parse: () =>
        Promise.resolve([
          { taxYear: '2026', brsVersion: 'v25.2.0' },
          { file: fakeFile },
        ]),
    };
  },
}));

vi.mock('node:fs', () => ({
  default: {
    // Not a real XLSX/ZIP — plain text bytes, no PK\x03\x04 signature.
    readFileSync: vi.fn(() => Buffer.from('not a real xlsx file, just text')),
    unlinkSync: vi.fn(),
  },
}));

import handler from '../../../pages/api/admin/payroll/sars-codes/import';

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
  return res as NextApiResponse & { statusCode?: number; body?: unknown };
}

function makeReq(): AuthenticatedNextApiRequest {
  return {
    method: 'POST',
    user: { id: 'admin-1' },
  } as unknown as AuthenticatedNextApiRequest;
}

describe('pentest M6: POST /api/admin/payroll/sars-codes/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedFilter = null;
  });

  it('excludes application/octet-stream from the MIME allowlist', async () => {
    const req = makeReq();
    const res = makeRes();
    await (handler as unknown as (r: typeof req, s: typeof res) => Promise<void>)(req, res);

    expect(capturedFilter).not.toBeNull();
    expect(capturedFilter!({ mimetype: 'application/octet-stream' })).toBe(false);
    // The legitimate XLSX mimetype must still pass the allowlist stage.
    expect(
      capturedFilter!({
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    ).toBe(true);
  });

  it('rejects a declared-XLSX upload whose bytes are not a ZIP/OOXML container', async () => {
    const req = makeReq();
    const res = makeRes();

    await (handler as unknown as (r: typeof req, s: typeof res) => Promise<void>)(req, res);

    expect(parseSarsCodesXlsxBufferMock).not.toHaveBeenCalled();
    expect(importRowsMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res as unknown as { body: { success: boolean } }).body.success).toBe(false);
  });
});
