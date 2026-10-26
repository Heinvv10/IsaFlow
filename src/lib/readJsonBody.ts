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
 * gate (`earlyReader`; no database), within a per-user rate bucket, at most two reads and one
 * route maxBytes received in flight per user, and MAX_EARLY_READ_BYTES of large bodies in the
 * process; anyone else is left to withAuth and withCsrf to refuse, unread. Nothing is parsed until the handler runs, after every
 * withAuth check.
 *
 * The reader itself (size, idle, total and minimum-rate bounds, draining a refused body) is
 * ./readRawBody.ts, re-exported here.
 */
import type { IncomingMessage } from 'http';
import type { NextApiHandler, NextApiRequest } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { verifyCsrf } from '@/lib/auth/csrf';
import { ACCESS_COOKIE, parseCookies } from '@/lib/auth/cookies';
import { verifyToken } from '@/lib/auth/gotrue';
import { IMPERSONATION_PROOF_COOKIE } from '@/lib/auth/impersonation-cookies';
import { JsonBodyError, discard, parseJsonBody, readRawBody, respondBodyError, tooLarge, type BodyLimits } from './readRawBody';

export {
  JsonBodyError, MIN_BYTES_PER_SEC, MIN_RATE_AFTER_MS, MIN_RATE_FROM_BYTES, parseJsonBody, readJsonBody, readRawBody,
  respondBodyError, type BodyErrorCode, type BodyLimits, type BodyMeter,
} from './readRawBody';

const preRead = new WeakMap<object, Buffer>();

/** Early reads in flight per user (`sub`); one process's count, which is the pool it protects. */
const MAX_EARLY_READS_PER_USER = 2;
/**
 * Bytes RECEIVED (never merely declared) that early reads may hold, per user and per process. A
 * read holds its bytes and its per-user slot until the wrapped handler has finished with them,
 * not just until the read ends. A declared Content-Length only earns an immediate 413 over the
 * route's cap (counting it up front let accounts that declared 24 MB and sent nothing fill the
 * process budget, round-5 review). Per user: one route maxBytes in flight (18 MB for a save, one
 * full 100 000-cell batch). Per process: 64 MB of LARGE bodies, so three users at their limit still
 * leave room; a SMALL body (<= SMALL_BODY_BYTES, the normal grid save) is outside that budget, so
 * large uploads can never starve one (its memory is bounded by the per-user slots instead). A large
 * body must also keep MIN_BYTES_PER_SEC (readRawBody). Past the user's budget: 429; past the
 * process's: 503; both with Retry-After, at the chunk that crosses them.
 */
export const MAX_EARLY_READ_BYTES = 64 * 1048576;
export const SMALL_BODY_BYTES = 1048576;
const RETRY_AFTER_SECONDS = 5;
const readsOf = new Map<string, number>();
const bytesOf = new Map<string, number>();
let largeBytes = 0;

/** What the early reads hold right now: reads in flight and LARGE bytes held (tests wait on it). */
export function earlyReadStats(): { reads: number; bytes: number } {
  return { reads: [...readsOf.values()].reduce((a, b) => a + b, 0), bytes: largeBytes };
}

/**
 * Counts one read's received bytes: all of them against the user's budget, and once the body is
 * large (declared over SMALL_BODY_BYTES, or received past it) all of them against the process's.
 */
