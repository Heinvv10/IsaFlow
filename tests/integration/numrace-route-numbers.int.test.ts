/**
 * NUMRACE: app-side numbers minted by a ROUTE (asset numbers, PROJ- projects) under a concurrent create of the
 * same scope, through the real handlers (withAuth: one transaction per request).
 *
 * Before the fix each route read MAX(seq)+1 with nothing serialising two writers: the second read the same MAX as
 * an uncommitted first, blocked on the unique index until it committed, and failed 23505 -> 500. Now each takes
 * `take_number_lock` (migration 864) on its scope before the MAX read, so the second waits and mints the next
 * number; a key held past 5 s answers 503 + Retry-After. Keys (864 header): assets ('<company>:<PFX>', 864001);
 * projects ('<company>', 864002). (TXF- bank transfers are not here: that route fails 42703 on every call before
 * it numbers anything — reported separately.)
 *
 * The first writer is held open after its INSERT by the numrace gate (helpers/numraceGate.ts); every wait is
 * proved with pg_blocking_pids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import assets from '../../pages/api/accounting/assets';
import projects from '../../pages/api/accounting/projects';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import { dropGate, holdGate, holdKey, installGate, waitBlockedBy } from './helpers/numraceGate';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Out = Awaited<ReturnType<typeof callRoute>> & { getHeader?: (n: string) => unknown };

let fx: Fixture;
let token = '';
const GATED = [['assets', 'name'], ['projects', 'name']] as const;

const asset = (name: string) => callRoute(fx, token, assets,
  { name, category: 'computers', cost: 1000, usefulLifeYears: 3, purchaseDate: '2026-01-15' });
const project = (name: string) => callRoute(fx, token, projects, { name, clientId: fx.customerId, budgetAmount: 0 });

const brief = (o: Out) => `${o.statusCode} ${JSON.stringify(o.body)}`;

/** A writer held open after its INSERT, a second writer for the same scope started behind it, then released. */
async function race(first: () => Promise<Out>, second: () => Promise<Out>): Promise<[Out, Out]> {
  const gate = await holdGate(fx.pool, 1);
  try {
    const pA = first();
    const a = await waitBlockedBy(fx.pool, gate.pid);
    const pB = second();
    await waitBlockedBy(fx.pool, a);
    await gate.open();
    return [await pA, await pB];
  } finally {
    await gate.open();
  }
}

describeIfDb('NUMRACE: route-minted numbers under a concurrent create', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('NUMRACE-R', DATABASE_URL!);
    token = await seedRouteUser(fx, 'numrace');
    for (const [t, c] of GATED) await installGate(fx.pool, t, c);
  }, 60000);

  afterAll(async () => {
    for (const [t] of GATED) await dropGate(fx.pool, t).catch(() => undefined);
    await sql`DELETE FROM assets WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM projects WHERE company_id = ${fx.companyId}::UUID`;
    await dropRouteUser(fx);
    await dropFixture(fx);
  }, 60000);

  it('assets: two creates in one category: both 201, consecutive numbers', async () => {
    const [a, b] = await race(() => asset('ngate:1 laptop A'), () => asset('laptop B'));
    expect(a.statusCode, brief(a)).toBe(201);
    expect(b.statusCode, brief(b)).toBe(201);
    expect([a, b].map((o) => dataOf<{ asset_number: string }>(o).asset_number)).toEqual(['COMP-0001', 'COMP-0002']);
  }, 60000);

  it('assets: the category key held past 5 s -> 503 + Retry-After', async () => {
    const held = await holdKey(fx.pool, `${fx.companyId}:COMP`, 864001);
    let out: Out;
    try { out = await asset('laptop held'); } finally { await held.open(); }
    expect(out.statusCode, brief(out)).toBe(503);
    expect((out as Out).getHeader?.('retry-after')).toBe('2');
  }, 60000);

  it('projects: two creates: both 201, consecutive numbers', async () => {
    const [a, b] = await race(() => project('ngate:1 proj A'), () => project('proj B'));
    expect(a.statusCode, brief(a)).toBe(201);
    expect(b.statusCode, brief(b)).toBe(201);
    expect([a, b].map((o) => dataOf<{ project_number: string }>(o).project_number)).toEqual(['PROJ-0001', 'PROJ-0002']);
  }, 60000);
});
