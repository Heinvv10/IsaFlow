/** A minimal Next API request/response pair for calling an admin route handler directly in a unit test. */
import type { NextApiRequest, NextApiResponse } from 'next';

export async function callRoute(route: unknown, method: string, query: Record<string, unknown>, body: unknown = {}) {
  const req = { method, query, body, user: { id: 'platform-admin' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    setHeader() { return res; },
  } as unknown as NextApiResponse;
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req, res);
  return state;
}
