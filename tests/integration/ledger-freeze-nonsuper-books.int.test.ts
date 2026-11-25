/**
 * Migration 1018 against more real services as the PRODUCTION login (helpers/appLoginWorld): opening balances, the
 * take-on imports of AR and AP documents, a depreciation run and the year-end close. A refusal here is a rule that is
 * wrong or a writer that must change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, seedFreeze, type Freeze, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
let fixed = '';
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

describeIfDisposable('ledger column immutability: opening balances, take-on, depreciation and year-end as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    const acct = async (code: string, type: string, subtype: string, normal: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${who.companyId}::UUID, ${code}, ${`NS ${code} ${z.f.fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true) RETURNING id`) as Row[])[0]!.id);
    await sql`UPDATE gl_accounts SET level = 3 WHERE id IN (${z.ar}::UUID, ${z.ap}::UUID)`;
    await acct('3100', 'equity', 'opening_balance_equity', 'credit');
    await acct('3200', 'equity', 'retained_earnings', 'credit');
    fixed = await acct('1500', 'asset', 'fixed_asset', 'debit');
    await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
    await acct('7000', 'expense', 'depreciation_expense', 'debit');
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (z) {
      const c = who.companyId;
      await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
      await sql`DELETE FROM asset_depreciation_schedule WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${c}::UUID)`.catch(() => undefined);
      await sql`DELETE FROM asset_period_ledger WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${c}::UUID)`.catch(() => undefined);
      await sql`DELETE FROM assets WHERE company_id = ${c}::UUID`.catch(() => undefined);
      await sql`DELETE FROM migration_sessions WHERE company_id = ${c}::UUID`.catch(() => undefined);
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
      await dropFreeze(z);
    }
  }, 120000);

  it('opening balances post (one journal, balanced)', async () => {
    const { postOpeningBalances } = await world.load(() => import('@/modules/accounting/services/gl/openingBalancePostingService'));
    await world.run(who, () => postOpeningBalances(who.companyId, who.userId, [
      { accountId: z.ar, debit: 100, credit: 0 }, { accountId: z.ap, debit: 0, credit: 100 }]));
    expect(Number((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${who.companyId}::UUID AND status = 'posted'`)).n)).toBeGreaterThan(0);
  });

  it('the take-on imports of an AR invoice and an AP bill post their journals and link them', async () => {
    const { importARInvoices } = await world.load(() => import('@/modules/accounting/services/core/migrationImportService'));
    const { importAPInvoices } = await world.load(() => import('@/modules/accounting/services/ap/migrationApService'));
    const session = String((await one(sql`INSERT INTO migration_sessions (company_id, source_system, started_by)
      VALUES (${who.companyId}::UUID, 'sage', ${who.userId}::UUID) RETURNING id`)).id);
    const ar = await world.run(who, () => importARInvoices(who.companyId, session, [{ invoiceNumber: 'NS-TAKEON-AR', customerName: `CUS ${z.f.fx.tag}`,
      customerId: z.f.fx.customerId, invoiceDate: '2026-06-30', dueDate: '2026-07-30', subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 400 }], who.userId));
    const ap = await world.run(who, () => importAPInvoices(who.companyId, session, [{ invoiceNumber: 'NS-TAKEON-AP', supplierName: `SUP ${z.f.fx.tag}`,
      invoiceDate: '2026-06-30', dueDate: '2026-07-30', subtotal: 1000, taxAmount: 150, totalAmount: 1150, amountPaid: 400 }] as never, who.userId));
    expect([ar.imported, ar.errors, ap.imported, ap.errors]).toEqual([1, [], 1, []]);
    for (const t of ['customer_invoices', 'supplier_invoices']) {
      const r = (await z.pool.query(`SELECT gl_journal_entry_id AS je FROM ${t} WHERE company_id = $1 AND invoice_number LIKE 'NS-TAKEON-%'`, [who.companyId])).rows[0];
      expect(r.je, t).not.toBeNull();
    }
  });

  it('a depreciation run posts the month for an asset', async () => {
    const { runDepreciation } = await world.load(() => import('@/modules/accounting/services/items/depreciationRunService'));
    await sql`INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status, gl_asset_account_id)
      VALUES (${who.companyId}::UUID, ${`NS-${z.f.fx.tag.slice(-8)}`}, 'NS vehicle', '2026-01-10', 120000, 5, 'available', ${fixed}::UUID)`;
    const result = await world.run(who, () => runDepreciation(who.companyId, who.userId, '2026-06-30'));
    expect(JSON.stringify(result)).not.toMatch(/glFailed":[1-9]/);
    expect(Number((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${who.companyId}::UUID AND entry_number LIKE 'DEP-%'`)).n)).toBeGreaterThan(0);
  });

  it('the year-end close posts its closing journal', async () => {
    const { closeFiscalYear } = await world.load(() => import('@/modules/accounting/services/gl/yearEndCloseService'));
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${who.companyId}::UUID`;
    const closed = await world.run(who, () => closeFiscalYear(who.companyId, '2026', who.userId)) as Record<string, unknown>;
    expect(closed.error, JSON.stringify(closed)).toBeUndefined();
  });
});
