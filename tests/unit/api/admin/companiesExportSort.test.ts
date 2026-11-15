/**
 * Companies CSV export sort (WP10 review): DB-free. The export sorts exactly as the Companies list API does:
 *   - sort_by is an OWN key of the allowlist: `constructor` & co. are 400 before any SQL (a plain lookup would
 *     pass them to sql.unsafe);
 *   - plan_name and last_active (output aliases) sort NULLS LAST, then c.id;
 *   - sort_dir without sort_by sorts c.created_at in that direction (the list defaults the column, not the
 *     direction).
 * The SQL is captured by a fake tagged template that renders fragments and sql.unsafe text inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/admin/services/auditService', () => ({ logAdminAction: vi.fn(async () => undefined) }));

interface Frag { __sql: string }
const fx = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('@/lib/neon', () => {
  const render = (strings: TemplateStringsArray, vals: unknown[]): string =>
    strings.reduce((acc, s, i) => {
      const v = vals[i - 1];
      const part = v && typeof v === 'object' && '__sql' in (v as object) ? (v as Frag).__sql : '$';
      return acc + part + s;
    });
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = render(strings, vals);
      const frag = { __sql: text } as Frag & { then?: unknown };
      // Awaited only as a whole query: record it and answer one row for the plans lookup, none otherwise.
      frag.then = (ok: (rows: unknown[]) => unknown) => {
        fx.queries.push(text.replace(/\s+/g, ' ').trim());
        return Promise.resolve(text.includes('FROM plans') ? [{ '?column?': 1 }] : []).then(ok);
      };
      return frag;
    },
    { unsafe: (s: string) => ({ __sql: s }) },
  );
  return { sql };
});

import route from '../../../../pages/api/admin/companies/export';

async function call(query: Record<string, string>) {
  const state = { statusCode: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(b: unknown) { state.body = b; return res; },
    send(b: unknown) { state.body = b; return res; },
    setHeader() { return res; },
  };
  const req = { method: 'GET', query, user: { id: 'platform-admin' }, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await (route as unknown as (q: unknown, s: unknown) => Promise<void>)(req, res);
  return state;
}
const orderBy = () => /ORDER BY (.*)$/.exec(fx.queries.find((q) => q.includes('FROM companies c')) ?? '')?.[1];

beforeEach(() => { fx.queries = []; });

describe('companies export sort_by allowlist', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'password'])('%s is 400 and runs no SQL', async (key) => {
    const r = await call({ sort_by: key });
    expect(r.statusCode).toBe(400);
    expect(fx.queries).toEqual([]);
  });
});

describe('companies export ORDER BY matches the list', () => {
  it.each([
    [{ sort_by: 'plan_name', sort_dir: 'asc' }, 'plan_name ASC NULLS LAST, c.id'],
    [{ sort_by: 'last_active', sort_dir: 'desc' }, 'last_active DESC NULLS LAST, c.id'],
    [{ sort_by: 'name', sort_dir: 'asc' }, 'c.name ASC NULLS LAST, c.id'],
    [{ sort_by: 'user_count' }, 'user_count DESC NULLS LAST, c.id'],
    [{}, 'c.created_at DESC NULLS LAST, c.id'],
    [{ sort_dir: 'asc' }, 'c.created_at ASC NULLS LAST, c.id'],
  ])('%o sorts by %s', async (query, expected) => {
    const r = await call(query as Record<string, string>);
    expect(r.statusCode).toBe(200);
    expect(orderBy()).toBe(expected);
  });
});
