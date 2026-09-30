/**
 * R-159 test response: a stand-in for Next's response whose own end() is recorded. json sets a
 * header and funnels through end, as Next's does; setHeader after the status line is sent
 * throws, and end() refuses a body that is not a string or Buffer, as Node's do.
 */
export function response() {
  const ends: unknown[][] = [];
  const res = {
    statusCode: 200, headersSent: false, destroyed: false, body: undefined as unknown, headers: {} as Record<string, unknown>,
    destroy() { this.destroyed = true; return this; },
    status(code: number) { this.statusCode = code; return this; },
    setHeader(n: string, v: unknown) {
      if (this.headersSent) throw new Error('ERR_HTTP_HEADERS_SENT');
      this.headers[n.toLowerCase()] = v; return this;
    },
    getHeader(n: string) { return this.headers[n.toLowerCase()]; },
    writeHead(code: number) { this.statusCode = code; this.headersSent = true; return this; },
    write() { this.headersSent = true; return true; },
    json(b: unknown) { this.setHeader('Content-Type', 'application/json'); return this.end(JSON.stringify(b)); },
    end(...a: unknown[]) {
      if (a[0] !== undefined && typeof a[0] !== 'string' && !Buffer.isBuffer(a[0]) && typeof a[0] !== 'function') {
        throw new TypeError('ERR_INVALID_ARG_TYPE'); // as Node's does, before writing anything
      }
      ends.push(a);
      if (typeof a[0] === 'string' && !this.headersSent) this.body = JSON.parse(a[0]);
      return this;
    },
  };
  return { res, ends };
}

export type TestResponse = ReturnType<typeof response>['res'];

export async function call(wrapped: (req: never, res: never) => unknown, req: unknown) {
  const { res, ends } = response();
  let threw: unknown = null;
  try { await wrapped(req as never, res as never); } catch (err) { threw = err; }
  return {
    status: res.statusCode, body: res.body as Record<string, unknown> | undefined,
    ends: ends.length, endArgs: ends, destroyed: res.destroyed, threw,
  };
}

