/**
 * The bounded body reader under `withBodyFirst` (src/lib/readJsonBody.ts, which re-exports all of
 * this; import from there).
 *
 * The bounds hold while reading: a declared Content-Length over the cap is refused before a byte
 * is read, a stream that passes the cap at the chunk that crosses it, a body that pauses longer
 * than `idleMs` or outlasts its tier's total time, a large body under its rate floor, and a
 * request already aborted at once. An optional `meter` sees every chunk (with the body's tier)
 * before it is kept and may refuse it (the early-read byte budgets). On a refusal the reader's
 * listeners come off and the request is resumed, so the rest drains unbuffered and the connection
 * is free again; only 'data' is ever listened to, never 'readable' (with a 'readable' listener on,
 * or removed afterwards, resume() does nothing and an over-cap upload stalled the socket).
 */
import type { IncomingMessage } from 'http';
import type { NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { log } from '@/lib/logger';

export interface BodyLimits {
  maxBytes: number;
  /** The whole body must arrive within this. */
  totalMs: number;
  /** No gap between two chunks may be longer than this. */
  idleMs: number;
}

/**
 * Three tiers by size (the declared Content-Length, or the bytes received once they pass it; an
 * undeclared body starts tiny). What an early read can HOLD is bounded by the bytes it has actually
 * received (readJsonBody's per-user and per-lane budgets); HOW LONG it can hold them is bounded by
 * the idle timer, the tier's total time and, for a large body, a low rate floor. Round-7 ruling:
 *  - tiny (<= 64 KB, a real grid save is a few KB): only its own 128 MB backstop lane (1 000
 *    accounts' worth), so nobody's larger uploads can ever starve a normal save; 15 s in all.
 *  - small (<= 1 MB): the 32 MB small lane; 30 s in all (1 MB at ADSL's ~54 KB/s takes ~19 s).
 *  - large: the 64 MB large lane; the route's total (290 s for a save); and at least 16 KB/s on
 *    average from its FIRST byte once 10 s have passed. 512 kbit/s ADSL really carries ~54 KB/s, a
 *    3x margin;
 *    a pause before the first byte costs nothing here (the idle timer bounds it). An earlier
 *    128 KB/s floor measured from the start refused real ADSL and weak-LTE users (round 6).
 */
export type BodyTier = 'tiny' | 'small' | 'large';
export const TINY_BODY_BYTES = 64 * 1024;
export const SMALL_BODY_BYTES = 1048576;
export const TINY_TOTAL_MS = 15_000;
export const SMALL_TOTAL_MS = 30_000;
export const LARGE_MIN_BYTES_PER_SEC = 16 * 1024;
export const LARGE_RATE_GRACE_MS = 10_000;
const TIER_RANK: Record<BodyTier, number> = { tiny: 0, small: 1, large: 2 };

/** The tier of a body of `bytes` (the one place the size boundaries are compared). */
export const tierOf = (bytes: number): BodyTier => (bytes > SMALL_BODY_BYTES ? 'large' : bytes > TINY_BODY_BYTES ? 'small' : 'tiny');

export type BodyErrorCode =
  | 'REQUEST_BODY_TOO_LARGE' | 'REQUEST_BODY_TIMEOUT' | 'REQUEST_BODY_INVALID' | 'REQUEST_BODY_NOT_READ'
  | 'EARLY_READ_USER_BUDGET' | 'EARLY_READ_PROCESS_BUDGET';

/**
 * Over the cap (413), too slow (400 REQUEST_BODY_TIMEOUT), not JSON or a broken stream (400
 * REQUEST_BODY_INVALID), not read before withAuth (400 REQUEST_BODY_NOT_READ), or over an
 * early-read byte budget: the user's (429) or the process's (503), both with Retry-After.
 */
export class JsonBodyError extends Error {
  constructor(readonly status: 400 | 413 | 429 | 503, readonly code: BodyErrorCode, message: string) {
    super(message);
    this.name = 'JsonBodyError';
  }
}

export const tooLarge = (maxBytes: number) =>
  new JsonBodyError(413, 'REQUEST_BODY_TOO_LARGE', `The request body is larger than ${Math.floor(maxBytes / 1048576)} MB`);

/** Drops what is left of a refused body: resume() lets the rest flow out unbuffered. */
export function discard(req: IncomingMessage): void {
  req.on('error', (err: Error) => log.warn('Discarded request body failed', { url: req.url, error: err.message }, 'API'));
  req.resume();
}

/** Sees each chunk's size, and the body's tier with it counted, before it is kept; a returned error refuses the body. */
export type BodyMeter = (bytes: number, tier: BodyTier) => JsonBodyError | null;

/** The raw body, bounded by `limits` (and `meter`, when given). */
export function readRawBody(req: IncomingMessage, limits: BodyLimits, meter?: BodyMeter): Promise<Buffer> {
  const { maxBytes, totalMs, idleMs } = limits;
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      discard(req);
      reject(tooLarge(maxBytes));
      return;
    }
    // A client that has already gone emits nothing more: refuse now, not when the idle timer fires
    // (until then the request would hold its read slot).
    if (req.destroyed || (req as { aborted?: boolean }).aborted) {
      reject(new JsonBodyError(400, 'REQUEST_BODY_INVALID', 'The request was aborted before its body arrived'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let idle: NodeJS.Timeout | undefined;
    let total: NodeJS.Timeout | undefined;
    let firstByteAt = 0;
    const started = Date.now();
    let tier: BodyTier = Number.isFinite(declared) ? tierOf(declared) : 'tiny';
    const tierTotal = (t: BodyTier) => (t === 'tiny' ? Math.min(TINY_TOTAL_MS, totalMs) : t === 'small' ? Math.min(SMALL_TOTAL_MS, totalMs) : totalMs);
    const slow = (timer: 'idle' | 'total' | 'rate') => {
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
    /** The total timer for the current tier, measured from the start of the read. */
    const armTotal = () => {
      clearTimeout(total);
      total = setTimeout(() => fail(slow('total')), Math.max(0, started + tierTotal(tier) - Date.now()));
    };
    armTotal();
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(slow('idle')), idleMs);
    };
    function onData(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return fail(tooLarge(maxBytes));
      const now = Date.now();
      if (!firstByteAt) firstByteAt = now;
      const grown = tierOf(size);
      if (TIER_RANK[grown] > TIER_RANK[tier]) {
        tier = grown;
        armTotal();
      }
      const refused = meter?.(buf.length, tier);
      if (refused) return fail(refused);
      chunks.push(buf);
      const sending = now - firstByteAt;
      if (tier === 'large' && sending > LARGE_RATE_GRACE_MS && size / (sending / 1000) < LARGE_MIN_BYTES_PER_SEC) return fail(slow('rate'));
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

const ANSWER: Record<JsonBodyError['status'], ErrorCode> = {
  400: ErrorCode.BAD_REQUEST, 413: ErrorCode.PAYLOAD_TOO_LARGE, 429: ErrorCode.RATE_LIMIT, 503: ErrorCode.SERVICE_UNAVAILABLE,
};

/** Answers a JsonBodyError with its status and code (a budget refusal with Retry-After). */
export function respondBodyError(res: NextApiResponse, err: JsonBodyError, retryAfterSecs = 5): void {
  if (err.status === 429 || err.status === 503) res.setHeader('Retry-After', String(retryAfterSecs));
  apiResponse.error(res, ANSWER[err.status], err.message, { code: err.code });
}