function meterFor(user: string, userBudget: number, declaredLarge: boolean) {
  let mine = 0;
  let counted = false;
  const meter = (n: number): JsonBodyError | null => {
    if ((bytesOf.get(user) ?? 0) + n > userBudget) {
      return new JsonBodyError(429, 'EARLY_READ_USER_BUDGET', 'Your other uploads are still arriving; send this one again when they have finished');
    }
    const large = declaredLarge || mine + n > SMALL_BODY_BYTES;
    const add = large ? (counted ? n : mine + n) : 0;
    if (largeBytes + add > MAX_EARLY_READ_BYTES) {
      return new JsonBodyError(503, 'EARLY_READ_PROCESS_BUDGET', 'The server is receiving too many uploads; try again in a moment');
    }
    largeBytes += add;
    counted = counted || large;
    mine += n;
    bytesOf.set(user, (bytesOf.get(user) ?? 0) + n);
    return null;
  };
  const release = () => {
    if (counted) largeBytes -= mine;
    const left = (bytesOf.get(user) ?? mine) - mine;
    if (left > 0) bytesOf.set(user, left);
    else bytesOf.delete(user);
  };
  return { meter, release };
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
 * Known cost: for an aal1 token, GoTrue's /user is asked twice per request (here, then by withAuth),
 * because withAuth makes its own verifyToken call and src/lib/auth/* is not changed to take a
 * result in; an aal2 token (MFA done) is checked locally both times.
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
 * a refusal is answered here. Before reading, in order: the route's rate bucket for the user (429;
 * 503 if the bucket itself is unavailable) and at most MAX_EARLY_READS_PER_USER reads in flight per
 * user (429); while reading, the received bytes against the user's and the process's budgets (429 /
 * 503). A refused body is drained. Inside, the handler takes the bytes with `takeRawBody` (or
 * `takeJsonBody`) and parses them only then; slot and bytes are released when it returns.
 */
export function withBodyFirst(limits: BodyLimits, inner: NextApiHandler, opts: BodyFirstOptions = {}): NextApiHandler {
  return async (req, res) => {
    const user = req.method === 'POST' ? await earlyReader(req) : null;
    if (user === null) return inner(req, res);
    const refuse = (status: 429 | 503, message: string, retryAfter: number) => {
      discard(req);
      res.setHeader('Retry-After', String(retryAfter));
      log.debug('Early body read refused', { url: req.url, user, status }, 'API');
      return status === 503 ? apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, message) : apiResponse.tooManyRequests(res, message);
    };
    if (opts.rate) {
      let admitted: boolean;
      try {
        admitted = await opts.rate.charge(user);
      } catch (err) {
        // The limiter's database is down: never admit unmetered, never Next's bare 500.
        log.error('Early body read: rate bucket unavailable', { url: req.url, user, error: err instanceof Error ? err.message : String(err) }, 'API');
        return refuse(503, 'Uploads are paused for a moment; try again shortly', RETRY_AFTER_SECONDS);
      }
      if (!admitted) return refuse(429, opts.rate.message, opts.rate.retryAfterSecs);
    }
    const reading = readsOf.get(user) ?? 0;
    if (reading >= MAX_EARLY_READS_PER_USER) {
      return refuse(429, 'Another upload of yours is still arriving; send this one again when it has finished', RETRY_AFTER_SECONDS);
    }
    const lim = effectiveLimits(limits);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > lim.maxBytes) {
      discard(req);
      return respondBodyError(res, tooLarge(lim.maxBytes));
    }
    readsOf.set(user, reading + 1);
    const budget = meterFor(user, lim.maxBytes, Number.isFinite(declared) && declared > SMALL_BODY_BYTES);
    log.debug('Early body read start', { url: req.url, user, declared, idleMs: lim.idleMs, totalMs: lim.totalMs }, 'API');
    try {
      try {
        preRead.set(req, await readRawBody(req, lim, budget.meter));
      } catch (err) {
        if (err instanceof JsonBodyError) return respondBodyError(res, err, RETRY_AFTER_SECONDS);
        throw err;
      }
      // The slot and the bytes stay held while the handler has them (the buffer lives until it is done).
      return await inner(req, res);
    } finally {
      budget.release();
      const left = (readsOf.get(user) ?? 1) - 1;
      if (left > 0) readsOf.set(user, left);
      else readsOf.delete(user);
      log.debug('Early body read end', { url: req.url, user }, 'API');
    }
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
