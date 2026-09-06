// src/lib/pdf/withRenderSlot.ts
//
// The render bound as an OUTER route wrapper: `withRenderSlot(withAuth(...))`.
//
// Why outside withAuth. withAuth takes a pool connection and opens a
// transaction before it calls the handler, and holds both until the handler
// returns. While the render slot was acquired inside the handler, a request
// WAITING for a slot was already holding a connection and an open transaction
// — so the queue itself consumed the resource the bound exists to protect.
// Twenty-five parallel exports from one viewer (inside the per-company export
// rate limit) took every connection in the pool, and the renders' own inbound
// fetch for the report then had none left to serve it: the bound deadlocked
// the thing it was bounding. Acquiring the slot before withAuth runs means a
// queued or refused request holds no connection at all.
//
// THE PRECHECK. An unauthenticated request must not be able to occupy a slot,
// but authenticating it here would need the connection this wrapper exists to
// defer. The compromise is the cheapest possible check that costs no I/O: an
// `sb-access-token` cookie must be PRESENT. Requests without one are passed
// straight through to withAuth, which 401s them without ever taking a slot.
// Presence is not validity — a request carrying a junk cookie still takes a
// slot for as long as withAuth needs to reject it, which is one round trip to
// GoTrue, not a render. The queue bound is what caps that.
//
// RESIDUAL, accepted: a render that HAS been admitted still runs inside
// withAuth's open transaction, for up to the 30s print-ready gate plus
// transport overhead. Bounded at three concurrent, that is three idle-in-
// transaction connections at worst, which the pool carries. See
// src/lib/pdf/.claude.md.

import type { NextApiHandler } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';
import { acquireRenderSlot, RenderCapacityError, RenderQueueFullError } from './renderSemaphore';

const BUSY_MESSAGE = 'PDF exports are busy right now. Please try again in a moment.';

export function withRenderSlot(handler: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    // No session cookie at all: let withAuth answer, without spending a slot.
    if (!parseCookies(req)[ACCESS_COOKIE]) return handler(req, res);

    try {
      return await acquireRenderSlot(async () => { await handler(req, res); });
    } catch (err) {
      if (err instanceof RenderCapacityError || err instanceof RenderQueueFullError) {
        log.warn('withRenderSlot: refused, no render slot', { url: req.url, reason: err.name }, 'pdf');
        return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, BUSY_MESSAGE);
      }
      throw err;
    }
  };
}
