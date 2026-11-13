/**
 * create_fixed_asset against real Postgres: the extracted create service behind POST /api/accounting/assets and the
 * MCP tool. Proves that
 *  - the route (now a caller of the service) and the tool mint consecutive numbers and write the same columns;
 *  - the tool registers the asset for the TOKEN company only and posts NO journal and no subledger row;
 *  - a dry run writes nothing and reports the number the live call then takes;
 *  - an inactive category, a future date and a salvage value above cost are refused with nothing written;
 *  - a request rolled back after the INSERT leaves no asset (and so no gap in the numbering);
 *  - the registered asset is picked up by the next depreciation run's plan (the reversal warning's premise);
 *  - a same-name asset in ANOTHER company is not reported as a possible duplicate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import assetsRoute from '../../pages/api/accounting/assets';
import { createFixedAssetTool } from '@/lib/mcp/tools/writeCreateFixedAsset';
import { loadDepreciationAssets, planDepreciationRun } from '@/modules/accounting/services/items/depreciationRunService';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let token = '';
/** asset_categories is global and data-less in the schema-only fixture: the rows this suite added, removed after. */
let seededCategories: string[] = [];

const ctxFor = (f: Fixture) => ({
  companyId: f.companyId, userId: f.userId, scopes: ['write:journals'], companyRole: 'owner',
  tokenJti: 'jti-fa', oauthAppId: null,
}) as unknown as McpToolContext;

