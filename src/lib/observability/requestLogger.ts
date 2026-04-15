/**
 * Emit a single structured log line per completed HTTP request.
 *
 * Shape:
 *   { event: 'request_completed', route, method, status, durationMs,
 *     userId, companyId, outcome }
 *
 * `outcome` is derived from status: <400 ok, <500 client_error, else server_error.
 * `route` strips the querystring from req.url.
 * `userId` / `companyId` are passed in by the caller (withErrorHandler pulls them
 * from req after withCompany has populated them, if present).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';

type Outcome = 'ok' | 'client_error' | 'server_error';

function outcomeFor(status: number): Outcome {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'ok';
}

function routeOf(url: string | undefined): string {
  if (!url) return '';
  const qIndex = url.indexOf('?');
  return qIndex === -1 ? url : url.slice(0, qIndex);
}

export interface LogRequestCompletedArgs {
  req: NextApiRequest;
  res: NextApiResponse;
  startMs: number;
  userId?: string | null;
  companyId?: string | null;
}

export function logRequestCompleted(args: LogRequestCompletedArgs): void {
  const { req, res, startMs, userId, companyId } = args;
  const status = res.statusCode;
  const payload = {
    event: 'request_completed' as const,
    route: routeOf(req.url),
    method: req.method ?? 'UNKNOWN',
    status,
    durationMs: Date.now() - startMs,
    userId: userId ?? null,
    companyId: companyId ?? null,
    outcome: outcomeFor(status),
  };
  log.info('request_completed', payload, 'http');
}
