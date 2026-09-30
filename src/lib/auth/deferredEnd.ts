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
 * answers the throw itself, exactly as withErrorHandler would.
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
}

/**
 * Answers a throw that escaped the handler, after the caller has rolled back. `deferred` is
 * null when the throw came before the swap. Never rethrows: the response is the only answer.
 */
export function answerThrow(
  req: NextApiRequest,
  res: NextApiResponse,
  deferred: DeferredEnd | null,
  err: unknown,
  ctx: ThrowContext,
): void {
  const route = sanitizeRoute(req.url);
  log.error(`${ctx.source}: handler threw, transaction rolled back`, {
    route,
    companyId: ctx.companyId,
    userId: ctx.userId,
    message: err instanceof Error ? err.message : String(err),
  }, 'Auth');
  if (process.env.SENTRY_ENABLED === 'true') {
    Sentry.captureException(err, {
      tags: { ...(ctx.companyId && { company_id: ctx.companyId }), ...(route && { route }) },
      ...(ctx.userId && { user: { id: ctx.userId } }),
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (deferred) (res as any).end = deferred.realEnd;
  if (res.headersSent) {
    // A streaming route already sent its status line; it cannot become a 500. Close the
    // response with whatever the handler buffered, so the socket is not left open.
    res.end(...((deferred?.args ?? []) as []));
    return;
  }
  respondToUnhandledError(res, err);
}
