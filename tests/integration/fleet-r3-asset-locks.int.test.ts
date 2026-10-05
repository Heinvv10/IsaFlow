/**
 * Round 3 (brk-fleet B1 on 227f45e29): the asset writers hold the asset FOR NO KEY UPDATE, not FOR UPDATE.
 *
 * The link (bank line -> asset FOR KEY SHARE) and the fleet-record create (asset FOR KEY SHARE, then the composite-FK
 * check) take KEY SHARE on the asset. An asset writer that held it FOR UPDATE while it waited on journal numbering
 * (an uncommitted journal of the same company: entry_number MAX+1 against the unique index) closed a cycle with a
 * multi-line allocator that holds that journal and waits on the bank line: link -> dispose -> allocator -> link, a 40P01.
 * The writers change no key column, so FOR NO KEY UPDATE serialises them against each other and conflicts with no KEY
 * SHARE. Each writer below is the REAL path — dispose and below-threshold through their routes, depreciation through
 * `lockAssetTaxBase` — stalled after its asset lock by an uncommitted journal on a raw connection (X).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { lockAssetTaxBase } from '@/modules/accounting/services/gl/assetTaxAccumulation';
import bankMatchAsset from '../../pages/api/accounting/bank-match-asset';
import dispose from '../../pages/api/accounting/assets/[assetId]/dispose';
import belowThreshold from '../../pages/api/accounting/assets/below-threshold';
import fuelRoute from '../../pages/api/accounting/assets/[assetId]/fuel';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras, setupWithUser } from './d10-helpers';
import { heldWork, newId, seedLine, type Route } from './d12-helpers';
import { callAs, clearFleet, linkState } from './fleet-helpers';

let c: Ctx;
let token = '';
let costAccount = '';
const category = newId();
type Row = Record<string, unknown>;
const FUEL = { fillDate: '2026-06-20', litres: 40, amount: 800 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadlocks = async () => Number(((await sql`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`) as Row[])[0]!.deadlocks);

async function asset(price = 450000, withCategory = false): Promise<string> {
  return String(((await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years, status,
      gl_asset_account_id, category_id)
    VALUES (${c.fx.companyId}::UUID, ${`R3-${++c.seq}-${c.fx.tag.slice(-8)}`}, ${`R3 vehicle ${c.seq}`}, '2026-01-10', ${price},
      5, 'available', ${costAccount}::UUID, ${withCategory ? category : null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}

/** X: an allocator's uncommitted journal — the next journal of the company waits on its entry number. */
async function holdJournalNumber(): Promise<PoolClient> {
  const x = await c.fx.pool.connect();
  await x.query('BEGIN');
  await x.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES ($1, '2026-06-20', 'R3 X', 'posted', $2)`, [c.fx.companyId, c.fx.userId]);
  return x;
}

/** Until a backend of this database waits on a lock while inserting a journal (the stalled asset writer). */
async function writerStalled(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const n = Number(((await sql`SELECT COUNT(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO gl_journal_entries%'`) as Row[])[0]!.n);
    if (n > 0) return;
    await sleep(100);
  }
  throw new Error('the asset writer never reached its journal');
}

