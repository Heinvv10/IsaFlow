/**
 * delete_fixed_asset against real Postgres.
 *  - the FK census: the tables that reference assets are exactly the ones the delete service counts, so a new one
 *    fails here until it is counted;
 *  - a clean asset is deleted, company-scoped (another company's id reads Not found and survives);
 *  - EVERY footprint refuses and nothing is deleted or cascaded away;
 *  - two connections: a depreciation run holding the asset makes the delete wait and then refuse; a delete holding the
 *    asset makes the run wait and then find it gone, leaving no ledger row and no journal behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createFixedAssetTool } from '@/lib/mcp/tools/writeCreateFixedAsset';
import { deleteFixedAssetTool } from '@/lib/mcp/tools/writeDeleteFixedAsset';
import { runDepreciation } from '@/modules/accounting/services/items/depreciationRunService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx, runOn, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import { waitBlockedBy } from './helpers/numraceGate';

type Row = Record<string, unknown>;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;

let fx: Fixture;
let other: Fixture;
let seededCategories: string[] = [];
let seq = 0;

const ctxFor = (f: Fixture) => ({
  companyId: f.companyId, userId: f.userId, scopes: ['write:journals'], companyRole: 'owner',
  tokenJti: 'jti-del', oauthAppId: null,
}) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;
const del = (f: Fixture, assetId: string, extra: Record<string, unknown> = {}) =>
  inTx(f, () => deleteFixedAssetTool.handler({ asset_id: assetId, idempotency_key: 'k', ...extra }, ctxFor(f)));

/** An asset made by the real create tool: the thing this tool undoes. */
async function make(f: Fixture, name = `Asset ${++seq}`): Promise<{ id: string; number: string }> {
  const r = await inTx(f, () => createFixedAssetTool.handler({
    name, category: 'computers', purchase_date: '2026-01-10', cost: 12000, useful_life_years: 3, idempotency_key: 'k',
  }, ctxFor(f)));
  const o = JSON.parse(text(r)) as { asset_id: string; asset_number: string };
  return { id: o.asset_id, number: o.asset_number };
}
const exists = async (id: string) =>
  ((await sql`SELECT 1 FROM assets WHERE id = ${id}::UUID`) as Row[]).length === 1;
const count = async (query: Promise<unknown>) => Number(((await query) as Row[])[0]!.n);

