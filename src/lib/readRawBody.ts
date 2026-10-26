/**
 * The bounded body reader under `withBodyFirst` (src/lib/readJsonBody.ts, which re-exports all of
 * this; import from there).
 *
 * The bounds hold while reading: a declared Content-Length over the cap is refused before a byte
 * is read, a stream that passes the cap at the chunk that crosses it, a body that pauses longer
 * than `idleMs` or takes longer than `totalMs` when the bound runs out, and a LARGE body that
 * arrives slower than MIN_BYTES_PER_SEC on average once MIN_RATE_AFTER_MS have passed (so a
 * client cannot hold a large in-flight budget by trickling). An optional `meter` sees every chunk
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
 * The minimum average rate for a large body, measured from the first byte awaited. A slow real
 * uplink is about 2 Mbit/s (250 KB/s), and a full 100 000-cell save (~17.2 MB) takes ~70 s on it;
 * half that rate is required, so such a client passes with room to spare, while one that sends a
 * few bytes a second to keep a large declared upload in flight is refused within seconds. Bodies
 * under MIN_RATE_FROM_BYTES (declared or received) are bounded by the idle and total limits only.
 */
export const MIN_BYTES_PER_SEC = 128 * 1024;
export const MIN_RATE_AFTER_MS = 2000;
export const MIN_RATE_FROM_BYTES = 1048576;

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

/** Sees each chunk's size before it is kept; a returned error refuses the body. */
export type BodyMeter = (bytes: number) => JsonBodyError | null;

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
    const started = Date.now();
    const large = Number.isFinite(declared) && declared >= MIN_RATE_FROM_BYTES;
    const chunks: Buffer[] = [];
    let size = 0;
    let idle: NodeJS.Timeout | undefined;
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
    const total = setTimeout(() => fail(slow('total')), totalMs);
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail(slow('idle')), idleMs);
    };
    function onData(chunk: Buffer | string) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > maxBytes) return fail(tooLarge(maxBytes));
      const refused = meter?.(buf.length);
      if (refused) return fail(refused);
      chunks.push(buf);
      const elapsed = Date.now() - started;
      if ((large || size >= MIN_RATE_FROM_BYTES) && elapsed > MIN_RATE_AFTER_MS && size / (elapsed / 1000) < MIN_BYTES_PER_SEC) {
        return fail(slow('rate'));
      }
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
