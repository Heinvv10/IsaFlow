// src/lib/auth/deferredEnd.ts
/**
 * The deferred response flush shared by the three wrappers that own a request transaction:
 * withAuth, the Bearer pipeline and withExtensionToken.
 *
 * The handler calls res.json/res.end INSIDE the open transaction. Next's res.json and res.send
 * both funnel through res.end, so swapping res.end for a buffer holds back the one final end()
 * until the wrapper has COMMITted or rolled back; the wrapper then replays it through realEnd.
 *
 * R-159: a handler that THROWS never returns to the replay. The wrappers used to roll back and
 * rethrow with res.end still swapped, so every later answer (an outer withErrorHandler, Next's
 * own 500) landed in the buffer and the client hung. answerThrow puts the real end back and
 * answers the throw itself, exactly as withErrorHandler would. replayEnd sends the buffer after
 * the transaction is final and never throws, so nothing past COMMIT reaches the wrapper's catch.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as Sentry from '@sentry/nextjs';
import { log } from '@/lib/logger';
import { respondToUnhandledError } from '@/lib/api-error-handler';
import { sanitizeRoute } from '@/lib/sentry/tags';

export interface DeferredEnd {
  /** The response's own end, as it was before the swap. */
  readonly realEnd: (...args: unknown[]) => unknown;
  /** True once the handler has called end. */
  readonly ended: boolean;
  /** The arguments of that one end call; null until then. */
  readonly args: unknown[] | null;
}

/** Swaps res.end for a buffer that keeps the first call and ignores the rest. */
export function deferEnd(res: NextApiResponse): DeferredEnd {
  const state = { realEnd: res.end.bind(res) as (...args: unknown[]) => unknown, ended: false, args: null as unknown[] | null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (res as any).end = (...args: unknown[]) => {
    if (state.ended) return res; // double-end guard — flush exactly once
    state.ended = true;
    state.args = args;
    return res;
  };
  return state;
}

export interface ThrowContext {
  /** The wrapper, for the log line. */
  source: string;
  companyId?: string;
  userId?: string;
  /** Wrapper-specific fields for the log line, e.g. the extension's connectionId. */
  extra?: Record<string, unknown>;
  /** answerThrow only: whether the caller's ROLLBACK succeeded. */
  rolledBack?: boolean;
}

/** An error's text for a log line; an error whose message cannot be read must not escape. */
function describe(err: unknown): { message: string; stack?: string } {
  try {
    return err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) };
  } catch {
    return { message: '[unprintable error]' };
  }
}

/**
 * Ends a response whose status line is already on the wire and whose transaction did not
 * commit. Closing it cleanly would hand the client a complete-looking 2xx for a rolled-back
 * write, so the connection is aborted instead.
 */
export function abortResponse(res: NextApiResponse): void {
  res.destroy();
}

/**
 * Answers a COMMIT that failed. The buffered 2xx must not go out: the write did not land, or its
 * outcome is unknown. 500 COMMIT_FAILED replaces it; a response whose status line is already on
 * the wire is aborted, because a clean close would read as success.
 */
export function answerCommitFailed(res: NextApiResponse, deferred: DeferredEnd): void {
  if (res.headersSent) {
    abortResponse(res);
    return;
  }
  const body = JSON.stringify({ success: false, data: null, message: 'An unexpected error occurred', code: 'COMMIT_FAILED' });
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  deferred.realEnd(body);
}

/**
 * Sends the buffered end once the transaction is final. It never throws: the transaction may
 * already have COMMITted, so a failure here (Node refuses `end({ id })`, for one) must not
 * reach the wrapper's catch, which would ROLLBACK a committed write and tell the client it
 * failed. It is logged and the response aborted.
 */
export function replayEnd(res: NextApiResponse, deferred: DeferredEnd, ctx: ThrowContext): void {
  if (!deferred.ended) return;
  try {
    deferred.realEnd(...(deferred.args ?? []));
  } catch (err) {
    log.error(`${ctx.source}: response replay failed after the transaction was finalised`, {
      companyId: ctx.companyId, userId: ctx.userId, ...ctx.extra, ...describe(err),
    }, 'Auth');
    abortResponse(res);
  }
}

/**
 * Answers a throw inside the request transaction (from the handler, or from the wrapper's own
 * steps such as BEGIN or the rate limiter), after the caller has tried to roll back. `deferred`
 * is null when the throw came before the swap. Never rethrows: the response is the only answer.
 */
export function answerThrow(
  req: NextApiRequest,
  res: NextApiResponse,
  deferred: DeferredEnd | null,
  err: unknown,
  ctx: ThrowContext,
): void {
  // The real end goes back first, so nothing below can leave the client on the dead buffer.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (deferred) (res as any).end = deferred.realEnd;
  const route = sanitizeRoute(req.url);
  log.error(`${ctx.source}: request threw inside its transaction`, {
    route,
    rolledBack: ctx.rolledBack,
    companyId: ctx.companyId,
    userId: ctx.userId,
    ...ctx.extra,
    ...describe(err),
  }, 'Auth');
  if (process.env.SENTRY_ENABLED === 'true') {
    try {
      Sentry.captureException(err, {
        tags: { ...(ctx.companyId && { company_id: ctx.companyId }), ...(route && { route }) },
        ...(ctx.userId && { user: { id: ctx.userId } }),
      });
    } catch (sentryErr) {
      log.warn(`${ctx.source}: Sentry capture failed`, describe(sentryErr), 'Auth');
    }
  }
  if (res.headersSent) {
    // A streaming route already sent its status line; it cannot become a 500. Abort it unless
    // it already ended through the real end, which must not be cut off mid-flush.
    if (!res.writableEnded) abortResponse(res);
    return;
  }
  try {
    respondToUnhandledError(res, err);
  } catch (respondErr) {
    // The responder read something off the error that threw. Answer with a fixed body.
    log.error(`${ctx.source}: error response failed`, describe(respondErr), 'Auth');
    const body = JSON.stringify({ success: false, data: null, message: 'An unexpected error occurred', code: 'INTERNAL_SERVER_ERROR' });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(body);
  }
}
