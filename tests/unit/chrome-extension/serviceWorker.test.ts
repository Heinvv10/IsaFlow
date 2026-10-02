// D2: what the bank connector's popup shows. The scraper's own sentence (ABSA: session expired, 180-day cap)
// and IsaFlow's own 4xx reason reach the person; anything else becomes the plain reload line.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Listener = (msg: unknown, sender: unknown, send: (r: { ok: boolean; error?: string }) => void) => boolean;
type Reply = { ok: boolean; error?: string };

const SRC = readFileSync(join(process.cwd(), 'chrome-extension/bank-connector/service_worker.js'), 'utf8');
const CONN = { connectionId: 'c1', bankId: 'absa', bankAccountExternalId: '123', ingestUrl: '/x', host: 'https://app.isaflow.co.za', jwt: 'j' };

function boot(scraperReply: unknown, ingest: unknown) {
  let listener: Listener | undefined;
  const api = { getConnection: async () => CONN, saveConnection: async () => undefined, ingest: async () => ingest };
  const chrome = {
    runtime: { getManifest: () => ({ version: '1' }), onMessage: { addListener: (l: Listener) => { listener = l; } }, lastError: undefined },
    tabs: { sendMessage: (_t: number, _m: unknown, cb: (r: unknown) => void) => cb(scraperReply) },
  };
  const self: Record<string, unknown> = { IsaflowApi: api, SCRAPER_REGISTRY: { get: () => ({ tabId: 1, version: '1' }), register: () => undefined } };
  vm.runInNewContext(SRC, { chrome, self, importScripts: () => undefined, console: { warn: vi.fn() }, Date, Error });
  return (): Promise<Reply> => new Promise((resolve) => { listener!({ source: 'isaflow-bank', type: 'sync', connectionId: 'c1' }, {}, resolve); });
}

const RELOAD = 'The bank connector could not finish that - reload the extension and try again';
const SAVE_FAIL = 'IsaFlow could not save the transactions - try again';

describe('bank connector service worker', () => {
  it('keeps the scraper sentence when the bank page refuses', async () => {
    const sync = boot({ ok: false, error: 'Your ABSA session has expired - sign in again' }, { ok: true, body: {} });
    expect(await sync()).toEqual({ ok: false, error: 'Your ABSA session has expired - sign in again' });
  });

  it('says what could not be done when the scraper sent no sentence', async () => {
    const sync = boot({ ok: false }, { ok: true, body: {} });
    expect((await sync()).error).toBe('The bank page could not finish that - try again');
  });

  it('keeps a transport failure out of the popup', async () => {
    const sync = boot(undefined, { ok: true, body: {} });
    expect((await sync()).error).toBe(RELOAD);
  });

  it('shows IsaFlow\'s own reason for a 4xx ingest refusal', async () => {
    const sync = boot({ ok: true, value: { transactions: [] } }, { ok: false, status: 400, body: { error: { message: 'That date range is too long' } } });
    expect((await sync()).error).toBe('That date range is too long');
  });

  it('uses the plain sentence for a 5xx ingest failure, whatever the body says', async () => {
    const sync = boot({ ok: true, value: { transactions: [] } }, { ok: false, status: 502, body: { error: { message: '<html>bad gateway</html>' } } });
    expect((await sync()).error).toBe(SAVE_FAIL);
  });
});
