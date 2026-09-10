/**
 * Blind review r4, LOW-1: the three typed contention errors were raised at the
 * service layer and nothing mapped them, so the caller got the generic 500 —
 * whose message `withErrorHandler` masks outright in production — with nothing
 * saying "this is transient, retry". 503 + Retry-After is the whole fix, and
 * 503 rather than a 4xx because 55P03 leaves the transaction ABORTED and
 * `withAuth` COMMITs anything below 500.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { DocumentNumberLockTimeoutError } from '@/modules/accounting/services/core/companySettingsService';
import { TimeEntryLockTimeoutError } from '@/modules/accounting/services/practice/timeEntryLock';
import { DocumentClaimLockTimeoutError } from '@/modules/accounting/services/core/documentClaimLock';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader: vi.fn((k: string, v: string) => { res.headers[k] = v; }),
    status: vi.fn((c: number) => { res.statusCode = c; return res; }),
    json: vi.fn((b: unknown) => { res.body = b; return res; }),
  };
  return res;
}

describe('respondIfLockTimeout', () => {
  const cases: [string, Error][] = [
    ['DocumentNumberLockTimeoutError', new DocumentNumberLockTimeoutError('customer_invoice')],
    ['TimeEntryLockTimeoutError', new TimeEntryLockTimeoutError()],
    ['DocumentClaimLockTimeoutError', new DocumentClaimLockTimeoutError('quote')],
  ];

  it.each(cases)('answers %s with a 503 the caller can retry', (_name, err) => {
    const res = mockRes();
    expect(respondIfLockTimeout(res as unknown as NextApiResponse, err)).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    // The message survives — it is the only thing telling the user to retry,
    // and a 503 body is not masked the way the generic 500 is.
    expect(body.error.message).toBe(err.message);
    expect(body.error.message).toMatch(/retry in a moment|being (created|converted|invoiced)/i);
  });

  it('leaves every other error to the caller, answering nothing', () => {
    for (const err of [new Error('boom'), { code: '23505' }, null]) {
      const res = mockRes();
      expect(respondIfLockTimeout(res as unknown as NextApiResponse, err)).toBe(false);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    }
  });
});
