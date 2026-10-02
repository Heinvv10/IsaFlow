// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), 'chrome-extension/bank-connector', p), 'utf8');
const run = (src: string) => { /* eslint-disable-next-line no-new-func */ new Function('self', src)(globalThis); };
const fetchMock = vi.fn();
const BAD = /HTTP \d|JSON|Unexpected end|statuscode/;

type Listener = (msg: unknown, sender: unknown, send: (r: { ok: boolean; error?: string; value?: unknown }) => void) => boolean;
let listener: Listener;
const chromeStub = {
  runtime: {
    lastError: undefined as { message: string } | undefined,
    sendMessage: vi.fn(),
    onMessage: { addListener: (l: Listener) => { listener = l; } },
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', chromeStub);
  chromeStub.runtime.lastError = undefined;
  chromeStub.runtime.sendMessage = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('bank-connector lib/api.js ingest', () => {
  const conn = { host: 'https://app.isaflow.co.za', ingestUrl: '/x', jwt: 'j' };
  it('keeps the server error body on a refusal, and an empty 500 gives a null body', async () => {
    run(read('lib/api.js'));
    const api = (globalThis as unknown as { IsaflowApi: { ingest: (c: unknown, p: unknown) => Promise<{ ok: boolean; status: number; body: unknown }> } }).IsaflowApi;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad range' }), { status: 400 }));
    expect(await api.ingest(conn, {})).toEqual({ ok: false, status: 400, body: { error: 'bad range' } });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    expect(await api.ingest(conn, {})).toEqual({ ok: false, status: 500, body: null });
  });
  it('returns the parsed body on a 200', async () => {
    run(read('lib/api.js'));
    const api = (globalThis as unknown as { IsaflowApi: { ingest: (c: unknown, p: unknown) => Promise<unknown> } }).IsaflowApi;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { imported: 2 } }), { status: 200 }));
    expect(await api.ingest(conn, {})).toEqual({ ok: true, status: 200, body: { data: { imported: 2 } } });
  });
});

describe('bank-connector content/absa.js RPC errors reach the popup as plain sentences', () => {
  const ask = (type: string): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => { listener({ source: 'isaflow-bank', type }, null, resolve); });
  beforeEach(() => run(read('content/absa.js')));

  it('a 5xx from ABSA says what to do, no HTTP code', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    const r = await ask('listAccounts');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sign in to ABSA online banking/i);
    expect(r.error).not.toMatch(BAD);
  });
  it('an ABSA statuscode refusal passes ABSA\'s own reason through', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ header: { statuscode: '5', resultMessages: [{ responseMessage: 'Session expired' }] } }), { status: 200 }));
    const r = await ask('listAccounts');
    expect(r.error).toBe('ABSA refused the request: Session expired');
  });
  it('a dropped connection (TypeError) is the generic sentence, not the raw message', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await ask('listAccounts');
    expect(r.error).toMatch(/Could not reach ABSA online banking/);
    expect(r.error).not.toMatch(/Failed to fetch|TypeError/);
  });
});

describe('bank-connector popup/popup.js status line', () => {
  const status = () => document.getElementById('status')?.textContent;
  const load = async (reply: (cb: (r?: unknown) => void) => void, lastError?: { message: string }) => {
    document.body.innerHTML = '<div id="connections"></div><div id="status"></div>';
    chromeStub.runtime.sendMessage = vi.fn((_m: unknown, cb: (r?: unknown) => void) => {
      chromeStub.runtime.lastError = lastError;
      reply(cb);
    });
    run(read('popup/popup.js'));
    await vi.waitFor(() => expect(status()).not.toBe(''));
  };
  it('an error with no text from the background says what could not be done', async () => {
    await load((cb) => cb({ ok: false }));
    expect(status()).toBe('The extension could not finish that - try again');
  });
  it('a plain-sentence reason from the background is shown as it is', async () => {
    await load((cb) => cb({ ok: false, error: 'Bank tab not open. Please log in to your bank in another tab.' }));
    expect(status()).toBe('Bank tab not open. Please log in to your bank in another tab.');
  });
  it('a chrome runtime error is not shown raw', async () => {
    await load((cb) => cb(undefined), { message: 'Could not establish connection. Receiving end does not exist.' });
    expect(status()).toBe('The extension is not responding - reload it and try again');
  });
  it('a 200 with no connections shows the empty state and no error', async () => {
    document.body.innerHTML = '<div id="connections"></div><div id="status"></div>';
    chromeStub.runtime.sendMessage = vi.fn((_m: unknown, cb: (r?: unknown) => void) => cb({ ok: true, value: [] }));
    run(read('popup/popup.js'));
    await vi.waitFor(() => expect(document.querySelector('.empty')).not.toBeNull());
    expect(status()).toBe('');
  });
});
