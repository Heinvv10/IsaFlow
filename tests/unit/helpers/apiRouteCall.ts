/** Calls a Next API route handler with a fake request/response (auth wrappers are mocked to pass-throughs by the test). */
import type { NextApiRequest, NextApiResponse } from 'next';

export interface RouteResult { code: number; body: unknown; headers: Record<string, string | string[]> }

export async function callRoute(
  handler: unknown,
  opts: { method?: string; query?: Record<string, unknown>; body?: unknown; role?: string; headers?: Record<string, string> } = {},
): Promise<RouteResult> {
  const out: RouteResult = { code: 0, body: undefined, headers: {} };
  const res = {
    status(c: number) { out.code = c; return this; },
    setHeader(k: string, v: string | string[]) { out.headers[k] = v; return this; },
    getHeader(k: string) { return out.headers[k]; },
    send(b: unknown) { out.body = b; return this; },
    json(b: unknown) { out.body = b; return this; },
    end(b?: unknown) { if (b !== undefined) out.body = b; return this; },
  };
  const req = {
    method: opts.method ?? 'GET', query: opts.query ?? {}, body: opts.body, headers: opts.headers ?? {},
    companyId: 'aaaaaaaa-0000-4000-8000-000000000001', companyRole: opts.role ?? 'owner',
    user: { id: 'bbbbbbbb-0000-4000-8000-000000000002' }, socket: { remoteAddress: '127.0.0.1' },
  };
  await (handler as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return out;
}

export const UUID_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const BAD_IDS = ['not-a-uuid', "x' OR 1=1 --", '12345'];