async function journal(f: Fixture, col: 'entry_number' | 'reference', value: string): Promise<void> {
  const entry = col === 'entry_number' ? value : `T-${++seq}-${f.tag.slice(-6)}`;
  const ref = col === 'reference' ? value : null;
  await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, reference)
    VALUES (${f.companyId}::UUID, ${entry}, '2026-02-01'::DATE, 'footprint', 'manual', 'draft', ${f.userId}, ${ref})`;
}

describeIfDb('delete_fixed_asset: real Postgres', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    fx = await seedFixture('DFA', DATABASE_URL!);
    other = await seedFixture('DFA-O', DATABASE_URL!);
    const acct = async (code: string, type: string, subtype: string, normal: string) => sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
        is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, ${code}, ${`DFA ${code} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)`;
    await acct('5800', 'expense', 'depreciation_expense', 'debit');
    await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
    clearSystemAccountCache(fx.companyId);
    seededCategories = ((await sql`
      INSERT INTO asset_categories (name, code, sars_rate, sars_years) VALUES ('Computers', 'computers', 33.33, 3)
      ON CONFLICT (code) DO NOTHING RETURNING code`) as Row[]).map((r) => String(r.code));
  }, 60000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      await sql`DELETE FROM bank_transactions WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM fleet_fuel_transactions WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM fleet_service_history WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM asset_disposals WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${f.companyId}::UUID)`;
      await sql`DELETE FROM asset_depreciation_schedule WHERE asset_id IN (SELECT id FROM assets WHERE company_id = ${f.companyId}::UUID)`;
      await sql`DELETE FROM asset_period_ledger WHERE company_id = ${f.companyId}::UUID`;
      await sql`DELETE FROM assets WHERE company_id = ${f.companyId}::UUID`;
    }
    await sql`DELETE FROM asset_categories WHERE code = ANY(${seededCategories}::TEXT[])`;
    await dropFixture(fx);
    await dropFixture(other);
  }, 60000);

  it('FK census: exactly the tables the delete service counts reference assets', async () => {
    const fks = (await sql`
      SELECT DISTINCT conrelid::regclass::text AS tbl FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.assets'::regclass ORDER BY 1`) as Row[];
    expect(fks.map((r) => r.tbl)).toEqual([
      'asset_depreciation_schedule', 'asset_disposals', 'asset_period_ledger', 'bank_transactions',
      'fleet_fuel_transactions', 'fleet_service_history',
    ]);
  });

  it('deletes a clean asset: dry run first (nothing changes), then live; the number is free again', async () => {
    const a = await make(fx);
    const dry = await del(fx, a.id, { dry_run: true });
    expect(dry.wroteNothing).toBe(true);
    expect(JSON.parse(text(dry))).toMatchObject({ dryRun: true, would_delete: { asset_id: a.id, asset_number: a.number } });
    expect(await exists(a.id)).toBe(true);
    const live = await del(fx, a.id);
    expect(live.isError, text(live)).toBeUndefined();
    expect(JSON.parse(text(live))).toMatchObject({ deleted: true, asset_id: a.id });
    expect(await exists(a.id)).toBe(false);
    expect((await make(fx)).number).toBe(a.number);
  }, 60000);

  it('is company-scoped: another company\'s asset reads Not found and survives', async () => {
    const theirs = await make(other);
    const r = await del(fx, theirs.id);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Not found');
    expect(await exists(theirs.id)).toBe(true);
    const unknown = await del(fx, crypto.randomUUID());
    expect(text(unknown)).toBe('Not found');
  }, 60000);

  const footprints: Array<[string, string, (id: string, number: string) => Promise<void>]> = [
    ['an asset_period_ledger row', 'depreciation has been recorded', async (id) => {
      await sql`INSERT INTO asset_period_ledger (company_id, asset_id, period_date, yyyymm)
        VALUES (${fx.companyId}::UUID, ${id}::UUID, '2026-02-28'::DATE, '202602')`; }],
    ['an asset_depreciation_schedule row', 'depreciation has been recorded', async (id) => {
      await sql`INSERT INTO asset_depreciation_schedule (asset_id, period_date, depreciation_method, amount, accumulated_total, book_value_after)
        VALUES (${id}::UUID, '2026-02-28'::DATE, 'straight_line', 100, 100, 11900)`; }],
    ['accumulated depreciation on the asset', 'depreciation has been recorded', async (id) => {
      await sql`UPDATE assets SET accumulated_depreciation = 100 WHERE id = ${id}::UUID`; }],
    ['a last depreciation date', 'depreciation has been recorded', async (id) => {
      await sql`UPDATE assets SET last_depreciation_date = '2026-02-28'::DATE WHERE id = ${id}::UUID`; }],
    ['an asset_disposals row', 'a disposal is recorded', async (id) => {
      await sql`INSERT INTO asset_disposals (asset_id, disposal_date, disposal_method, book_value_at_disposal, gain_loss)
        VALUES (${id}::UUID, '2026-03-01'::DATE, 'scrap', 0, 0)`; }],
    ['a disposed status', 'it is disposed', async (id) => {
      await sql`UPDATE assets SET status = 'disposed' WHERE id = ${id}::UUID`; }],
    ['a written_off status', 'it is written_off', async (id) => {
      await sql`UPDATE assets SET status = 'written_off' WHERE id = ${id}::UUID`; }],
    ['a DEP- journal by number', 'journal names it', async (_id, n) => journal(fx, 'entry_number', `DEP-${n}-2026-02`)],
    ['a DIS- journal by reference', 'journal names it', async (_id, n) => journal(fx, 'reference', `DIS-${n}-2026-02`)],
    ['an EXP- journal by reference', 'journal names it', async (_id, n) => journal(fx, 'reference', `EXP-${n}-2026-02-01`)],
    ['the below-threshold expensing flag', 'below the capitalisation threshold', async (id) => {
      await sql`UPDATE assets SET below_threshold = true WHERE id = ${id}::UUID`; }],
    ['a fuel record', 'fuel or service records', async (id) => {
      await sql`INSERT INTO fleet_fuel_transactions (company_id, asset_id, fill_date, litres, amount)
        VALUES (${fx.companyId}::UUID, ${id}::UUID, '2026-02-01'::DATE, 10, 100)`; }],
    ['a service record', 'fuel or service records', async (id) => {
      await sql`INSERT INTO fleet_service_history (company_id, asset_id, service_date, description, amount)
        VALUES (${fx.companyId}::UUID, ${id}::UUID, '2026-02-01'::DATE, 'service', 100)`; }],
    ['a linked bank transaction', 'bank transaction is linked', async (id) => {
      const tx = await seedBankTx(fx, { date: '2026-02-01', amount: -100, description: 'fuel' });
      await sql`UPDATE bank_transactions SET linked_asset_id = ${id}::UUID WHERE id = ${tx}::UUID`; }],
  ];

  it.each(footprints)('refuses %s, names the reason and deletes nothing (dry run alike)', async (_n, reason, add) => {
    const a = await make(fx);
    await add(a.id, a.number);
    const before = {
      ledger: await count(sql`SELECT COUNT(*)::INT AS n FROM asset_period_ledger WHERE asset_id = ${a.id}::UUID`),
      fuel: await count(sql`SELECT COUNT(*)::INT AS n FROM fleet_fuel_transactions WHERE asset_id = ${a.id}::UUID`),
      linked: await count(sql`SELECT COUNT(*)::INT AS n FROM bank_transactions WHERE linked_asset_id = ${a.id}::UUID`),
    };
    for (const dry of [true, false]) {
      const r = await del(fx, a.id, dry ? { dry_run: true } : {});
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toContain(reason);
      expect(text(r)).toContain('Dispose of it in the app');
    }
    expect(await exists(a.id)).toBe(true);
    expect(await count(sql`SELECT COUNT(*)::INT AS n FROM asset_period_ledger WHERE asset_id = ${a.id}::UUID`)).toBe(before.ledger);
    expect(await count(sql`SELECT COUNT(*)::INT AS n FROM fleet_fuel_transactions WHERE asset_id = ${a.id}::UUID`)).toBe(before.fuel);
    expect(await count(sql`SELECT COUNT(*)::INT AS n FROM bank_transactions WHERE linked_asset_id = ${a.id}::UUID`)).toBe(before.linked);
  }, 60000);

  it('a journal of ANOTHER company with the same number does not block the delete', async () => {
    const a = await make(fx);
    await journal(other, 'entry_number', `DEP-${a.number}-2026-02`);
    const r = await del(fx, a.id);
    expect(r.isError, text(r)).toBeUndefined();
    expect(await exists(a.id)).toBe(false);
  }, 60000);

  describe('concurrency: two connections', () => {
    const pidOf = async (c: { query: (q: string) => Promise<{ rows: Row[] }> }) =>
      Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);

    it('a depreciation run holding the asset: the delete waits, then sees the run\'s rows and refuses', async () => {
      const a = await make(fx);
      const run = await fx.pool.connect();
      const del1 = await fx.pool.connect();
      try {
        await run.query('BEGIN');
        const result = await runOn(fx, run, () => runDepreciation(fx.companyId, fx.userId, '2026-03-31'));
        expect(result.processed, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
        await del1.query('BEGIN');
        const pending = runOn(fx, del1, () => deleteFixedAssetTool.handler({ asset_id: a.id, idempotency_key: 'k' }, ctxFor(fx)));
        await waitBlockedBy(fx.pool, await pidOf(run));
        await run.query('COMMIT');
        const r = await pending;
        await del1.query('COMMIT');
        expect(r.isError, text(r)).toBe(true);
        expect(text(r)).toContain('depreciation has been recorded');
        expect(await exists(a.id)).toBe(true);
        expect(await count(sql`SELECT COUNT(*)::INT AS n FROM asset_period_ledger WHERE asset_id = ${a.id}::UUID`)).toBe(1);
      } finally {
        await run.query('ROLLBACK').catch(() => undefined);
        await del1.query('ROLLBACK').catch(() => undefined);
        run.release();
        del1.release();
      }
    }, 60000);

    it('a delete holding the asset: the run waits, then finds it gone and writes nothing for it', async () => {
      const a = await make(fx, 'Raced asset');
      const holder = await fx.pool.connect();
      const run = await fx.pool.connect();
      try {
        await holder.query('BEGIN');
        const r = await runOn(fx, holder, () => deleteFixedAssetTool.handler({ asset_id: a.id, idempotency_key: 'k' }, ctxFor(fx)));
        expect(r.isError, text(r)).toBeUndefined();
        await run.query('BEGIN');
        const pending = runOn(fx, run, () => runDepreciation(fx.companyId, fx.userId, '2026-04-30'));
        await waitBlockedBy(fx.pool, await pidOf(holder));
        await holder.query('COMMIT');
        const result = await pending;
        await run.query('COMMIT');
        expect(await exists(a.id)).toBe(false);
        expect(await count(sql`SELECT COUNT(*)::INT AS n FROM asset_period_ledger WHERE asset_id = ${a.id}::UUID`)).toBe(0);
        expect(await count(sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries
          WHERE company_id = ${fx.companyId}::UUID AND entry_number = ${`DEP-${a.number}-2026-04`}`)).toBe(0);
        expect(result.glFailed + result.processed + result.skipped).toBe(result.total);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await run.query('ROLLBACK').catch(() => undefined);
        holder.release();
        run.release();
      }
    }, 60000);
  });
});
