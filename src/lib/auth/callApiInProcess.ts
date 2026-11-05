// src/lib/auth/callApiInProcess.ts
/**
 * Runs a Next API handler inside this process and returns what it answered.
 *
 * For a page's getServerSideProps that needs an API route's answer. The page used to fetch its own
 * API through NEXT_PUBLIC_APP_URL: on production that is the public hostname (out through Cloudflare
 * and back, and a Cloudflare refusal read as "no data"), on a dev server on another port it is the
 * wrong server. Calling the handler directly needs no URL, and the handler is still the route's own
 * (withAuth, company scoping and all), so the page cannot drift from it.
 *
 * The response is a collector, not a socket: only status, headers and the one body are kept. The page
 * cannot use the headers (a cleared cookie from a 403 stays here, as it did over fetch).
 */
import type { IncomingMessage } from 'http';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export interface InProcessAnswer {
  status: number;
  /** The JSON body; null for an answer with none. */
  body: unknown;
}

type Header = string | number | string[];

interface Collector {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  body: unknown;
  setHeader(name: string, value: Header): Collector;
  getHeader(name: string): Header | undefined;
  hasHeader(name: string): boolean;
  getHeaders(): Record<string, Header>;
  getHeaderNames(): string[];
  removeHeader(name: string): void;
  status(code: number): Collector;
  writeHead(code: number, headers?: Record<string, Header>): Collector;
  write(chunk: unknown): boolean;
  json(body: unknown): Collector;
  send(body: unknown): Collector;
  end(chunk?: unknown): Collector;
  destroy(): void;
}

/** ServerResponse features a route could reach for that this collector does not implement: they fail by name. */
const UNSUPPORTED = ['flushHeaders', 'writeContinue', 'writeProcessing', 'addTrailers', 'appendHeader', 'pipe', 'on', 'once', 'emit', 'setTimeout', 'redirect'] as const;

function parseBody(body: unknown): unknown {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  if (typeof text !== 'string') return text ?? null;
  try { return JSON.parse(text); } catch { return text; }
}

function collector(): Collector {
  const headers = new Map<string, Header>();
  const chunks: string[] = [];
  let status = 200;
  const c: Collector = {
    // A real ServerResponse takes no status once its answer is out: a handler that threw late and an error handler
    // answering over it must not turn the first answer into a 500. The accessor below enforces it.
    statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, body: null,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return c; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    hasHeader(name) { return headers.has(name.toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    getHeaderNames() { return [...headers.keys()]; },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    status(code) { c.statusCode = code; return c; },
    writeHead(code, extra) {
      c.statusCode = code;
      for (const [k, v] of Object.entries(extra ?? {})) headers.set(k.toLowerCase(), v);
      return c;
    },
    write(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); return true; },
    // Both answer through end(), so a deferred end (withAuth) buffers them like a real response's.
    json(body) { return c.end(JSON.stringify(body) ?? ''); },
    send(body) { return c.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) ?? ''); },
    end(chunk) {
      // The first end wins, as on a real response. (A buffered end that withAuth replays or replaces is the REAL end
      // reached first, so its replaced 500 body still lands: nothing has ended yet when it runs.)
      if (c.writableEnded) return c;
      if (chunk !== undefined) c.body = parseBody(chunks.join('') + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)));
      else if (chunks.length) c.body = parseBody(chunks.join(''));
      c.writableEnded = true;
      return c;
    },
    destroy() { c.destroyed = true; },
  };
  Object.defineProperty(c, 'statusCode', {
    get: () => status,
    set: (code: number) => { if (!c.writableEnded) status = code; },
    enumerable: true,
  });
  for (const name of UNSUPPORTED) {
    (c as unknown as Record<string, unknown>)[name] = () => { throw new Error(`callApiInProcess: res.${name} is not supported`); };
  }
  return c;
}

/**
 * GET `url` on `handler` as the caller of `pageReq` (its cookies and headers). `query` is the route's
 * dynamic and query parameters, as Next would parse them. A handler that throws, destroys the response
 * or never answers is an error for the caller to handle; a 4xx or 5xx answer is returned as its status.
 */
export async function callApiInProcess(
  handler: NextApiHandler | ((req: NextApiRequest, res: NextApiResponse) => unknown),
  pageReq: IncomingMessage,
  target: { url: string; query: Record<string, string> },
): Promise<InProcessAnswer> {
  const req = {
    method: 'GET', url: target.url, query: target.query,
    headers: { ...pageReq.headers }, socket: pageReq.socket,
  } as unknown as NextApiRequest;
  const res = collector();
  await handler(req, res as unknown as NextApiResponse);
  if (res.destroyed) throw new Error(`API handler for ${target.url} aborted its response`);
  if (!res.writableEnded) throw new Error(`API handler for ${target.url} did not answer`);
  return { status: res.statusCode, body: res.body };
}
