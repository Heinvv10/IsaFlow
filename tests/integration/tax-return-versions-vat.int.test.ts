/**
 * VAT201 finalise through the real route (wave 5 L1a). A 4xx commits the request's writes under
 * withAuth, so each refusal is proved by counting rows AFTER the response: no lock, no override
 * row, no version. The exceptions gate is the same one POST /vat-period-locks runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { seedInvoice } from './helpers/l1FifoFixture';
import {
  callRoute, count, dropReturnFixture, loginAsToken, seedReturnFixture, type ReturnFixture,
} from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

const CLEAN = { periodStart: '2026-01-01', periodEnd: '2026-02-28' };
const DIRTY = { periodStart: '2026-05-01', periodEnd: '2026-06-30' };
let rf: ReturnFixture;
let other: ReturnFixture;
const c = () => rf.fx.companyId;
const post = (token: string, body: Record<string, unknown>) =>
  callRoute(finalise, c(), token, 'POST', { form: 'vat201' }, body);
const list = (companyId: string, token: string, p: typeof CLEAN) =>
  callRoute(versions, companyId, token, 'GET', { form: 'vat201', ...p });
const none = async () => {
  expect(await count('tax_return_versions', c())).toBe(0);
  expect(await count('vat_period_locks', c())).toBe(0);
  expect(await count('vat_gate_overrides', c())).toBe(0);
};

describeIfDb('VAT201 finalise, against a real ledger', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds a company, an invoice, locks and return versions.');
    rf = await seedReturnFixture('RVV', DATABASE_URL!);
    other = await seedReturnFixture('RVV2', DATABASE_URL!);
    // An unposted invoice in DIRTY: a blocking VAT exception for that period only.
    const inv = await seedInvoice(rf.fx, { number: 'INV-RVV', date: '2026-05-05', total: 1150, status: 'sent' });
    await sql`UPDATE customer_invoices SET subtotal = 1000, tax_rate = 15, tax_amount = 150, total_amount = 1150
      WHERE id = ${inv}::UUID AND company_id = ${c()}::UUID`;
  }, 240000);

  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
    if (other) await dropReturnFixture(other);
  }, 120000);

  it('blocking exceptions without an override: 400, no lock, no override row, no version', async () => {
    const r = await post(rf.admin.token, DIRTY);
    expect(r.status).toBe(400);
    await none();
  });

  it('an override by a manager: 403, nothing written', async () => {
    const r = await post(rf.manager.token, { ...DIRTY, overrideReason: 'I checked it' });
    expect(r.status).toBe(403);
    await none();
  });

  it('a viewer cannot finalise: 403, nothing written', async () => {
    expect((await post(rf.viewer.token, CLEAN)).status).toBe(403);
    await none();
  });

  it('Login-as is refused: 403, nothing written', async () => {
    const r = await post(await loginAsToken(rf), CLEAN);
    expect(r.status).toBe(403);
    await none();
  });

  it('a lock that already exists (not made by this finalise): 409 and the override row rolls back with it', async () => {
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${c()}::UUID, ${DIRTY.periodStart}::DATE, ${DIRTY.periodEnd}::DATE, 0, 0, 0, now(), ${rf.admin.userId})`;
    const r = await post(rf.admin.token, { ...DIRTY, overrideReason: 'Filed by hand' });
    expect(r.status).toBe(409);
    expect(await count('tax_return_versions', c())).toBe(0);
    expect(await count('vat_gate_overrides', c())).toBe(0);
    expect(await count('vat_period_locks', c())).toBe(1); // the pre-existing one, untouched
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${c()}::UUID`;
  });

  it('a clean period: 200, version 1 carries the lock row figures and names the lock', async () => {
    const r = await post(rf.admin.token, CLEAN);
    expect(r.status).toBe(200);
    const v = (r.body as { data: { version: Row } }).data.version;
    expect(v.versionNo).toBe(1);
    expect(v.status).toBe('finalised');
    const lock = ((await sql`SELECT * FROM vat_period_locks WHERE company_id = ${c()}::UUID`) as Row[])[0]!;
    expect(v.vatPeriodLockId).toBe(lock.id);
    expect(v.figures).toMatchObject({
      outputTax: Number(lock.output_tax), inputTax: Number(lock.input_tax), netVat: Number(lock.net_vat),
    });
    expect(new Date(String(v.postedThrough)).getTime()).toBe(new Date(lock.posted_through as string).getTime());
    expect(lock.locked_by).toBe(rf.admin.userId);
  });

  it('finalising again: 409, still one lock and one version', async () => {
    expect((await post(rf.admin.token, CLEAN)).status).toBe(409);
    expect(await count('tax_return_versions', c())).toBe(1);
    expect(await count('vat_period_locks', c())).toBe(1);
  });

  it('an owner/admin override with a reason finalises the exceptions period and records the override', async () => {
    const r = await post(rf.admin.token, { ...DIRTY, overrideReason: 'Declared on the manual return' });
    expect(r.status).toBe(200);
    expect(await count('vat_gate_overrides', c())).toBe(1);
    expect(await count('vat_period_locks', c())).toBe(2);
    expect(await count('tax_return_versions', c())).toBe(2);
  });

  it('lists versions with no drift while the ledger is unchanged', async () => {
    const r = await list(c(), rf.admin.token, CLEAN);
    const data = (r.body as { data: { versions: Row[] } }).data;
    expect(r.status).toBe(200);
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]).toMatchObject({ lockRemoved: false, drift: { drifted: false, fields: [] } });
  });

  it('a version whose lock was unlocked outside the lifecycle is reported as such, beside the vat_returns record', async () => {
    await sql`UPDATE vat_period_locks SET unlocked_at = now(), unlocked_by = ${rf.admin.userId}, unlock_reason = 'direct'
      WHERE company_id = ${c()}::UUID AND period_start = ${CLEAN.periodStart}::DATE`;
    await sql`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
      VALUES (${c()}::UUID, ${CLEAN.periodStart}::DATE, ${CLEAN.periodEnd}::DATE, 100, 0, 100)`;
    const r = await list(c(), rf.admin.token, CLEAN);
    const data = (r.body as { data: { versions: Row[]; vatReturn: Row } }).data;
    expect(data.versions[0]!.lockRemoved).toBe(true);
    expect(data.vatReturn).toMatchObject({ status: 'submitted', netVat: 100, mismatch: true });
  });

  it('another company sees no versions of this one, and finalising there writes only there', async () => {
    const seen = await list(other.fx.companyId, other.admin.token, CLEAN);
    expect((seen.body as { data: { versions: Row[] } }).data.versions).toEqual([]);
    const own = await callRoute(finalise, other.fx.companyId, other.admin.token, 'POST', { form: 'vat201' }, CLEAN);
    expect(own.status).toBe(200);
    expect(await count('tax_return_versions', c())).toBe(2);
    expect(await count('tax_return_versions', other.fx.companyId)).toBe(1);
  });
});
