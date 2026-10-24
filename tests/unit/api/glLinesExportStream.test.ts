/**
 * The GL-lines CSV route on a REAL http.Server and socket (PR #688 round 2).
 *
 * REPRO A: a client that disconnected while a page query ran left the handler
 * waiting for a 'close' that had already fired — it never returned, so
 * withAuth's transaction and its pooled client stayed held. A fake response
 * cannot show that (it only emits what the test emits), so this drives the real
 * Node stream. The service is replaced by pages that take a set time; the
 * route's code is the real code. The auth wrapper is the identity: what is under test
 * is that the handler RETURNS, which is what lets the wrapper finish.
 *
 * Also: a first page that fails is a clean 500 with no CSV header (the header
 * used to go out first), and a later page that fails destroys the connection.
 */
import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logWarn = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: (...a: unknown[]) => logError(...a) },
  apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The auth wrapper is the identity here; its Bearer / cookie / scope behaviour on
// this route is tests/unit/api/glLinesExportAuth.test.ts.
vi.mock('@/lib/auth/withBearerOrCookieAuth', () => ({ withBearerOrCookieAuth: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn().mockResolvedValue(true) }));

const PAGE = 5000;
/** Per call: how long the page query takes and whether it fails. Call 1 is the first page. */
const pages = { calls: 0, delayMs: [0, 0, 0] as number[], failOn: 0, total: 3 };
vi.mock('@/modules/accounting/services/reports/glLineExportService', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const row = (i: number) => ({
    line_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, entry_id: '00000000-0000-4000-8000-000000000001',
    entry_date: '2026-04-01', debit: 1, credit: 0, entry_number: 'JE-1', status: 'posted',
    account_code: '1', account_name: 'x', description: 'y'.repeat(200),
  });
  return {
    ...real,
    getGlLineExportSummary: async () => ({ rowCount: PAGE * pages.total, controlTotal: 0, unbalancedTxnCount: 0 }),
    getExportEntity: async () => ({ name: 'Co' }),
    fetchGlLineExportPage: async () => {
      const n = ++pages.calls;
      await new Promise((r) => setTimeout(r, pages.delayMs[n - 1] ?? 0));
      if (n === pages.failOn) throw new Error(`page ${n} failed`);
      // A full page keeps the cursor going; the last one is short.
      return Array.from({ length: n < pages.total ? PAGE : 10 }, (_, i) => row(n * 10_000 + i));
    },
  };
});

import handler from '../../../pages/api/accounting/gl-lines-export';

type Outcome = { settled: 'resolved' | 'rejected' | null };
let server: http.Server;

/** A server that runs the route with Next's res.status / res.json, and records how the handler settled. */
async function serve(): Promise<{ port: number; outcome: Outcome }> {
  const outcome: Outcome = { settled: null };
  server = http.createServer((req, res) => {
    const r = res as http.ServerResponse & { status: (c: number) => unknown; json: (b: unknown) => void };
    r.status = (c: number) => { res.statusCode = c; return r; };
    r.json = (b: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
    Object.assign(req, { query: {}, companyId: '11111111-1111-4111-8111-111111111111' });
    Promise.resolve((handler as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res))
      .then(() => { outcome.settled = 'resolved'; }, () => { outcome.settled = 'rejected'; });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, outcome };
}

function get(port: number): net.Socket {
  const sock = net.connect(port, '127.0.0.1');
  sock.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n');
  return sock;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  Object.assign(pages, { calls: 0, delayMs: [0, 0, 0], failOn: 0, total: 3 });
  logWarn.mockReset();
  logError.mockReset();
});
afterEach(async () => { await new Promise((r) => server.close(() => r(undefined))); });

describe('GL lines CSV on a real socket', () => {
  it('a client that disconnects during a page query: the handler returns and reads no further page', async () => {
    pages.delayMs = [0, 300, 0];
    const { port, outcome } = await serve();
    const sock = get(port);
    sock.on('error', () => undefined);
    await new Promise<void>((r) => sock.once('data', () => r())); // headers + first rows are out
    await sleep(100); // page 2's query is running
    sock.destroy();
    await vi.waitFor(() => expect(outcome.settled).toBe('resolved'), { timeout: 3000, interval: 25 });
    expect(pages.calls).toBe(2);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('client closed'), expect.anything(), 'accounting-api');
    expect(logError).not.toHaveBeenCalled();
  });

  it('control: a client that reads to the end gets every row and the handler returns', async () => {
    const { port, outcome } = await serve();
    const sock = get(port);
    let body = '';
    sock.on('data', (d) => { body += d.toString('utf8'); });
    await vi.waitFor(() => expect(outcome.settled).toBe('resolved'), { timeout: 5000, interval: 25 });
    await vi.waitFor(() => expect(body.endsWith('0\r\n\r\n')).toBe(true), { timeout: 3000, interval: 25 });
    sock.destroy();
    const dataLines = body.split('\n').filter((l) => l.includes('JE-1'));
    expect(body.startsWith('HTTP/1.1 200')).toBe(true);
    expect(dataLines.length).toBe(PAGE * 2 + 10);
    expect(pages.calls).toBe(3);
  });

  it('a first page that fails is a 500 with no CSV header', async () => {
    pages.failOn = 1;
    const { port, outcome } = await serve();
    const sock = get(port);
    let body = '';
    sock.on('data', (d) => { body += d.toString('utf8'); });
    await vi.waitFor(() => expect(outcome.settled).not.toBeNull(), { timeout: 3000, interval: 25 });
    await vi.waitFor(() => expect(body).toContain('\r\n\r\n'), { timeout: 3000, interval: 25 });
    sock.destroy();
    expect(body.startsWith('HTTP/1.1 500')).toBe(true);
    expect(body).not.toContain('Txn_ID');
    expect(body).not.toContain('text/csv');
  });

  it('a later page that fails destroys the connection mid-file and logs it', async () => {
    pages.failOn = 2;
    const { port, outcome } = await serve();
    const sock = get(port);
    let body = '';
    sock.on('data', (d) => { body += d.toString('utf8'); });
    const closed = new Promise<void>((r) => sock.once('close', () => r()));
    sock.on('error', () => undefined);
    await closed;
    await vi.waitFor(() => expect(outcome.settled).toBe('resolved'), { timeout: 3000, interval: 25 });
    expect(body.startsWith('HTTP/1.1 200')).toBe(true);
    expect(body.endsWith('0\r\n\r\n')).toBe(false); // never a complete chunked body
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('after the download started'), expect.anything(), 'accounting-api');
  });
});
