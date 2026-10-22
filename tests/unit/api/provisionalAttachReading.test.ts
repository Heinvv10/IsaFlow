/** provisional/[jeId]/attach answers 409 (not 400, not the 503 of a held lock) for a document still being read. */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/capture/provisionalEvidenceAttach', () => ({ attachDocumentToProvisional: m.attach }));

import route from '../../../pages/api/accounting/provisional/[jeId]/attach';

const ID = '66666666-6666-4666-8666-666666666666';

describe('POST provisional/[jeId]/attach', () => {
  it("maps the service's 'reading' to 409 with the message", async () => {
    m.attach.mockResolvedValue({ kind: 'reading', message: 'This document is still being read.' });
    const req = { method: 'POST', query: { jeId: ID }, body: { capturedDocumentId: ID }, companyId: 'c' } as unknown as NextApiRequest;
    const res = {
      statusCode: 0, sent: undefined as unknown,
      setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; },
    };
    await (route as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res as unknown as NextApiResponse);
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain('still being read');
  });
});
