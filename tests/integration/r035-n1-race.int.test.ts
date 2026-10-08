/**
 * R-035 N1 round 2 (blind LOW 1 / adversarial R2-3): the stricter-rule race
 * between requestApproval's checkApproval and approval_request_raise, against
 * real Postgres through the real route. `@/lib/neon`'s sql is wrapped (lazy,
 * so every other statement runs untouched); straight after the rules read a
 * hook commits a stricter rule on another connection — a colleague editing the
 * rules at that instant. The definer then finds the TypeScript's choice is no
 * longer the strictest (RA010) and writes nothing inside its savepoint, so the
 * transaction is still usable for the retry:
 *  - one race: the retry binds the new rule — 200;
 *  - two races: 409 APPROVAL_RULES_CHANGED, and no request row exists.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const hooks = vi.hoisted(() => ({ queue: [] as (() => Promise<void>)[], fired: 0 }));

vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  const sql = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = realSql(strings, ...values);
    const text = strings.join('?');
    if (hooks.queue.length === 0 || !/FROM approval_rules/.test(text) || !/ORDER BY priority/.test(text)) return query;
    const hook = hooks.queue.shift()!;
    hooks.fired += 1;
    return (async () => { const rows = await query; await hook(); return rows; })();
  }, realSql);
  return { ...real, sql };
});

import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantBill, plantRule, reasonOf } from './r035-approval.helpers';
import { cleanupPr2, dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

/** A bill by a under a `manager any` rule, enforcement on; b (owner) will raise it. */
async function bill() {
  const c = await postableCompany(pool, [[u.a, 'owner'], [u.b, 'owner']], companies);
  await plantRule(pool, c, 'manager', { name: 'race manager' });
  await enforce(pool, c, u.a);
  return { c, bill: await plantBill(pool, c, u.a) };
}

/** A hook that commits a stricter rule on its own connection. */
const stricter = (c: string, role: string) => async () => { await plantRule(pool, c, role, { name: `race ${role}` }); };

describe('a stricter rule committed between the TypeScript read and the definer', () => {
  it('once: the retry binds the rule that governs now (200, owner)', async () => {
    const f = await bill();
    hooks.fired = 0;
    hooks.queue = [stricter(f.c, 'owner')];
    const res = await r.raise(u.b, f.c, f.bill.id);
    expect(hooks.fired).toBe(1);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ requiredRole: string; status: string }>(res)).toMatchObject({ requiredRole: 'owner', status: 'pending' });
    const { rows } = await pool.query('SELECT required_role FROM approval_requests WHERE document_id = $1', [f.bill.id]);
    expect(rows).toEqual([{ required_role: 'owner' }]);
  });

  it('twice: 409 APPROVAL_RULES_CHANGED, nothing written', async () => {
    const f = await bill();
    hooks.fired = 0;
    hooks.queue = [stricter(f.c, 'admin'), stricter(f.c, 'owner')];
    const res = await r.raise(u.b, f.c, f.bill.id);
    expect(hooks.fired).toBe(2);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_RULES_CHANGED');
    const { rows } = await pool.query('SELECT count(*)::INT AS n FROM approval_requests WHERE document_id = $1', [f.bill.id]);
    expect(rows[0].n).toBe(0);
  });

  it('control: without a race the request binds the rule the TypeScript chose (no hook fires)', async () => {
    const f = await bill();
    hooks.fired = 0;
    hooks.queue = [];
    const res = await r.raise(u.b, f.c, f.bill.id);
    expect(res.state.statusCode).toBe(200);
    expect(dataOf<{ requiredRole: string }>(res).requiredRole).toBe('manager');
  });
});
