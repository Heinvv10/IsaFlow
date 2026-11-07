/**
 * POST /api/accounting/assets/:id/dispose through the real route (withAuth + JWT, app_user):
 *   · the app's DisposalMethod values (incl. the UI default 'scrap' and 'insurance_claim') are accepted — they used
 *     to 500 on assets_disposal_type_check because the route wrote them to assets.disposal_type;
 *   · the method lands in assets.disposal_method; an unknown method is a 400 with nothing written;
 *   · one asset_disposals row is written with the journal id, book value and gain/loss, and the Disposals list
 *     (assets-disposals) shows it for this company only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import dispose from '../../pages/api/accounting/assets/[assetId]/dispose';
import { loadUnpostedDisposals } from '@/modules/accounting/services/items/fixedAssetDisposalQueries';
import disposalsList from '../../pages/api/accounting/assets-disposals';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import type { Route } from './d12-helpers';
import { callAs, clearFleet } from './fleet-helpers';

let c: Ctx; let o: Ctx; let z: Ctx;
let token = ''; let otoken = ''; let ztoken = '';
let costAccount = '';
type Row = Record<string, unknown>;

async function asset(ctx: Ctx, accDep = 100000): Promise<string> {
  return String(((await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, accumulated_depreciation,
      useful_life_years, status, gl_asset_account_id)
    VALUES (${ctx.fx.companyId}::UUID, ${`DM-${++ctx.seq}-${ctx.fx.tag.slice(-8)}`}, ${`DM asset ${ctx.seq}`}, '2026-01-10',
      450000, ${accDep}, 5, 'available', ${ctx === c ? costAccount : null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}
const run = (a: string, body: Record<string, unknown>) =>
  callAs(c, token, dispose as Route, 'POST', { proceeds: 300000, disposalDate: '2026-06-21', ...body }, { assetId: a });
const logRows = async (a: string) => (await sql`
  SELECT disposal_method, disposal_amount::FLOAT AS proceeds, book_value_at_disposal::FLOAT AS bv, gain_loss::FLOAT AS gl,
    reason, journal_entry_id::TEXT AS je, created_by FROM asset_disposals WHERE asset_id = ${a}::UUID`) as Row[];
const assetRow = async (a: string) => ((await sql`
  SELECT status, disposal_method FROM assets WHERE id = ${a}::UUID`) as Row[])[0]!;

async function seedAccounts(ctx: Ctx): Promise<string> {
  const acct = async (code: string, type: string, subtype: string, normal: string) => String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
      is_active, is_system_account)
    VALUES (${ctx.fx.companyId}::UUID, ${code}, ${`DM ${subtype} ${ctx.fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
  const cost = await acct('1500', 'asset', 'fixed_asset', 'debit');
  await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
  await acct('8100', 'expense', 'disposal_profit_loss', 'debit');
  clearSystemAccountCache(ctx.fx.companyId);
  return cost;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('asset disposal: method + disposal log', () => {
  beforeAll(async () => {
    assertNotProductionDb('asset disposal log');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('ADM'));
    ({ c: o, token: otoken } = await setupWithUser('ADO'));
    costAccount = await seedAccounts(c);
  }, 120000);
  afterAll(async () => {
    for (const x of [c, o, z]) {
      if (!x) continue;
      await sql`DELETE FROM asset_disposals WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${x.fx.companyId}::UUID)`;
      await clearFleet(x); await clearExtras(x); await teardown(x);
    }
  }, 120000);

  it.each(['scrap', 'insurance_claim', 'sale', 'write_off', 'donation', 'theft'])('%s is accepted and recorded', async (m) => {
    const a = await asset(c);
    const out = await run(a, { disposalType: m, notes: `why ${m}` });
    expect(out.status, out.body).toBe(200);
    expect(await assetRow(a)).toMatchObject({ status: 'disposed', disposal_method: m });
    const rows = await logRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposal_method: m, proceeds: 300000, bv: 350000, gl: -50000, reason: `why ${m}`,
      je: (out.data as { journalEntryId: string }).journalEntryId, created_by: c.fx.userId });
  }, 60000);

  it.each([[300000, 'sale'], [0, 'write_off']])('no method, proceeds %s: defaults to %s on the asset and the log', async (proceeds, method) => {
    const a = await asset(c);
    const out = await run(a, { proceeds });
    expect(out.status, out.body).toBe(200);
    expect(await assetRow(a)).toMatchObject({ status: 'disposed', disposal_method: method });
    const rows = await logRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposal_method: method, proceeds });
  }, 60000);

  it('a route disposal is not reported by reconcile_fixed_assets as unposted or missing its record', async () => {
    const a = await asset(c);
    expect((await run(a, { disposalType: 'scrap' })).status).toBe(200);
    const unposted = (await loadUnpostedDisposals(c.fx.companyId, '2026-12-31')).filter((u) => u.assetId === a);
    expect(unposted).toEqual([]);
  }, 60000);

  it.each([['abc'], [-5], [Number.NaN], ['Infinity'], [''], [[5]], ['0x10'], [1e20], [1e13], [1e-7], ['0.001'], [123456.789], [9999999999999.996], ['9999999999999.999']])('proceeds %j is a 400 and nothing is written', async (proceeds) => {
    const a = await asset(c);
    const j = async () => Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
    const before = await j();
    const out = await run(a, { proceeds, disposalType: 'scrap' });
    expect(out.status, out.body).toBe(400);
    expect(await assetRow(a)).toMatchObject({ status: 'available', disposal_method: null });
    expect(await logRows(a)).toHaveLength(0);
    expect(await j()).toBe(before);
    expect(Number(((await sql`SELECT COUNT(*) AS n FROM asset_period_ledger WHERE asset_id = ${a}::UUID`) as Row[])[0]!.n)).toBe(0);
  }, 60000);

  // numeric(15,2) bounds the journal entry's TOTAL (balance trigger) and each account's running total
  // (gl_account_balances), so this runs in a company of its own whose accounts start at zero. The asset adds 100000
  // accumulated depreciation to the debits: the largest proceeds is 9,999,999,999,999.99 - 100,000.
  it('proceeds at the journal-total ceiling are accepted; one cent more is a 400 with nothing written', async () => {
    ({ c: z, token: ztoken } = await setupWithUser('ADZ'));
    const zCost = await seedAccounts(z);
    const za = String(((await sql`
      INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, accumulated_depreciation,
        useful_life_years, status, gl_asset_account_id)
      VALUES (${z.fx.companyId}::UUID, ${`DZ-${z.fx.tag.slice(-8)}`}, 'DZ asset', '2026-01-10', 450000, 100000, 5, 'available',
        ${zCost}::UUID) RETURNING id`) as Row[])[0]!.id);
    const go = (proceeds: string) => callAs(z, ztoken, dispose as Route, 'POST',
      { proceeds, disposalDate: '2026-06-21', disposalType: 'sale' }, { assetId: za });
    const over = await go('9999999900000.00');
    expect(over.status, over.body).toBe(400);
    expect(Number(((await sql`SELECT COUNT(*) AS n FROM asset_period_ledger WHERE asset_id = ${za}::UUID`) as Row[])[0]!.n)).toBe(0);
    expect(await logRows(za)).toHaveLength(0);
    const ok = await go('9999999899999.99');
    expect(ok.status, ok.body).toBe(200);
    expect(await logRows(za)).toHaveLength(1);
  }, 120000);

  it('an unknown method is a 400 and nothing is written', async () => {
    const a = await asset(c);
    const before = Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
    const out = await run(a, { disposalType: 'sold_to_aliens' });
    expect(out.status, out.body).toBe(400);
    expect(await assetRow(a)).toMatchObject({ status: 'available', disposal_method: null });
    expect(await logRows(a)).toHaveLength(0);
    expect(Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n)).toBe(before);
    expect(Number(((await sql`SELECT COUNT(*) AS n FROM asset_period_ledger WHERE asset_id = ${a}::UUID`) as Row[])[0]!.n)).toBe(0);
  }, 60000);

  it("the disposals list shows this company's disposals and not another's", async () => {
    const a = await asset(c);
    const out = await run(a, { disposalType: 'scrap' });
    expect(out.status, out.body).toBe(200);
    const b = await asset(o);
    await sql`INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method, book_value_at_disposal, gain_loss)
      VALUES (${b}::UUID, '2026-06-21', 'scrap', 1, 0)`;
    const mine = await callAs(c, token, disposalsList as Route, 'GET');
    expect(mine.status, mine.body).toBe(200);
    const ids = (mine.data as Row[]).map((r) => String(r.asset_id));
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
    const theirs = await callAs(o, otoken, disposalsList as Route, 'GET');
    const tids = (theirs.data as Row[]).map((r) => String(r.asset_id));
    expect(tids).toContain(b);
    expect(tids).not.toContain(a);
  }, 60000);
});
