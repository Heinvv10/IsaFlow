/**
 * Shared by the s07c-credential-paths*.int.test.ts suites: an unauthenticated
 * route call, the MCP bearer ping, a GoTrue stand-in that refuses every URL it
 * was not told about (no request leaves the process), and the rate-limit keys
 * every suite's route calls share through one client IP.
 */
import { createHash } from 'crypto';
import type { NextApiRequest } from 'next';
import { vi } from 'vitest';
import mcpRoute from '../../pages/api/mcp/index';
import { gotruePath, response } from './mfa-impersonation-postgres.helpers';
import { fixture } from './s07b-app-pool-login-role.helpers';

type Route = (req: never, res: never) => Promise<unknown>;
export interface Answer { status: number; body: unknown; headers: Map<string, unknown> }

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Call a public route (no session): JSON body, one fixed client IP. */
export async function callPublic(route: unknown, opts: {
  method?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string>;
}): Promise<Answer> {
  const req = { method: opts.method ?? 'POST', url: '/api/fixture', cookies: {}, query: opts.query ?? {},
    headers: { 'content-type': 'application/json', 'user-agent': 's07c', ...opts.headers },
    body: opts.body ?? {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body, headers: result.headers };
}

/** JSON-RPC ping to /api/mcp with `token` as the bearer (PAT or OAuth access token). */
export async function mcpPing(token: string): Promise<{ status: number; body: unknown }> {
  const r = await callPublic(mcpRoute, { headers: { authorization: `Bearer ${token}` },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  return { status: r.status, body: r.body };
}

/** Wait (bounded) for `probe` to return a truthy value: for fire-and-forget writes. */
export async function poll<T>(probe: () => Promise<T>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v || Date.now() > until) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every rate-limit bucket these suites' routes charge. */
export const clearRateLimits = () => fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE ANY ($1)`, [[
  '%company-invitations%', 'invitations:%', 'invite-accept%', 'forgot%', 'do-reset-password%', 'waitlist:%',
  'oauth-register%', 'oauth-token%', '%personal-tokens%', '%mcp%',
]]);

export interface GotrueCall { method: string; path: string; body: unknown }
type Reply = (call: GotrueCall) => Response | Promise<Response> | undefined;

export const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Stand in for GoTrue: `reply` answers what the test expects, anything it
 * leaves unanswered (and any URL outside GOTRUE_URL) throws, so a path that
 * calls something unexpected fails instead of reaching a network. Returns the
 * calls made, in order.
 */
export function stubGotrue(reply: Reply): GotrueCall[] {
  const calls: GotrueCall[] = [];
  const base = process.env.GOTRUE_URL!.replace(/\/+$/, '');
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const raw = String(input);
    if (!raw.startsWith(base)) throw new Error(`s07c: unexpected outbound fetch ${raw}`);
    const url = new URL(raw);
    const call = { method: init?.method ?? 'GET', path: `${gotruePath(url)}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const answer = await reply(call);
    if (!answer) throw new Error(`s07c: unexpected GoTrue call ${call.method} ${call.path}`);
    return answer;
  }));
  return calls;
}
