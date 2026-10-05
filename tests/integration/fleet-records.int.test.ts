/**
 * Fleet fuel / service records of an asset (mig 853) through the real routes (withAuth + JWT, app_user):
 *   · create (201), list, delete; validation 422 before any write;
 *   · another company's asset — or a missing one — is 404 with ONE answer on GET, POST and DELETE; nothing written;
 *   · a record is deleted only through ITS asset;
 *   · a record a bank line links to is REFUSED (409) — unlink it first — and stays, with its link;
 *   · RLS as app_user: another company's records are invisible, and a write into another company is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import fuelRoute from '../../pages/api/accounting/assets/[assetId]/fuel';
import serviceRoute from '../../pages/api/accounting/assets/[assetId]/service';
import bankMatchFleet from '../../pages/api/accounting/bank-match-fleet';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { newBank, newId, seedLine, type Route } from './d12-helpers';
import { callAs, clearFleet, linkState, messageOf, newAsset, newFuel, newService } from './fleet-helpers';

let c: Ctx; let o: Ctx;
let token = '';
type Row = Record<string, unknown>;
const FUEL = { fillDate: '2026-10-01', litres: 50.5, amount: 1012.75, odometerKm: 123456, supplierName: 'Shell', notes: 'N1' };
const SERVICE = { serviceDate: '2026-10-02', description: 'Major service', amount: 6400, odometerKm: 120000 };
const KINDS = [
  { kind: 'fuel' as const, route: fuelRoute as Route, body: FUEL, seed: (x: Ctx, a: string) => newFuel(x, a),
    table: 'fleet_fuel_transactions', bad: { ...FUEL, litres: 0 } },
  { kind: 'service' as const, route: serviceRoute as Route, body: SERVICE, seed: (x: Ctx, a: string) => newService(x, a),
    table: 'fleet_service_history', bad: { ...SERVICE, description: '  ' } },
];
const count = async (table: string, companyId: string) => Number(((table === 'fleet_fuel_transactions'
  ? await sql`SELECT COUNT(*) AS n FROM fleet_fuel_transactions WHERE company_id = ${companyId}::UUID`
  : await sql`SELECT COUNT(*) AS n FROM fleet_service_history WHERE company_id = ${companyId}::UUID`) as Row[])[0]!.n);

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('fleet fuel / service records', () => {
  beforeAll(async () => {
    assertNotProductionDb('fleet records');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('FLR'));
    ({ c: o } = await setupWithUser('FLQ'));
  }, 120000);
  afterAll(async () => {
    for (const x of [c, o]) { await clearFleet(x); await clearExtras(x); await teardown(x); }
  }, 120000);

  for (const k of KINDS) {
    const call = (method: string, assetId: string, body: Record<string, unknown> = {}, id?: string) =>
      callAs(c, token, k.route, method, body, id ? { assetId, id } : { assetId });

    it(`${k.kind}: create, list, delete`, async () => {
      const a = await newAsset(c);
      const made = await call('POST', a, k.body);
      expect(made.status, made.body).toBe(201);
      const rec = made.data as Row;
      expect(rec).toMatchObject({ ...k.body, assetId: a, bankLinkCount: 0 });
      const list = await call('GET', a);
      expect(list.status, list.body).toBe(200);
      expect((list.data as Row[]).map((r) => r.id)).toEqual([rec.id]);
      const gone = await call('DELETE', a, {}, String(rec.id));
      expect(gone.status, gone.body).toBe(200);
      expect(((await call('GET', a)).data as Row[])).toEqual([]);
    }, 60000);

    it(`${k.kind}: an invalid body is 422 and writes nothing`, async () => {
      const a = await newAsset(c);
      const before = await count(k.table, c.fx.companyId);
      const out = await call('POST', a, k.bad);
      expect(out.status, out.body).toBe(422);
      expect(await count(k.table, c.fx.companyId)).toBe(before);
      const dateKey = k.kind === 'fuel' ? 'fillDate' : 'serviceDate';
      // Round 2 (sec L2): every input Postgres would refuse with a 500 is a 422 here — an impossible day, year 0 and
      // an out-of-range year, and a NUL in any text field.
      const refused: Record<string, unknown>[] = [
        { ...k.body, [dateKey]: '2026-02-30' }, { ...k.body, [dateKey]: '0000-01-01' }, { ...k.body, [dateKey]: '1899-12-31' },
        { ...k.body, [dateKey]: '3000-01-01' }, { ...k.body, supplierName: 'a\u0000b' }, { ...k.body, notes: 'a\u0000b' },
        ...(k.kind === 'service' ? [{ ...k.body, description: 'Brakes\u0000' }] : []),
      ];
      for (const body of refused) {
        const r = await call('POST', a, body);
        expect(r.status, `${JSON.stringify(body)} -> ${r.body}`).toBe(422);
      }
      expect(await count(k.table, c.fx.companyId)).toBe(before);
    }, 60000);

    it(`${k.kind}: a foreign asset is 404 on GET, POST and DELETE — identical to a missing one; nothing written`, async () => {
      const oa = await newAsset(o); const orec = await k.seed(o, oa);
      const before = [await count(k.table, c.fx.companyId), await count(k.table, o.fx.companyId)];
      for (const [method, body, id] of [['GET', {}, undefined], ['POST', k.body, undefined], ['DELETE', {}, orec]] as const) {
        const f = await call(method, oa, body, id);
        const m = await call(method, newId(), body, id);
        expect(f.status, f.body).toBe(404);
        expect([m.status, messageOf(m)]).toEqual([404, messageOf(f)]);
      }
      expect([await count(k.table, c.fx.companyId), await count(k.table, o.fx.companyId)]).toEqual(before);
    }, 60000);

    it(`${k.kind}: a record is deleted only through its own asset`, async () => {
      const a = await newAsset(c); const b = await newAsset(c);
      const rec = await k.seed(c, a);
      const out = await call('DELETE', b, {}, rec);
      expect(out.status, out.body).toBe(404);
      expect(((await call('GET', a)).data as Row[]).map((r) => r.id)).toEqual([rec]);
    }, 60000);

    // Round 2 (sec L1): depreciation and dispose hold the asset FOR UPDATE; the create waits at most 5 s for it.
    it(`${k.kind}: an asset held FOR UPDATE by another transaction -> 503 + Retry-After at ~5 s; nothing written`, async () => {
      const a = await newAsset(c);
      const before = await count(k.table, c.fx.companyId);
      const h = await c.fx.pool.connect();
      await h.query('BEGIN');
      await h.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [a]);
      let out;
      try { out = await call('POST', a, k.body); } finally { await h.query('ROLLBACK'); h.release(); }
      expect(out.status, out.body).toBe(503);
      expect(out.retryAfter).toBe('2');
      expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
      expect(await count(k.table, c.fx.companyId)).toBe(before);
    }, 60000);

    it(`${k.kind}: a record a bank line links to is refused 409 and stays linked`, async () => {
      const a = await newAsset(c); const rec = await k.seed(c, a);
      const bt = await seedLine(c, await newBank(c), 777);
      const link = await callAs(c, token, bankMatchFleet as Route, 'POST',
        { bankTransactionId: bt, fleetEntityType: k.kind, fleetEntityId: rec });
      expect(link.status, link.body).toBe(200);
      expect(((await call('GET', a)).data as Row[])[0]).toMatchObject({ id: rec, bankLinkCount: 1 });
      const out = await call('DELETE', a, {}, rec);
      expect(out.status, out.body).toBe(409);
      expect(messageOf(out)).toMatch(/unlink/i);
      expect(await linkState(bt)).toMatchObject({ [k.kind]: rec });
      expect(((await call('GET', a)).data as Row[]).map((r) => r.id)).toEqual([rec]);
    }, 60000);
  }

  // As withAuth runs a request: app_user, the user's `sub`, the active company.
  async function asAppUser<T>(fn: (cl: PoolClient) => Promise<T>): Promise<T> {
    const cl = await c.fx.pool.connect();
    try {
      await cl.query('BEGIN');
      await cl.query('SET LOCAL ROLE app_user');
      await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: c.fx.userId })]);
      await cl.query("SELECT set_config('app.current_company_id', $1, true)", [c.fx.companyId]);
      return await fn(cl);
    } finally {
      await cl.query('ROLLBACK').catch(() => undefined);
      cl.release();
    }
  }

  it('RLS as app_user: another company\'s records are invisible and cannot be written', async () => {
    const oa = await newAsset(o); await newFuel(o, oa); await newService(o, oa);
    const a = await newAsset(c); await newFuel(c, a);
    for (const t of ['fleet_fuel_transactions', 'fleet_service_history']) {
      const seen = await asAppUser((cl) => cl.query(`SELECT id FROM ${t} WHERE company_id = $1`, [o.fx.companyId]));
      expect(seen.rows, t).toHaveLength(0);
    }
    const own = await asAppUser((cl) => cl.query('SELECT id FROM fleet_fuel_transactions WHERE asset_id = $1', [a]));
    expect(own.rows).toHaveLength(1);
    const err = await asAppUser((cl) => cl.query(
      `INSERT INTO fleet_fuel_transactions (company_id, asset_id, fill_date, litres, amount) VALUES ($1, $2, '2026-06-01', 1, 1)`,
      [o.fx.companyId, oa])).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/row-level security/);
  }, 60000);
});
