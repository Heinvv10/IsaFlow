/**
 * D12 rows 11 + round 2 B2 on the asset / fleet LINK routes. No migration creates their link schema
 * (`bank_transactions.linked_asset_id` / `linked_fleet_fuel_id` / `linked_fleet_service_id`, `assets.bank_transaction_id`,
 * `fleet_fuel_transactions`, `fleet_service_history` — absent on isaflow_dev and the fixture, register item), so both
 * routes 500 before their bank write everywhere migrations built the schema. To prove the D12 arm they carry, this
 * file adds that schema to the DISPOSABLE fixture for its own run (localhost fixture DB only) and drops it after.
 *   · a stale COMPLETED stamp is cleared when the link turns the line `matched`; an IN-PROGRESS stamp is kept;
 *   · a held session answers 503 + Retry-After at ~5 s (the 5 s budget), not an unbounded wait.
 * The link ids themselves are annotations — out of D12's scope (bank/.claude.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankMatchAsset from '../../pages/api/accounting/bank-match-asset';
import bankMatchFleet from '../../pages/api/accounting/bank-match-fleet';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import {
  call, cleanup, completedSession, holdSession, lineOf, newBank, newId, seedPair, startSession, type Call, type Route,
} from './d12-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;
const added: string[] = [];
const has = async (table: string, column?: string) => Number(((await sql`SELECT COUNT(*) AS n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = ${table} AND (${column ?? null}::TEXT IS NULL OR column_name = ${column ?? null})`) as Row[])[0]!.n) > 0;

const LINK = [
  ['asset', bankMatchAsset as Route, (bt: string) => ({ bankTransactionId: bt, assetId: newId() })],
  ['fleet fuel', bankMatchFleet as Route, (bt: string) => ({ bankTransactionId: bt, fleetEntityType: 'fuel', fleetEntityId: newId() })],
  ['fleet service', bankMatchFleet as Route, (bt: string) => ({ bankTransactionId: bt, fleetEntityType: 'service', fleetEntityId: newId() })],
] as const;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('D12: the asset / fleet link routes', () => {
  beforeAll(async () => {
    assertNotProductionDb('D12 links');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    for (const col of ['linked_asset_id', 'linked_fleet_fuel_id', 'linked_fleet_service_id']) {
      if (!(await has('bank_transactions', col))) { added.push(`bank_transactions.${col}`); await sql.unsafe(`ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS ${col} UUID`); }
    }
    if (!(await has('assets', 'bank_transaction_id'))) { added.push('assets.bank_transaction_id'); await sql`ALTER TABLE assets ADD COLUMN IF NOT EXISTS bank_transaction_id UUID`; }
    for (const t of ['fleet_fuel_transactions', 'fleet_service_history']) {
      if (!(await has(t))) {
        added.push(t);
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${t} (id UUID PRIMARY KEY, company_id UUID NOT NULL, bank_transaction_id UUID)`);
        await sql.unsafe(`GRANT SELECT, UPDATE ON ${t} TO app_user`);
      }
    }
    ({ c, token } = await setupWithUser('D12K'));
  }, 120000);
  afterAll(async () => {
    await cleanup(c); await clearExtras(c); await teardown(c);
    for (const a of added.reverse()) {
      const [t, col] = a.split('.');
      await sql.unsafe(col ? `ALTER TABLE ${t} DROP COLUMN IF EXISTS ${col}` : `DROP TABLE IF EXISTS ${t}`);
    }
  }, 120000);

  for (const [name, route, body] of LINK) {
    it(`${name}: a stale COMPLETED stamp is cleared as the line turns matched`, async () => {
      const s = await completedSession(c, token, { matched: 1, stale: 1 });
      const out = await call(c, token, route, body(s.stale[0]!));
      expect(out.status, out.body).toBe(200);
      expect(await lineOf(s.stale[0]!)).toMatchObject({ status: 'matched', rec: null });
      expect(((await sql`SELECT COUNT(*) AS n FROM bank_transactions WHERE reconciliation_id = ${s.rec}::UUID
        AND status = 'matched'`) as Row[])[0]!.n).toBe('0');
    }, 60000);

    it(`${name}: an IN-PROGRESS stamp is kept`, async () => {
      const bank = await newBank(c);
      const p = await seedPair(c, bank, 151.51, '2026-06-02');
      const rec = await startSession(c, token, bank);
      const out = await call(c, token, route, body(p.bt));
      expect(out.status, out.body).toBe(200);
      expect(await lineOf(p.bt)).toMatchObject({ status: 'matched', rec });
    }, 60000);
  }

  it('asset: a session held FOR UPDATE -> 503 + Retry-After at ~5 s, the line untouched', async () => {
    const bank = await newBank(c);
    const p = await seedPair(c, bank, 161.61, '2026-06-02');
    const rec = await startSession(c, token, bank);
    const release = await holdSession(c, rec, 'UPDATE', 12000);
    let out: Call;
    try { out = await call(c, token, bankMatchAsset as Route, { bankTransactionId: p.bt, assetId: newId() }); } finally { await release(); }
    expect(out.status, out.body).toBe(503);
    expect(out.retryAfter).toBe('2');
    expect(out.ms).toBeGreaterThan(4000); expect(out.ms).toBeLessThan(8500);
    expect(await lineOf(p.bt)).toMatchObject({ status: 'imported', rec });
  }, 60000);
});
