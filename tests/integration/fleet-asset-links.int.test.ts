/**
 * Asset / fleet LINKS on a bank line (mig 853, Hein 2026-10-05) through the real routes (withAuth + JWT, app_user):
 *   · a link is an annotation — it writes only the link columns (the other two cleared) and never the line's status,
 *     journal link or reconciliation stamp;
 *   · a null id unlinks that route's kind;
 *   · a foreign asset / fuel / service record answers 404 IDENTICAL to a missing one, and nothing is written;
 *   · a pending line is refused (409) before any write;
 *   · the database refuses two links on one line (CHECK) and a link to another company's record (composite FK);
 *   · the bank transaction list and the asset's bank-links read return the link with its label.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import bankMatchAsset from '../../pages/api/accounting/bank-match-asset';
import bankMatchFleet from '../../pages/api/accounting/bank-match-fleet';
import bankTransactions from '../../pages/api/accounting/bank-transactions';
import assetBankLinks from '../../pages/api/accounting/assets/[assetId]/bank-links';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { teardown, type Ctx } from './d8-r4-helpers';
import { inTx } from './helpers/l1FifoFixture';
import { setBankLineLink } from '@/modules/accounting/services/bank/bankAssetLinkService';
import { clearExtras, setupWithUser } from './d10-helpers';
import { newBank, newId, seedLine, seedPair, type Route } from './d12-helpers';
import { callAs, clearFleet, linkState, messageOf, newAsset, newFuel, newService } from './fleet-helpers';

let c: Ctx; let o: Ctx;
let token = '';
let bank = '';
type Row = Record<string, unknown>;
const asset = (bt: string, assetId: string | null) => callAs(c, token, bankMatchAsset as Route, 'POST', { bankTransactionId: bt, assetId });
const fleet = (bt: string, fleetEntityType: 'fuel' | 'service', fleetEntityId: string | null) =>
  callAs(c, token, bankMatchFleet as Route, 'POST', { bankTransactionId: bt, fleetEntityType, fleetEntityId });

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('asset / fleet links on a bank line', () => {
  beforeAll(async () => {
    assertNotProductionDb('fleet links');
    assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    ({ c, token } = await setupWithUser('FLL'));
    ({ c: o } = await setupWithUser('FLO'));
    bank = await newBank(c);
  }, 120000);
  afterAll(async () => {
    for (const x of [c, o]) { await clearFleet(x); await clearExtras(x); await teardown(x); }
  }, 120000);

  it('links an asset, then a fuel record, then a service record — one link at a time; the line is not touched', async () => {
    const bt = await seedLine(c, bank, 850);
    const a = await newAsset(c); const f = await newFuel(c, a); const s = await newService(c, a);
    const before = await linkState(bt);

    const outA = await asset(bt, a);
    expect(outA.status, outA.body).toBe(200);
    expect(outA.data).toMatchObject({ linked: true, bankTransactionId: bt, assetId: a });
    expect(await linkState(bt)).toMatchObject({ status: 'imported', jl: null, rec: null, asset: a, fuel: null, service: null });

    const outF = await fleet(bt, 'fuel', f);
    expect(outF.status, outF.body).toBe(200);
    expect(await linkState(bt)).toMatchObject({ status: 'imported', asset: null, fuel: f, service: null });

    const outS = await fleet(bt, 'service', s);
    expect(outS.status, outS.body).toBe(200);
    expect(await linkState(bt)).toMatchObject({ status: before.status, jl: null, rec: null, asset: null, fuel: null, service: s });
  }, 60000);

  it('a null id unlinks that kind only', async () => {
    const bt = await seedLine(c, bank, 851);
    const a = await newAsset(c); const f = await newFuel(c, a);
    expect((await asset(bt, a)).status).toBe(200);
    const off = await asset(bt, null);
    expect(off.status, off.body).toBe(200);
    expect(off.data).toMatchObject({ linked: false, bankTransactionId: bt, assetId: null });
    expect(await linkState(bt)).toMatchObject({ asset: null, fuel: null, service: null, status: 'imported' });

    expect((await fleet(bt, 'fuel', f)).status).toBe(200);
    expect((await fleet(bt, 'service', null)).status).toBe(200); // not the kind it carries: the fuel link stays
    expect(await linkState(bt)).toMatchObject({ fuel: f });
    expect((await fleet(bt, 'fuel', null)).status).toBe(200);
    expect(await linkState(bt)).toMatchObject({ asset: null, fuel: null, service: null });
  }, 60000);

  it('an allocated line keeps its status and journal line', async () => {
    const p = await seedPair(c, bank, 852);
    await sql`UPDATE bank_transactions SET status = 'allocated', matched_journal_line_id = ${p.jl}::UUID WHERE id = ${p.bt}::UUID`;
    const a = await newAsset(c);
    expect((await asset(p.bt, a)).status).toBe(200);
    expect(await linkState(p.bt)).toMatchObject({ status: 'allocated', jl: p.jl, rec: null, asset: a });
  }, 60000);

  it('a foreign asset / fuel / service record is 404, identical to a missing one; nothing written', async () => {
    const bt = await seedLine(c, bank, 853);
    const oa = await newAsset(o); const of = await newFuel(o, oa); const os = await newService(o, oa);
    const before = await linkState(bt);
    const cases: [() => ReturnType<typeof asset>, () => ReturnType<typeof asset>][] = [
      [() => asset(bt, oa), () => asset(bt, newId())],
      [() => fleet(bt, 'fuel', of), () => fleet(bt, 'fuel', newId())],
      [() => fleet(bt, 'service', os), () => fleet(bt, 'service', newId())],
    ];
    for (const [foreign, missing] of cases) {
      const f = await foreign(); const m = await missing();
      expect(f.status, f.body).toBe(404);
      expect(m.status, m.body).toBe(404);
      expect(messageOf(f)).toBe(messageOf(m));
      expect(messageOf(f)).not.toMatch(/[0-9a-f]{8}-/); // names no id
    }
    expect(await linkState(bt)).toEqual(before);
  }, 60000);

  // The route runs as app_user, where RLS already hides another company's rows. The service's own company predicate
  // must hold without it (a job, an MCP path or a BYPASSRLS role): called as the fixture owner, it still refuses.
  it('the service refuses another company\'s target without RLS (as the table owner)', async () => {
    const bt = await seedLine(c, bank, 857);
    const oa = await newAsset(o); const of = await newFuel(o, oa); const os = await newService(o, oa);
    const before = await linkState(bt);
    for (const [kind, id] of [['asset', oa], ['fuel', of], ['service', os]] as const) {
      expect(await inTx(c.fx, () => setBankLineLink(c.fx.companyId, bt, kind, id))).toEqual({ ok: false, refused: 'target' });
    }
    expect(await linkState(bt)).toEqual(before);
  }, 60000);

  it('a foreign bank line is 404 and is not written', async () => {
    const obt = await seedLine(o, await newBank(o), 854);
    const a = await newAsset(c);
    const out = await asset(obt, a);
    expect(out.status, out.body).toBe(404);
    expect(await linkState(obt)).toMatchObject({ asset: null });
  }, 60000);

  it('a pending line is refused 409 before any write', async () => {
    // A feed row is pending from birth (the feed-state trigger refuses posted -> pending), so seed it as the feed does.
    const conn = String(((await sql`INSERT INTO bank_feed_connections (bank_account_id, company_id)
      VALUES (${bank}::UUID, ${c.fx.companyId}::UUID) RETURNING id`) as Row[])[0]!.id);
    const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
        description, bank_feed_connection_id, provider_transaction_id, feed_state)
      VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, '2026-06-15', -855, 'FLEET PENDING', ${conn}::UUID,
        ${`pend-${newId()}`}, 'pending') RETURNING id`) as Row[])[0]!.id);
    try {
      const a = await newAsset(c);
      const before = await linkState(bt);
      const out = await asset(bt, a);
      expect(out.status, out.body).toBe(409);
      expect(messageOf(out)).toMatch(/still pending at the bank/);
      expect(await linkState(bt)).toEqual(before);
    } finally {
      await sql`DELETE FROM bank_transactions WHERE id = ${bt}::UUID`;
      await sql`DELETE FROM bank_feed_connections WHERE id = ${conn}::UUID`;
    }
  }, 60000);

  it('the database refuses two links on one line and a link to another company\'s record', async () => {
    const bt = await seedLine(c, bank, 856);
    const a = await newAsset(c); const f = await newFuel(c, a);
    const two = await sql`UPDATE bank_transactions SET linked_asset_id = ${a}::UUID, linked_fleet_fuel_id = ${f}::UUID
      WHERE id = ${bt}::UUID`.then(() => null, (e: unknown) => e) as { code?: string } | null;
    expect(two?.code).toBe('23514');
    const oa = await newAsset(o);
    const cross = await sql`UPDATE bank_transactions SET linked_asset_id = ${oa}::UUID
      WHERE id = ${bt}::UUID`.then(() => null, (e: unknown) => e) as { code?: string } | null;
    expect(cross?.code).toBe('23503');
    const crossFuel = await sql`INSERT INTO fleet_fuel_transactions (company_id, asset_id, fill_date, litres, amount)
      VALUES (${c.fx.companyId}::UUID, ${oa}::UUID, '2026-06-01', 10, 100)`.then(() => null, (e: unknown) => e) as { code?: string } | null;
    expect(crossFuel?.code).toBe('23503');
  }, 60000);

  it('the bank transaction list and the asset bank-links read return the link with its label', async () => {
    const own = await newBank(c);
    const a = await newAsset(c, 'Isuzu D-Max');
    const f = await newFuel(c, a, 850, '2026-10-01');
    const s = await newService(c, a, 'Brake pads');
    const [l1, l2, l3, l4] = [await seedLine(c, own, 901), await seedLine(c, own, 902), await seedLine(c, own, 903), await seedLine(c, own, 904)];
    expect((await asset(l1!, a)).status).toBe(200);
    expect((await fleet(l2!, 'fuel', f)).status).toBe(200);
    expect((await fleet(l3!, 'service', s)).status).toBe(200);

    const list = await callAs(c, token, bankTransactions as Route, 'GET', {}, { bankAccountId: own, limit: '50' });
    expect(list.status, list.body).toBe(200);
    const byId = new Map((list.data as { transactions: Row[] }).transactions.map((t) => [String(t.id), t]));
    const assetName = String(((await sql`SELECT name FROM assets WHERE id = ${a}::UUID`) as Row[])[0]!.name);
    expect(byId.get(l1!)!.link).toEqual({ kind: 'asset', id: a, assetId: a, assetName, label: assetName });
    expect(byId.get(l2!)!.link).toEqual({ kind: 'fuel', id: f, assetId: a, assetName, label: 'Fuel 2026-10-01 R850.00' });
    expect(byId.get(l3!)!.link).toEqual({ kind: 'service', id: s, assetId: a, assetName, label: 'Brake pads' });
    expect(byId.get(l4!)!.link).toBeUndefined();

    const links = await callAs(c, token, assetBankLinks as Route, 'GET', {}, { assetId: a });
    expect(links.status, links.body).toBe(200);
    expect((links.data as Row[]).map((r) => [r.id, r.kind]).sort()).toEqual([[l1, 'asset'], [l2, 'fuel'], [l3, 'service']].sort());

    const foreign = await callAs(c, token, assetBankLinks as Route, 'GET', {}, { assetId: await newAsset(o) });
    const missing = await callAs(c, token, assetBankLinks as Route, 'GET', {}, { assetId: newId() });
    expect([foreign.status, messageOf(foreign)]).toEqual([404, messageOf(missing)]);
    expect(missing.status).toBe(404);
  }, 60000);
});
