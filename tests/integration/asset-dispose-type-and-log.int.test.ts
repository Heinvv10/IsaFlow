/**
 * Asset disposal: the disposal type and the disposal log (2026-11-07).
 *
 * Two defects on POST /api/accounting/assets/:assetId/dispose, found seeding the Demo company:
 *  1. The asset page offered 'scrap' (its default) and 'insurance_claim', which the route wrote straight into
 *     assets.disposal_type, whose CHECK (mig 361) allowed only sale/write_off/donation/theft/loss: a 500 after the
 *     ledger row was written. Mig 965 widens the CHECK to both; every type the page offers must be storable, and
 *     anything else is a 400 with nothing written.
 *  2. The route never wrote asset_disposals, the table GET /api/accounting/assets-disposals lists, so the
 *     Disposals page was always empty. Each disposal now logs one row carrying its posted journal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { DISPOSAL_TYPES } from '@/modules/accounting/services/items/assetDisposalTypes';
import dispose from '../../pages/api/accounting/assets/[assetId]/dispose';
import disposalsList from '../../pages/api/accounting/assets-disposals';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import type { Route } from './d12-helpers';
import { callAs, clearFleet } from './fleet-helpers';

let c: Ctx;
let token = '';
let costAccount = '';
type Row = Record<string, unknown>;

async function asset(price = 12000): Promise<string> {
  return String(((await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status,
      gl_asset_account_id)
    VALUES (${c.fx.companyId}::UUID, ${`DT-${++c.seq}-${c.fx.tag.slice(-8)}`}, ${`Disposal type ${c.seq}`}, '2026-01-10',
      ${price}, 5, 'available', ${costAccount}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}

const state = async (id: string) => ((await sql`
  SELECT a.status, a.disposal_type,
    (SELECT COUNT(*)::INT FROM asset_period_ledger l WHERE l.asset_id = a.id) AS ledger_rows,
    (SELECT COUNT(*)::INT FROM asset_disposals d WHERE d.asset_id = a.id) AS disposal_rows,
    (SELECT COUNT(*)::INT FROM gl_journal_entries j
       WHERE j.company_id = a.company_id AND j.source = 'auto_asset_disposal' AND j.reference LIKE 'DIS-' || a.asset_number || '-%')
       AS journals
  FROM assets a WHERE a.id = ${id}::UUID`) as Row[])[0]!;

const disposeRoute = dispose as Route;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('asset dispose: type and disposal log', () => {
  beforeAll(async () => {
    assertNotProductionDb('asset dispose type');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('ADT'));
    const acct = async (code: string, type: string, subtype: string, normal: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
        is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, ${code}, ${`ADT ${subtype} ${c.fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
      RETURNING id`) as Row[])[0]!.id);
    costAccount = await acct('1500', 'asset', 'fixed_asset', 'debit');
    await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
    await acct('8100', 'expense', 'disposal_profit_loss', 'debit');
    clearSystemAccountCache(c.fx.companyId);
  }, 120000);
  afterAll(async () => {
    await clearFleet(c);
    await clearExtras(c); await teardown(c);
  }, 120000);

  it('every type the asset page offers disposes and is stored as sent', async () => {
    for (const type of DISPOSAL_TYPES) {
      const id = await asset();
      const out = await callAs(c, token, disposeRoute, 'POST',
        { proceeds: 0, disposalDate: '2026-06-15', disposalType: type, notes: `type ${type}` }, { assetId: id });
      expect(out.status, `${type}: ${out.body}`).toBe(200);
      expect(await state(id)).toMatchObject({ status: 'disposed', disposal_type: type, disposal_rows: 1, journals: 1 });
    }
  });

  it.each(['nonsense', 'unspecified', 'Sale'])('%s is a 400 and writes nothing', async (type) => {
    const id = await asset();
    const out = await callAs(c, token, disposeRoute, 'POST',
      { proceeds: 0, disposalDate: '2026-06-15', disposalType: type }, { assetId: id });
    expect(out.status, out.body).toBe(400);
    expect(await state(id)).toMatchObject({
      status: 'available', disposal_type: null, ledger_rows: 0, disposal_rows: 0, journals: 0,
    });
  });

  it('logs the disposal with its figures and posted journal, and the Disposals list shows it', async () => {
    const id = await asset(12000);
    const out = await callAs(c, token, disposeRoute, 'POST',
      { proceeds: 5000, disposalDate: '2026-06-20', disposalType: 'sale', notes: 'Sold to staff member' },
      { assetId: id });
    expect(out.status, out.body).toBe(200);
    const journalEntryId = (out.data as { journalEntryId: string }).journalEntryId;
    const rows = (await sql`
      SELECT disposal_date::TEXT AS disposal_date, disposal_method, disposal_amount::FLOAT AS amount,
        book_value_at_disposal::FLOAT AS book, gain_loss::FLOAT AS gain_loss, reason,
        journal_entry_id::TEXT AS je, created_by
      FROM asset_disposals WHERE asset_id = ${id}::UUID`) as Row[];
    expect(rows).toEqual([{
      disposal_date: '2026-06-20', disposal_method: 'sale', amount: 5000, book: 12000, gain_loss: -7000,
      reason: 'Sold to staff member', je: journalEntryId, created_by: c.fx.userId,
    }]);
    const je = (await sql`SELECT status FROM gl_journal_entries
      WHERE id = ${journalEntryId}::UUID AND company_id = ${c.fx.companyId}::UUID`) as Row[];
    expect(je).toEqual([{ status: 'posted' }]);

    const list = await callAs(c, token, disposalsList as Route, 'GET', {}, {});
    expect(list.status, list.body).toBe(200);
    const listed = (list.data as Row[]).filter((r) => r.asset_id === id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ disposal_method: 'sale', journal_entry_id: journalEntryId });
  });

  it.each([['absent', {}], ['empty', { disposalType: '' }]])('a disposal with the type %s is logged as unspecified, not refused',
    async (_label, extra) => {
      const id = await asset();
      const out = await callAs(c, token, disposeRoute, 'POST', { proceeds: 0, disposalDate: '2026-06-21', ...extra },
        { assetId: id });
      expect(out.status, out.body).toBe(200);
      expect(await state(id)).toMatchObject({ status: 'disposed', disposal_type: null, disposal_rows: 1 });
      const m = (await sql`SELECT disposal_method FROM asset_disposals WHERE asset_id = ${id}::UUID`) as Row[];
      expect(m).toEqual([{ disposal_method: 'unspecified' }]);
    });

  // The user is a member of BOTH companies, so RLS on assets (membership) lets the other one's rows through and
  // only the route's company_id filter keeps them out of this company's list.
  it("the Disposals list never shows another company's disposal, even one the user also belongs to", async () => {
    const other = crypto.randomUUID();
    await sql`INSERT INTO companies (id, name, registration_number)
      VALUES (${other}::UUID, ${`ADT other ${c.fx.tag}`}, ${`ADT-${other.slice(0, 8)}`})`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${other}::UUID, ${c.fx.userId}, 'admin')`;
    try {
      const foreign = String(((await sql`
        INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status)
        VALUES (${other}::UUID, 'ADT-FOREIGN', 'Foreign asset', '2026-01-10', 1000, 5, 'disposed')
        RETURNING id`) as Row[])[0]!.id);
      await sql`INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method, book_value_at_disposal, gain_loss)
        VALUES (${foreign}::UUID, '2026-06-01', 'sale', 1000, 0)`;
      const list = await callAs(c, token, disposalsList as Route, 'GET', {}, {});
      expect(list.status, list.body).toBe(200);
      const rows = list.data as Row[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.asset_id === foreign)).toEqual([]);
    } finally {
      await sql`DELETE FROM asset_disposals WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${other}::UUID)`;
      await sql`DELETE FROM assets WHERE company_id = ${other}::UUID`;
      await sql`DELETE FROM company_users WHERE company_id = ${other}::UUID`;
      await sql`DELETE FROM companies WHERE id = ${other}::UUID`;
    }
  });
});
