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
 * first, but only for a caller who passes the CSRF double-submit check and withAuth's own token
 * gate (`earlyReader`; no database), within a per-user rate bucket, at most two at a time per user
 * and MAX_EARLY_READ_BYTES in the process; anyone else is left to
 * withAuth and withCsrf to refuse, unread. Nothing is parsed until the handler runs, after every
 * withAuth check.
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
import { verifyToken } from '@/lib/auth/gotrue';
import { IMPERSONATION_PROOF_COOKIE } from '@/lib/auth/impersonation-cookies';

export interface BodyLimits {
  maxBytes: number;
  /** The whole body must arrive within this. */
  totalMs: number;
  /** No gap between two chunks may be longer than this. */
  idleMs: number;
}

/**
 * Over the cap (413), too slow (400 REQUEST_BODY_TIMEOUT), not JSON or a broken stream (400
 * REQUEST_BODY_INVALID), or not read before withAuth (400 REQUEST_BODY_NOT_READ, see takeRawBody).
 */
export class JsonBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: 'REQUEST_BODY_TOO_LARGE' | 'REQUEST_BODY_TIMEOUT' | 'REQUEST_BODY_INVALID' | 'REQUEST_BODY_NOT_READ',
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
    const slow = (timer: 'idle' | 'total') => {
      log.debug('Request body timer fired', { url: req.url, timer, idleMs, totalMs, bytes: size }, 'API');
      return new JsonBodyError(400, 'REQUEST_BODY_TIMEOUT', 'The request body arrived too slowly; send it again');
    };
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
    const total = setTimeout(() => fail(slow('total')), totalMs);
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(slow('idle')), idleMs);
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

/** Early reads in flight per user (`sub`); one process's count, which is the pool it protects. */
const MAX_EARLY_READS_PER_USER = 2;
/**
 * Bytes all early reads in flight may hold in this process, whoever sends them. Each read reserves
 * its declared Content-Length (or the route's cap when none is sent) before reading and may read no
 * more. 64 MB is about two and a half of the largest saves (24 MB) or six of the largest import
 * previews (10 MB); a grid save is usually a few KB. Over it: 503 with Retry-After, nothing read.
 */
export const MAX_EARLY_READ_BYTES = 64 * 1048576;
const RETRY_AFTER_SECONDS = 5;
const readsOf = new Map<string, number>();
let bytesReserved = 0;

/** What the early reads hold right now (tests wait on it instead of sleeping). */
export function earlyReadStats(): { reads: number; bytes: number } {
  return { reads: [...readsOf.values()].reduce((a, b) => a + b, 0), bytes: bytesReserved };
}

/**
 * `limits`, or under Vitest the BODY_READ_IDLE_MS / BODY_READ_TOTAL_MS a suite stubs (so a slow-body
 * test waits 1 s, not the route's 5-15 s). Never read outside Vitest.
 */
export function effectiveLimits(limits: BodyLimits): BodyLimits {
  if (process.env.VITEST !== 'true') return limits;
  const ms = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return { ...limits, idleMs: ms('BODY_READ_IDLE_MS', limits.idleMs), totalMs: ms('BODY_READ_TOTAL_MS', limits.totalMs) };
}

/**
 * The user a body may be read early for, or null (left unread for withAuth/withCsrf to refuse).
 * The same token gate withAuth runs first, `verifyToken`: signature and expiry, then aal2, a valid
 * impersonation proof, or (for an aal1 token) GoTrue confirming no MFA factor is enrolled, a
 * network call but no database. Membership and account standing cannot be checked without the
 * database, so a signed-in user of ANY company passes this gate: the per-user rate bucket and cap
 * and the per-process byte cap below bound what such a user can make the server read.
 */
async function earlyReader(req: NextApiRequest): Promise<string | null> {
  if (!verifyCsrf(req)) return null;
  const cookies = parseCookies(req);
  const token = cookies[ACCESS_COOKIE];
  if (!token) return null;
  // Refused or unanswered here: withAuth asks again and gives the real answer (401 or 503).
  return verifyToken(token, cookies[IMPERSONATION_PROOF_COOKIE]).then((claims) => claims.sub, () => null);
}

