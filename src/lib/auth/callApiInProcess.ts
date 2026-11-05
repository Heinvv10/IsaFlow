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

interface Collector {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  body: unknown;
  setHeader(name: string, value: unknown): Collector;
  getHeader(name: string): unknown;
  removeHeader(name: string): void;
  status(code: number): Collector;
  json(body: unknown): Collector;
  send(body: unknown): Collector;
  end(chunk?: unknown): Collector;
  destroy(): void;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body ?? null;
  try { return JSON.parse(body); } catch { return body; }
}

function collector(): Collector {
  const headers = new Map<string, unknown>();
  const c: Collector = {
    statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, body: null,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return c; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    status(code) { c.statusCode = code; return c; },
    json(body) { c.body = body; return c.end(); },
    send(body) { c.body = parseBody(body); return c.end(); },
    end(chunk) {
      if (!c.writableEnded && chunk !== undefined && c.body === null) c.body = parseBody(chunk);
      c.writableEnded = true;
      return c;
    },
    destroy() { c.destroyed = true; },
  };
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
