/**
 * D12 on the asset / fleet LINK routes, now that migration 853 owns their schema. A link is an ANNOTATION
 * (bank/.claude.md: outside "a completed reconciliation is immutable"), so:
 *   · a RECONCILED line of a COMPLETED session may be linked and unlinked — its status, journal line and stamp, and
 *     the session's header, are unchanged;
 *   · a STALE stamp (an imported line a completed session claimed) is left as it is — the link no longer turns a line
 *     `matched`, so there is nothing to clear; an IN-PROGRESS stamp likewise;
 *   · the write takes the bank line's lock (session FOR SHARE first): a session held FOR UPDATE answers 503 +
 *     Retry-After at ~5 s, the line untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bankMatchAsset from '../../pages/api/accounting/bank-match-asset';
import bankMatchFleet from '../../pages/api/accounting/bank-match-fleet';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedSession, holdSession, newBank, seedPair, snapshot, startSession, type Call, type Route,
} from './d12-helpers';
import { clearFleet, linkState, newAsset, newFuel, newService } from './fleet-helpers';

let c: Ctx;
let token = '';

type Body = (bt: string, target: string | null) => Record<string, unknown>;
const LINK: [string, Route, Body, (a: string) => Promise<string>][] = [
  ['asset', bankMatchAsset as Route, (bt, id) => ({ bankTransactionId: bt, assetId: id }), async (a) => a],
  ['fleet fuel', bankMatchFleet as Route, (bt, id) => ({ bankTransactionId: bt, fleetEntityType: 'fuel', fleetEntityId: id }),
    (a) => newFuel(c, a)],
  ['fleet service', bankMatchFleet as Route,
    (bt, id) => ({ bankTransactionId: bt, fleetEntityType: 'service', fleetEntityId: id }), (a) => newService(c, a)],
];
const COL = { asset: 'asset', 'fleet fuel': 'fuel', 'fleet service': 'service' } as Record<string, string>;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12: the asset / fleet link routes', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 links');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('D12K'));
  }, 120000);
  afterAll(async () => { await cleanup(c); await clearFleet(c); await clearExtras(c); await teardown(c); }, 120000);

  for (const [name, route, body, target] of LINK) {
    it(`${name}: a RECONCILED line of a COMPLETED session is linked and unlinked; line and session unchanged`, async () => {
      const s = await completedSession(c, token, { matched: 1 });
      const line = s.matched[0]!.bt;
      const before = await snapshot(c, s.bank, s.rec);
      const t = await target(await newAsset(c));

      const on = await call(c, token, route, body(line, t));
      expect(on.status, on.body).toBe(200);
      expect(await linkState(line)).toMatchObject({ status: 'reconciled', rec: s.rec, jl: s.matched[0]!.jl, [COL[name]!]: t });
      expect(await snapshot(c, s.bank, s.rec)).toEqual(before);

      const off = await call(c, token, route, body(line, null));
      expect(off.status, off.body).toBe(200);
      expect(await linkState(line)).toMatchObject({ status: 'reconciled', rec: s.rec, asset: null, fuel: null, service: null });
      expect(await snapshot(c, s.bank, s.rec)).toEqual(before);
    }, 60000);

    it(`${name}: a STALE completed stamp stays; the line stays imported`, async () => {
      const s = await completedSession(c, token, { matched: 1, stale: 1 });
      const out = await call(c, token, route, body(s.stale[0]!, await target(await newAsset(c))));
      expect(out.status, out.body).toBe(200);
      expect(await linkState(s.stale[0]!)).toMatchObject({ status: 'imported', rec: s.rec, jl: null });
    }, 60000);

    it(`${name}: an IN-PROGRESS stamp stays; the line stays imported`, async () => {
      const bank = await newBank(c);
      const p = await seedPair(c, bank, 151.51, '2026-06-02');
      const rec = await startSession(c, token, bank);
      const out = await call(c, token, route, body(p.bt, await target(await newAsset(c))));
      expect(out.status, out.body).toBe(200);
      expect(await linkState(p.bt)).toMatchObject({ status: 'imported', rec, jl: null });
    }, 60000);
  }

  it('asset: a session held FOR UPDATE -> 503 + Retry-After at ~5 s, the line untouched', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 161.61, '2026-06-02');
    const rec = await startSession(c, token, bank);
    const a = await newAsset(c);
    const before = await linkState(p.bt);
    const release = await holdSession(c, rec, 'UPDATE', 12000);
    let out: Call;
    try { out = await call(c, token, bankMatchAsset as Route, { bankTransactionId: p.bt, assetId: a }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await linkState(p.bt)).toEqual(before);
  }, 60000);
});