export interface BodyFirstOptions {
  /**
   * A per-user rate bucket charged BEFORE the read: `charge` calls checkRateLimit with the route's
   * own literal key (so the rate-limit key census reads it at the route), false means full: 429.
   */
  rate?: { charge: (userId: string) => Promise<boolean>; retryAfterSecs: number; message: string };
}

/**
 * Wraps a write route OUTSIDE withAuth: for a POST from a caller who passes `earlyReader`, the raw
 * body is read (bounded by `limits`) before withAuth takes a connection and opens the transaction;
 * a refusal is answered here. Before reading, in order: the route's rate bucket for the user (429),
 * at most MAX_EARLY_READS_PER_USER reads in flight per user (429), and MAX_EARLY_READ_BYTES in
 * flight in the process (503); a refused body is drained, never read. Inside, the handler takes
 * the bytes with `takeRawBody` (or `takeJsonBody`) and parses them only then.
 */
export function withBodyFirst(limits: BodyLimits, inner: NextApiHandler, opts: BodyFirstOptions = {}): NextApiHandler {
  return async (req, res) => {
    const user = req.method === 'POST' ? await earlyReader(req) : null;
    if (user !== null) {
      const busy = (status: 'rate' | 'user' | 'process', message: string) => {
        discard(req);
        res.setHeader('Retry-After', String(status === 'rate' ? opts.rate!.retryAfterSecs : RETRY_AFTER_SECONDS));
        log.debug('Early body read refused', { url: req.url, user, status }, 'API');
        if (status === 'process') return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, message);
        return apiResponse.tooManyRequests(res, message);
      };
      if (opts.rate && !(await opts.rate.charge(user))) {
        return busy('rate', opts.rate.message);
      }
      const reading = readsOf.get(user) ?? 0;
      if (reading >= MAX_EARLY_READS_PER_USER) {
        return busy('user', 'Another upload of yours is still arriving; send this one again when it has finished');
      }
      const lim = effectiveLimits(limits);
      const declared = Number(req.headers['content-length']);
      const reserve = Number.isFinite(declared) && declared >= 0 ? Math.min(declared, lim.maxBytes) : lim.maxBytes;
      if (Number.isFinite(declared) && declared > lim.maxBytes) {
        discard(req);
        return respondBodyError(res, tooLarge(lim.maxBytes));
      }
      if (bytesReserved + reserve > MAX_EARLY_READ_BYTES) return busy('process', 'The server is receiving too many uploads; try again in a moment');
      readsOf.set(user, reading + 1);
      bytesReserved += reserve;
      log.debug('Early body read start', { url: req.url, user, reserve, idleMs: lim.idleMs, totalMs: lim.totalMs }, 'API');
      try {
        preRead.set(req, await readRawBody(req, { ...lim, maxBytes: reserve }));
      } catch (err) {
        if (err instanceof JsonBodyError) return respondBodyError(res, err);
        throw err;
      } finally {
        bytesReserved -= reserve;
        const left = (readsOf.get(user) ?? 1) - 1;
        if (left > 0) readsOf.set(user, left);
        else readsOf.delete(user);
        log.debug('Early body read end', { url: req.url, user }, 'API');
      }
    }
    return inner(req, res);
  };
}

/**
 * The bytes `withBodyFirst` read. A request it did not read (the gate refused it and withAuth then
 * let it in, e.g. GoTrue failed once and answered the second time) is REFUSED, never read here:
 * the handler runs inside withAuth's transaction, and reading there held a pooled connection.
 */
export async function takeRawBody(req: IncomingMessage): Promise<Buffer> {
  const early = preRead.get(req);
  if (!early) {
    discard(req);
    throw new JsonBodyError(400, 'REQUEST_BODY_NOT_READ', 'The request body was not received before the sign-in checks; send it again');
  }
  preRead.delete(req);
  return early;
}

/** `takeRawBody`, parsed as JSON. */
export async function takeJsonBody(req: IncomingMessage): Promise<unknown> {
  return parseJsonBody(await takeRawBody(req));
}
