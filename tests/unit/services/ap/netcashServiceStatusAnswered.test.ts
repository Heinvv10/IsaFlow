/**
 * AP-01 round 11 (adversarial B): a poll Netcash did not answer (HTTP error, network error, unreadable body, a body
 * with no status) came back as { status: 'unknown' }, which netcash/status mapped to 'processing' and stored as
 * Netcash's latest answer. getSubmissionStatus now says whether Netcash answered at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSubmissionStatus } from '@/modules/accounting/services/ap/netcashService';

afterEach(() => { vi.unstubAllGlobals(); });
const serve = (status: number, body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));

describe('getSubmissionStatus: answered or not', () => {
  it.each([
    ['HTTP 503', () => serve(503, '{"message":"down"}')],
    ['HTTP 500 with no body', () => serve(500, '')],
    ['a network error', () => vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }))],
    ['an unreadable 200 body', () => serve(200, '<html>gateway</html>')],
    ['a 200 body with no status', () => serve(200, '{"detail":"x"}')],
    ['a 200 body with a blank status', () => serve(200, '{"status":"  "}')],
    ['a 200 body with a non-text status', () => serve(200, '{"status":3}')],
  ])('%s: answered false', async (_n, setUp) => {
    setUp();
    const result = await getSubmissionStatus('service-key', 'NC-REF');
    expect(result.answered).toBe(false);
  });

  it('a 200 body with a status is an answer, kept as given', async () => {
    serve(200, '{"status":"Processing - 0 errors","detail":"queued"}');
    expect(await getSubmissionStatus('service-key', 'NC-REF')).toEqual({ status: 'Processing - 0 errors', detail: 'queued', answered: true });
  });
});
