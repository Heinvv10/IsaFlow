/**
 * Reads a request body for a route that sets `export const config = { api: { bodyParser: false } }`,
 * bounded in size AND time, BEFORE withAuth opens the request transaction.
 *
 * Why a route reads its own body: with Next's body parser on, a large body is buffered and parsed
 * before any authentication, and withErrorHandler then logs the parsed `req.body`. Read here, the
 * body is never on `req.body`, so the request log carries none.
 *
 * Why before the transaction (`withBodyFirst`): withAuth BEGINs the request transaction on a
 * pooled connection before the handler runs, so a body read inside the handler keeps that
 * connection idle in the transaction while the client sends it: ten slow clients held the whole
 * auth pool and an unrelated read timed out (round-3 breaker P). The wrapper reads the raw bytes
 * first, but only for a caller who passes the CSRF double-submit check and holds a validly signed
 * session token (both local: no database, no network); anyone else is left to withAuth and
 * withCsrf to refuse, unread. Nothing is parsed until the handler runs, after every withAuth check.
 *
 * The bounds hold while reading: a declared Content-Length over the cap is refused before a byte
 * is read, a stream that passes the cap at the chunk that crosses it, a body that pauses longer
 * than `idleMs` or takes longer than `totalMs` when the bound runs out. On a refusal every
 * listener comes off and the request is resumed, so the rest drains unbuffered and the connection
 * is free again (the async iterator used before left a 'readable' listener on, so resume() did
 * nothing and an over-cap upload stalled the socket until the server's request timeout).
 */
import type { IncomingMessage } from 'http';
import type { NextApiHandler, NextApiRequest } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { verifyCsrf } from '@/lib/auth/csrf';
import { ACCESS_COOKIE, parseCookies } from '@/lib/auth/cookies';
import { verifyTokenSignature } from '@/lib/auth/gotrue';

export interface BodyLimits {
  maxBytes: number;
  /** The whole body must arrive within this. */
  totalMs: number;
  /** No gap between two chunks may be longer than this. */
  idleMs: number;
}

/** Over the cap (413), too slow (400, REQUEST_BODY_TIMEOUT), not JSON (400) or a broken stream (400). */
export class JsonBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: 'REQUEST_BODY_TOO_LARGE' | 'REQUEST_BODY_TIMEOUT' | 'REQUEST_BODY_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

const tooLarge = (maxBytes: number) =>
  new JsonBodyError(413, 'REQUEST_BODY_TOO_LARGE', `The request body is larger than ${Math.floor(maxBytes / 1048576)} MB`);

/**
 * Drops what is left of a refused body: the reader's own listeners are already off; resume() lets
 * the rest flow out unbuffered. Only a 'data' reader is ever attached (never 'readable', an async
 * iterator included): Node does not let a stream with a 'readable' listener flow, and removing
 * one afterwards puts it back to not flowing, so either way the upload stalled on a real socket.
 */
function discard(req: IncomingMessage): void {
  req.on('error', (err: Error) => log.warn('Discarded request body failed', { url: req.url, error: err.message }, 'API'));
  req.resume();
}

/** The raw body, bounded by `limits`. */
export function readRawBody(req: IncomingMessage, limits: BodyLimits): Promise<Buffer> {
  const { maxBytes, totalMs, idleMs } = limits;
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(req);
      reject(tooLarge(maxBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let idle: NodeJS.Timeout | undefined;
    const slow = () => new JsonBodyError(400, 'REQUEST_BODY_TIMEOUT', 'The request body arrived too slowly; send it again');
    const stop = () => {
      clearTimeout(idle);
      clearTimeout(total);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (err: JsonBodyError) => {
      stop();
      discard(req);
      reject(err);
    };
    const total = setTimeout(() => fail(slow()), totalMs);
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(slow()), idleMs);
    };
    function onData(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return fail(tooLarge(maxBytes));
      chunks.push(buf);
      armIdle();
    }
    function onEnd() {
      stop();
      resolve(Buffer.concat(chunks, size));
    }
    function onError(err: Error) {
      log.warn('Request body stream failed', { url: req.url, error: err.message }, 'API');
      fail(new JsonBodyError(400, 'REQUEST_BODY_INVALID', 'The request body could not be read'));
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    armIdle();
  });
}

/** `JSON.parse` of a raw body; anything else is 400 REQUEST_BODY_INVALID. */
export function parseJsonBody(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new JsonBodyError(400, 'REQUEST_BODY_INVALID', 'The request body is not valid JSON');
  }
}

/** The JSON body, bounded by `limits` (read and parsed here and now). */
export async function readJsonBody(req: IncomingMessage, limits: BodyLimits): Promise<unknown> {
  return parseJsonBody(await readRawBody(req, limits));
}

/** Answers a JsonBodyError with its status and code. */
export function respondBodyError(res: Parameters<NextApiHandler>[1], err: JsonBodyError): void {
  apiResponse.error(res, err.status === 413 ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.BAD_REQUEST, err.message, { code: err.code });
}

const preRead = new WeakMap<object, Buffer>();

/** A caller who passes CSRF and holds a validly signed session token (local checks only). */
async function mayReadEarly(req: NextApiRequest): Promise<boolean> {
  if (!verifyCsrf(req)) return false;
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) return false;
  return verifyTokenSignature(token).then(() => true, () => false);
}

/**
 * Wraps a write route OUTSIDE withAuth: for a POST from a caller who passes the local gates above,
 * the raw body is read (bounded by `limits`) before withAuth takes a connection and opens the
 * transaction; a refusal is answered here. Inside, the handler takes the bytes with `takeRawBody`
 * (or `takeJsonBody`) and parses them only then, after every withAuth check.
 */
export function withBodyFirst(limits: BodyLimits, inner: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    if (req.method === 'POST' && await mayReadEarly(req)) {
      try {
        preRead.set(req, await readRawBody(req, limits));
      } catch (err) {
        if (err instanceof JsonBodyError) return respondBodyError(res, err);
        throw err;
      }
    }
    return inner(req, res);
  };
}

/** The bytes `withBodyFirst` read; a request it left unread (not expected past withAuth) is read here, bounded. */
export async function takeRawBody(req: IncomingMessage, limits: BodyLimits): Promise<Buffer> {
  const early = preRead.get(req);
  if (early) {
    preRead.delete(req);
    return early;
  }
  return readRawBody(req, limits);
}

/** `takeRawBody`, parsed as JSON. */
export async function takeJsonBody(req: IncomingMessage, limits: BodyLimits): Promise<unknown> {
  return parseJsonBody(await takeRawBody(req, limits));
}
