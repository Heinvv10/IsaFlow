/**
 * Budgets P5-6 (spec §3f, §6 T11): racing slice moves, through the routes as real members. Both
 * requests read the slice as 'submitted' (or 'open') before either writes: the hook holds each at its
 * status UPDATE until both have arrived, so the from-state in the UPDATE's WHERE is the only thing
 * that can decide the race. Exactly one wins; the other is the service's 409 naming the status the
 * winner left (not a database refusal), and the slice ends in the winner's status with ONE audit row.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

type RawSql = ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) & Record<string, unknown>;
const gate = vi.hoisted(() => ({ armed: false, waiting: [] as Array<() => void>, arrived: 0 }));

// Once armed, each statement that moves a slice's status waits until two have arrived (5 s at most).
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as RawSql;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!gate.armed || !/UPDATE budget_slice_reviews SET status/.test(strings.join('?'))) return realSql(strings, ...values);
    return (async () => {
      gate.arrived += 1;
      if (gate.arrived >= 2) { for (const go of gate.waiting.splice(0)) go(); } else {
        await new Promise<void>((resolve) => { gate.waiting.push(resolve); setTimeout(resolve, 5000); });
      }
      return realSql(strings, ...values);
    })();
  };
  Object.assign(sql, realSql);
  return { ...real, sql };
});

import saveRoute from '../../pages/api/accounting/budget-grid/save';
import sliceRoute from '../../pages/api/accounting/budgets/slices/[id]/[action]';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetHoldersFixture, errCodeOf, type GridWorld } from './helpers/budgetHoldersFixture';
import type { SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const fx = budgetHoldersFixture(pool, saveRoute);
let w: GridWorld;
let holderA: SetupUser;
let holderB: SetupUser;
let admin: SetupUser;

beforeAll(async () => {
  w = await fx.world();
  holderA = await fx.member(w.u.homeCompanyId, 'manager');
  holderB = await fx.member(w.u.homeCompanyId, 'manager');
  admin = await fx.member(w.u.homeCompanyId, 'admin');
}, 120_000);
afterAll(async () => {
  try { await fx.cleanup(); } finally { await pool.end(); }
}, 120_000);

const move = (u: SetupUser, id: string, action: string, body: Record<string, unknown> = {}) =>
  fx.call(sliceRoute, u, 'POST', { query: { id, action }, body });

async function race(a: () => ReturnType<typeof move>, b: () => ReturnType<typeof move>) {
  gate.armed = true;
  gate.arrived = 0;
  try {
    const out = await Promise.all([a(), b()]);
    expect(gate.arrived).toBe(2);
    return out;
  } finally { gate.armed = false; }
}

describe('racing slice moves: one wins', () => {
  it('an approve and a return of one submitted slice', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holderA.userId, { cc1: w.cc1 });
    await fx.setStatus(slice, 'submitted', holderA.userId);
    const [ap, ret] = await race(() => move(w.u, slice, 'approve'), () => move(admin, slice, 'return', { note: 'Redo' }));
    expect([ap.status, ret.status].sort()).toEqual([200, 409]);
    const loser = ap.status === 409 ? ap : ret;
    expect(errCodeOf(loser)).toBe('BUDGET_SLICE_STATE');
    const final = await fx.status(slice);
    expect(final).toBe(ap.status === 200 ? 'approved' : 'returned');
    expect(String(loser.body.error?.message)).toBe(`This budget slice is now ${final}; it cannot be ${ap.status === 409 ? 'approved' : 'returned'}`);
    expect((await fx.audits(v)).filter((x) => x.changes.metadata?.sliceId === slice)).toHaveLength(1);
  });

  it('two holders submitting one slice', async () => {
    const v = await fx.version(w);
    const slice = await fx.hold(w, v, holderA.userId, { bu: w.bu });
    await fx.hold(w, v, holderB.userId, { bu: w.bu });
    const [a, b] = await race(() => move(holderA, slice, 'submit'), () => move(holderB, slice, 'submit'));
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect([errCodeOf(loser), String(loser.body.error?.message)]).toEqual(['BUDGET_SLICE_STATE', 'This budget slice is now submitted; it cannot be submitted']);
    expect(await fx.status(slice)).toBe('submitted');
    // The winner's notification only (one submit, one dedupe key per reviewer).
    expect((await fx.notes(w.u.homeCompanyId, w.u.userId)).filter((n) => n.dedupe_key.startsWith(`budget_slice:${slice}:submit:`))).toHaveLength(1);
  });
});
