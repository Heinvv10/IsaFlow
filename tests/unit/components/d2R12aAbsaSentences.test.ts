// @vitest-environment happy-dom
// D2 round 12: the four AbsaError messages that used to reach the popup as developer text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'chrome-extension/bank-connector/content/absa.js'), 'utf8');
const fetchMock = vi.fn();
type Reply = { ok: boolean; error?: string; value?: unknown };
let listener: (msg: unknown, sender: unknown, send: (r: Reply) => void) => boolean;
const BAD = /Unexpected|is required|YYYY|accountNumber|fromDate|toDate|TransactionHistory|BalanceEnquiry/;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(), onMessage: { addListener: (l: typeof listener) => { listener = l; } } } });
  /* eslint-disable-next-line no-new-func */
  new Function('self', src)(globalThis);
});
afterEach(() => { vi.unstubAllGlobals(); });

const ask = (msg: Record<string, unknown>) =>
  new Promise<Reply>((resolve) => { listener({ source: 'isaflow-bank', ...msg }, null, resolve); });
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('absa.js reasons shown in the popup', () => {
  it('a balance reply with no account list says what to do', async () => {
    fetchMock.mockResolvedValue(okJson({ header: { statuscode: '0' } }));
    const r = await ask({ type: 'listAccounts' });
    expect(r.error).toBe('ABSA did not return your accounts - sign in to ABSA online banking again and try again');
    expect(r.error).not.toMatch(BAD);
  });
  it('a history reply with no lines says to try again', async () => {
    fetchMock.mockResolvedValue(okJson({ header: { statuscode: '0' } }));
    const r = await ask({ type: 'fetchTransactions', accountNumber: '123', fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r.error).toBe('ABSA did not return the transactions - try again in a moment');
    expect(r.error).not.toMatch(BAD);
  });
  it('no account chosen is a plain request, not a field name', async () => {
    const r = await ask({ type: 'fetchTransactions', fromDate: '2026-09-01', toDate: '2026-09-30' });
    expect(r.error).toBe('Choose a bank account to sync first');
    expect(r.error).not.toMatch(BAD);
  });
  it('a missing date is a plain request, not a format string', async () => {
    const r = await ask({ type: 'fetchTransactions', accountNumber: '123', fromDate: '2026-09-01' });
    expect(r.error).toBe('Choose a start date and an end date to sync');
    expect(r.error).not.toMatch(BAD);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a good reply still returns the accounts (success path)', async () => {
    fetchMock.mockResolvedValue(okJson({ header: { statuscode: '0' }, accountList: [] }));
    const r = await ask({ type: 'listAccounts' });
    expect(r).toEqual({ ok: true, value: [] });
  });
});