const createFuel = (a: string) => callAs(c, token, fuelRoute as Route, 'POST', FUEL, { assetId: a });
const fuelCount = async (a: string) => Number(((await sql`SELECT COUNT(*) AS n FROM fleet_fuel_transactions
  WHERE asset_id = ${a}::UUID`) as Row[])[0]!.n);

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('round 3: asset writers take FOR NO KEY UPDATE', () => {
  beforeAll(async () => {
    assertNotProductionDb('fleet r3');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('FL3'));
    const acct = async (code: string, type: string, subtype: string, normal: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
        is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, ${code}, ${`R3 ${subtype} ${c.fx.tag}`}, ${type}, ${subtype}, ${normal}, true, true)
      RETURNING id`) as Row[])[0]!.id);
    costAccount = await acct('1500', 'asset', 'fixed_asset', 'debit');
    await acct('1510', 'asset', 'accumulated_depreciation', 'credit');
    await acct('8100', 'expense', 'disposal_profit_loss', 'debit');
    clearSystemAccountCache(c.fx.companyId);
    await sql`INSERT INTO asset_categories (id, name, code, sars_rate, sars_years, capitalization_threshold)
      VALUES (${category}::UUID, ${`R3 tools ${category.slice(0, 8)}`}, ${`R3-${category.slice(0, 8)}`}, 0.33, 3, 5000)`;
  }, 120000);
  afterAll(async () => {
    await clearFleet(c);
    await sql`DELETE FROM asset_categories WHERE id = ${category}::UUID`;
    await clearExtras(c); await teardown(c);
  }, 120000);

  it('A1: link vs a dispose stalled on journal numbering vs the journal holder taking the line — no 40P01', async () => {
    const A = await asset();
    const L = await seedLine(c, c.fx.bankAccountId, 501.01);
    const before = await linkState(L);
    const d0 = await deadlocks();
    const x = await holdJournalNumber();
    let xr: unknown = null;
    const dp = callAs(c, token, dispose as Route, 'POST', { proceeds: 0, disposalDate: '2026-06-21' }, { assetId: A });
    try {
      await writerStalled();
      const t0 = Date.now();
      const kp = callAs(c, token, bankMatchAsset as Route, 'POST', { bankTransactionId: L, assetId: A });
      await sleep(500);
      // X now takes the line the link holds (or held).
      const xp = x.query('SELECT id FROM bank_transactions WHERE id = $1 FOR UPDATE', [L]).then(() => 'locked', (e: Error) => e.message);
      const k = await kp;
      const kMs = Date.now() - t0;
      xr = await xp;
      expect(k.status, k.body).toBe(200);
      expect(kMs).toBeLessThan(3000);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined); x.release();
      await dp.catch(() => undefined); // never leave the writer in flight for the next test
    }
    const d = await dp;
    expect(d.status, d.body).toBe(200);
    expect(xr).toBe('locked');
    expect(await deadlocks() - d0, 'a 40P01 occurred').toBe(0);
    expect(await linkState(L)).toMatchObject({ status: before.status, rec: before.rec, jl: before.jl, asset: A });
  }, 60000);

  it('dispose holding the asset: a fuel-record create does not wait for it', async () => {
    const A = await asset();
    const x = await holdJournalNumber();
    const dp = callAs(c, token, dispose as Route, 'POST', { proceeds: 0, disposalDate: '2026-06-22' }, { assetId: A });
    try {
      await writerStalled();
      const out = await createFuel(A);
      expect(out.status, out.body).toBe(201);
      expect(out.ms).toBeLessThan(3000);
    } finally { await x.query('ROLLBACK').catch(() => undefined); x.release(); await dp.catch(() => undefined); }
    expect((await dp).status).toBe(200);
    expect(await fuelCount(A)).toBe(1);
  }, 60000);

  it('below-threshold holding the asset: a fuel-record create does not wait for it', async () => {
    const A = await asset(1200, true);
    const x = await holdJournalNumber();
    const bp = callAs(c, token, belowThreshold as Route, 'POST', { assetId: A });
    try {
      await writerStalled();
      const out = await createFuel(A);
      expect(out.status, out.body).toBe(201);
      expect(out.ms).toBeLessThan(3000);
    } finally { await x.query('ROLLBACK').catch(() => undefined); x.release(); await bp.catch(() => undefined); }
    const b = await bp;
    expect(b.status, b.body).toBe(200);
    expect(await fuelCount(A)).toBe(1);
  }, 60000);

  it('depreciation holding the asset (lockAssetTaxBase): a fuel-record create does not wait for it', async () => {
    const A = await asset();
    const held = await heldWork(c, () => lockAssetTaxBase(c.fx.companyId, A, '202606'));
    try {
      expect(held.error).toBeNull();
      const out = await createFuel(A);
      expect(out.status, out.body).toBe(201);
      expect(out.ms).toBeLessThan(3000);
    } finally { await held.rollback(); }
    expect(await fuelCount(A)).toBe(1);
  }, 60000);

  it('two dispositions of one asset still serialise: the second waits and is refused as already disposed', async () => {
    const A = await asset();
    const x = await holdJournalNumber();
    const first = callAs(c, token, dispose as Route, 'POST', { proceeds: 0, disposalDate: '2026-06-23' }, { assetId: A });
    let second;
    try {
      await writerStalled();
      second = callAs(c, token, dispose as Route, 'POST', { proceeds: 0, disposalDate: '2026-06-23' }, { assetId: A });
      await sleep(800);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined); x.release();
      await first.catch(() => undefined); await second?.catch(() => undefined);
    }
    expect((await first).status).toBe(200);
    const s = await second!;
    expect(s.status, s.body).toBe(400);
    expect(s.body).toMatch(/already disposed/);
  }, 60000);
});