const ARGS = {
  name: 'Dell Latitude 5440', category: 'computers', purchase_date: '2026-01-10', cost: 18500.5,
  useful_life_years: 3, salvage_value: 500, depreciation_method: 'reducing_balance', location: 'Head office',
  idempotency_key: 'k',
};
const out = (r: McpToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const call = (f: Fixture, args: Record<string, unknown>) => inTx(f, () => createFixedAssetTool.handler(args, ctxFor(f)));
const assetsOf = async (f: Fixture) => (await sql`
  SELECT * FROM assets WHERE company_id = ${f.companyId}::UUID ORDER BY asset_number`) as Row[];
const journals = async (f: Fixture) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${f.companyId}::UUID`) as Row[])[0]!.n);
const ledgerRows = async (f: Fixture) => Number(((await sql`
  SELECT COUNT(*)::INT AS n FROM asset_period_ledger WHERE asset_id IN (
    SELECT id FROM assets WHERE company_id = ${f.companyId}::UUID)`) as Row[])[0]!.n);

describeIfDb('create_fixed_asset: real Postgres', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('CFA', DATABASE_URL!);
    other = await seedFixture('CFA-O', DATABASE_URL!);
    token = await seedRouteUser(fx, 'cfa');
    seededCategories = ((await sql`
      INSERT INTO asset_categories (name, code, sars_rate, sars_years) VALUES
        ('Computers', 'computers', 33.33, 3), ('Furniture', 'furniture', 16.67, 6)
      ON CONFLICT (code) DO NOTHING RETURNING code`) as Row[]).map((r) => String(r.code));
  }, 60000);

  afterAll(async () => {
    for (const f of [fx, other]) await sql`DELETE FROM assets WHERE company_id = ${f.companyId}::UUID`;
    await sql`DELETE FROM asset_categories WHERE code = ANY(${seededCategories}::TEXT[])`;
    await dropRouteUser(fx);
    await dropFixture(fx);
    await dropFixture(other);
  }, 60000);

  it('the route and the tool mint consecutive numbers and write the same columns', async () => {
    const viaRoute = await callRoute(fx, token, assetsRoute as never, {
      name: 'Route laptop', category: 'computers', sarsCategory: 'computers', purchaseDate: '2026-01-10', cost: 18500.5,
      salvageValue: 500, usefulLifeYears: 3, depreciationMethod: 'reducing_balance', location: 'Head office',
    });
    expect(viaRoute.statusCode, JSON.stringify(viaRoute.body)).toBe(201);
    expect(dataOf<{ asset_number: string }>(viaRoute).asset_number).toBe('COMP-0001');

    const r = await call(fx, ARGS);
    expect(r.isError, r.content[0]!.text).toBeUndefined();
    expect(out(r)).toMatchObject({ asset_number: 'COMP-0002', posts_to_ledger: false });

    const [a, b] = await assetsOf(fx);
    for (const col of ['category_id', 'category', 'sars_category', 'sars_rate', 'tax_useful_life_years',
      'tax_depreciation_method', 'purchase_price', 'salvage_value', 'useful_life_years', 'depreciation_method',
      'location', 'status']) {
      expect(b![col], col).toEqual(a![col]);
    }
    expect(a).toMatchObject({ category: 'computers', sars_category: 'computers', status: 'available' });
    expect(Number(a!.sars_rate)).toBeCloseTo(33.33);
    expect(a!.category_id).not.toBeNull();
    expect(b).toMatchObject({ company_id: fx.companyId, created_by: fx.userId, name: ARGS.name });
    expect(String(b!.id)).toBe(out(r).asset_id);
  }, 60000);

  it('posts no journal and no subledger row', async () => {
    expect(await journals(fx)).toBe(0);
    expect(await ledgerRows(fx)).toBe(0);
  });

  it('a dry run writes nothing, frees the key, and reports the number the live call then takes', async () => {
    const before = (await assetsOf(fx)).length;
    const dry = await call(fx, { ...ARGS, name: 'Dry laptop', dry_run: true });
    expect(dry.wroteNothing).toBe(true);
    expect(out(dry)).toMatchObject({ dryRun: true, journals: [], asset: { asset_number: 'COMP-0003' } });
    expect((await assetsOf(fx)).length).toBe(before);
    const live = await call(fx, { ...ARGS, name: 'Dry laptop' });
    expect(out(live).asset_number).toBe('COMP-0003');
  }, 60000);

  it('is scoped to the token company: another company\'s same-name asset is not a duplicate, and gets its own number', async () => {
    const r = await call(other, ARGS);
    expect(out(r)).toMatchObject({ asset_number: 'COMP-0001', possible_duplicates: [] });
    expect((await assetsOf(other)).length).toBe(1);
    const again = await call(fx, ARGS);
    const dupes = out(again).possible_duplicates as Array<{ assetNumber: string }>;
    expect(dupes.map((d) => d.assetNumber)).toEqual(['COMP-0002']);
  }, 60000);

  it('refuses an inactive category, a future date and salvage above cost, writing nothing', async () => {
    const before = (await assetsOf(fx)).length;
    const c = await fx.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE asset_categories SET is_active = false WHERE code = 'furniture'");
      const inactive = await runOn(fx, c, () => createFixedAssetTool.handler({ ...ARGS, category: 'furniture' }, ctxFor(fx)));
      expect(inactive.isError).toBe(true);
      expect(inactive.content[0]!.text).toMatch(/Unknown fixed asset category "furniture"/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const future = await call(fx, { ...ARGS, purchase_date: '2999-01-01' });
    const salvage = await call(fx, { ...ARGS, salvage_value: 99999 });
    expect(future.isError).toBe(true);
    expect(salvage.isError).toBe(true);
    expect((await assetsOf(fx)).length).toBe(before);
  }, 60000);

  it('a request rolled back after the INSERT leaves no asset and no numbering gap', async () => {
    const c = await fx.pool.connect();
    let minted = '';
    try {
      await c.query('BEGIN');
      const r = await runOn(fx, c, () => createFixedAssetTool.handler({ ...ARGS, name: 'Rolled back' }, ctxFor(fx)));
      minted = String(out(r).asset_number);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const names = (await assetsOf(fx)).map((a) => a.name);
    expect(names).not.toContain('Rolled back');
    const next = await call(fx, { ...ARGS, name: 'After rollback' });
    expect(out(next).asset_number).toBe(minted);
  }, 60000);

  it('registers in a closed year (no ledger period is touched) and the next depreciation plan picks the asset up', async () => {
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${other.companyId}::UUID`;
    const closed = await call(other, { ...ARGS, name: 'Closed-year asset', purchase_date: '2025-06-01' });
    expect(closed.isError, closed.content[0]!.text).toBeUndefined();
    await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${fx.companyId}::UUID`;
    const assets = await inTx(fx, () => loadDepreciationAssets(fx.companyId));
    const plan = await inTx(fx, () => planDepreciationRun(fx.companyId, '2026-03-31', assets));
    const numbers = plan.rows.filter((row) => row.skipReason === null).map((row) => row.assetNumber);
    expect(numbers).toContain('COMP-0002');
  }, 60000);
});
