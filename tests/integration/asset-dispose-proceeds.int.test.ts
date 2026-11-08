/**
 * Asset disposal: proceeds validation (2026-11-07, found seeding the Demo company).
 *
 * POST /api/accounting/assets/:assetId/dispose read proceeds with Number(): "abc", a negative, a sub-cent amount or
 * one too large for the journal reached postAssetDisposalToGL and died there as a 500 ("Entry is not balanced", a
 * numeric overflow). The rollback was clean, but a bad input is a 400, refused before any write.
 *
 * The rule: a JSON number whose String() is a plain decimal with at most 2 decimals, or a trimmed string of the same
 * shape; omitted means 0. The journal's debit and credit totals must each fit gl_journal_lines' NUMERIC(15,2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import dispose from '../../pages/api/accounting/assets/[assetId]/dispose';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import type { Route } from './d12-helpers';
import { callAs, clearFleet } from './fleet-helpers';

type Row = Record<string, unknown>;
type Co = { c: Ctx; token: string; cost: string };
let main: Co;
const extra: Co[] = [];

async function company(prefix: string): Promise<Co> {
  const { c, token } = await setupWithUser(prefix);
  const acct = async (code: string, type: string, subtype: string, normal: string) => String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
      is_active, is_system_account)
    VALUES (${c.fx.companyId}::UUID, ${code}, ${`${prefix} ${subtype} ${c.fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
    RETURNING id`) as Row[])[0]!.id);
  const cost = await acct('1500', 'asset', 'fixed_asset', 'debit');
  await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
  await acct('8100', 'expense', 'disposal_profit_loss', 'debit');
  clearSystemAccountCache(c.fx.companyId);
  return { c, token, cost };
}

// Cost 450,000 with 100,000 accumulated depreciation: carrying amount 350,000.
async function asset(co: Co): Promise<string> {
  return String(((await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, accumulated_depreciation,
      useful_life_years, status, gl_asset_account_id)
    VALUES (${co.c.fx.companyId}::UUID, ${`DP-${++co.c.seq}-${co.c.fx.tag.slice(-8)}`}, ${`Proceeds ${co.c.seq}`},
      '2026-01-10', 450000, 100000, 5, 'available', ${co.cost}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}

const run = (co: Co, id: string, body: Record<string, unknown>) =>
  callAs(co.c, co.token, dispose as Route, 'POST', { disposalDate: '2026-06-21', disposalType: 'sale', ...body }, { assetId: id });

const state = async (id: string) => ((await sql`
  SELECT a.status,
    (SELECT COUNT(*)::INT FROM asset_period_ledger l WHERE l.asset_id = a.id) AS ledger_rows,
    (SELECT COUNT(*)::INT FROM asset_disposals d WHERE d.asset_id = a.id) AS disposal_rows,
    (SELECT COUNT(*)::INT FROM gl_journal_entries j
       WHERE j.company_id = a.company_id AND j.source = 'auto_asset_disposal' AND j.reference LIKE 'DIS-' || a.asset_number || '-%')
       AS journals
  FROM assets a WHERE a.id = ${id}::UUID`) as Row[])[0]!;

const NOTHING = { status: 'available', ledger_rows: 0, disposal_rows: 0, journals: 0 };

const proceedsOf = async (id: string) => ((await sql`
  SELECT d.disposal_amount::TEXT AS logged, l.disposal_proceeds::TEXT AS ledger,
    (SELECT SUM(jl.debit)::TEXT FROM gl_journal_lines jl WHERE jl.journal_entry_id = d.journal_entry_id
       AND jl.description LIKE 'Disposal proceeds:%') AS bank_debit
  FROM asset_disposals d JOIN asset_period_ledger l ON l.asset_id = d.asset_id
  WHERE d.asset_id = ${id}::UUID`) as Row[])[0]!;

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('asset dispose: proceeds validation', () => {
  beforeAll(async () => {
    assertNotProductionDb('asset dispose proceeds');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    main = await company('ADP');
  }, 120000);
  afterAll(async () => {
    for (const co of [main, ...extra]) {
      if (!co) continue;
      await clearFleet(co.c); await clearExtras(co.c); await teardown(co.c);
    }
  }, 120000);

  it.each([
    ['null', null], ['""', ''], ['" "', ' '], ['true', true], ['-5', -5], ['"-5"', '-5'], ['"abc"', 'abc'], ['{}', {}],
    ['[5]', [5]], ['"0x10"', '0x10'], ['"1e3"', '1e3'], ['"Infinity"', 'Infinity'], ['"12,5"', '12,5'], ['".5"', '.5'],
    ['"5."', '5.'], ['0.001', 0.001], ['"0.001"', '0.001'], ['1e-7', 1e-7], ['0.1+0.2', 0.1 + 0.2], ['1e20', 1e20],
    ['"+5"', '+5'],
  ])('proceeds %s is a 400 and writes nothing', async (_label, proceeds) => {
    const id = await asset(main);
    const out = await run(main, id, { proceeds });
    expect(out.status, out.body).toBe(400);
    expect(await state(id)).toMatchObject(NOTHING);
  });

  it.each([
    ['omitted', undefined, '0.00'], ['0', 0, '0.00'], ['"0.00"', '0.00', '0.00'], ['"123.45"', '123.45', '123.45'],
    ['" 12 "', ' 12 ', '12.00'], ['123.4', 123.4, '123.40'], ['1234567890123.45', 1234567890123.45, '1234567890123.45'],
  ])('proceeds %s disposes and records the exact amount', async (_label, proceeds, expected) => {
    const id = await asset(main);
    const body = proceeds === undefined ? {} : { proceeds };
    const out = await run(main, id, { ...body, disposalDate: '2026-05-15' });
    expect(out.status, out.body).toBe(200);
    expect(await state(id)).toMatchObject({ status: 'disposed', ledger_rows: 1, disposal_rows: 1, journals: 1 });
    const got = await proceedsOf(id);
    expect(got).toMatchObject({ logged: expected, ledger: expected });
    expect(got.bank_debit).toBe(expected === '0.00' ? null : expected);
  });

  // The asset page sends Number(x) || 0.
  it('the asset page body (a number) disposes', async () => {
    const id = await asset(main);
    const out = await run(main, id, { proceeds: Number('2500.5') || 0, disposalType: 'scrap' });
    expect(out.status, out.body).toBe(200);
    expect(await proceedsOf(id)).toMatchObject({ logged: '2500.50' });
  });

  // NUMERIC(15,2) bounds the journal's debit and credit totals (enforce_balanced_entry sums gl_journal_lines) and
  // each account's running total in gl_account_balances, so each case runs in a company of its own whose accounts
  // start at zero. Debits = 100,000 acc dep + proceeds; credits = 450,000 cost + gain (proceeds - 350,000): both are
  // proceeds + 100,000, so the largest proceeds is 9,999,999,999,999.99 - 100,000.
  it.each([
    ['number', 9999999899999.99, 200], ['string', '9999999899999.99', 200],
    ['number', 9999999900000.00, 400], ['string', '9999999900000.00', 400],
  ])('ceiling (%s %s) answers %s, to the cent', async (_kind, proceeds, status) => {
    const co = await company(`AZ${extra.length}`);
    extra.push(co);
    const id = await asset(co);
    const out = await run(co, id, { proceeds });
    expect(out.status, out.body).toBe(status);
    if (status === 200) {
      expect(await proceedsOf(id)).toMatchObject({ logged: '9999999899999.99', bank_debit: '9999999899999.99' });
    } else {
      expect(await state(id)).toMatchObject(NOTHING);
    }
  }, 60000);

  it('negative accumulated depreciation is a 400 and writes nothing (was an unbalanced-journal 500)', async () => {
    const id = await asset(main);
    await sql`UPDATE assets SET accumulated_depreciation = -200 WHERE id = ${id}::UUID AND company_id = ${main.c.fx.companyId}::UUID`;
    const out = await run(main, id, { proceeds: 100 });
    expect(out.status, out.body).toBe(400);
    expect(await state(id)).toMatchObject(NOTHING);
  });

  it.each([['a numeric disposalDate', { disposalDate: 20260621 }], ['a null body', null]])('%s is a 400, not a 500', async (_l, body) => {
    const id = await asset(main);
    const out = await callAs(main.c, main.token, dispose as Route, 'POST', body as Record<string, unknown>, { assetId: id });
    expect(out.status, out.body).toBe(400);
    expect(await state(id)).toMatchObject(NOTHING);
  });

  // A loss posts as a debit: acc dep 100,000 + proceeds 1,000 + loss 349,000 = the 450,000 cost credit.
  it('a loss-making disposal under the ceiling still disposes (the loss leg is a debit, not extra credit)', async () => {
    const id = await asset(main);
    const out = await run(main, id, { proceeds: '1000.00' });
    expect(out.status, out.body).toBe(200);
    const legs = (await sql`
      SELECT SUM(jl.debit)::TEXT AS dr, SUM(jl.credit)::TEXT AS cr FROM gl_journal_lines jl
      JOIN asset_disposals d ON d.journal_entry_id = jl.journal_entry_id WHERE d.asset_id = ${id}::UUID`) as Row[];
    expect(legs[0]).toEqual({ dr: '450000.00', cr: '450000.00' });
  });
});
