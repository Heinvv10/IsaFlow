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

// The fixture company files bi-monthly, periods ending in odd months (Category A).
const CLEAN = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const DIRTY = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const MISMATCH = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };
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

  it('a period that is not one of the company\'s VAT periods: 400, nothing written', async () => {
    const before = await count('tax_return_versions', c());
    for (const p of [
      { periodStart: '2026-01-01', periodEnd: '2026-02-28' }, // ends in an even month
      { periodStart: '2026-03-01', periodEnd: '2026-03-31' }, // one month on a bi-monthly cycle
      { periodStart: '2026-02-02', periodEnd: '2026-03-31' }, // not the 1st
      { periodStart: '2026-02-01', periodEnd: '2026-03-30' }, // not a month end
    ]) expect((await post(rf.admin.token, p)).status).toBe(400);
    expect(await count('tax_return_versions', c())).toBe(before);
  });

  it('an impossible date (Feb 31) is a 400, never a 500, on both routes', async () => {
    const bad = { periodStart: '2026-02-01', periodEnd: '2026-02-31' };
    expect((await post(rf.admin.token, bad)).status).toBe(400);
    expect((await callRoute(versions, c(), rf.admin.token, 'GET', { form: 'vat201', ...bad })).status).toBe(400);
    const wide = { periodStart: '2020-01-01', periodEnd: '2026-12-31' };
    expect((await callRoute(versions, c(), rf.admin.token, 'GET', { form: 'vat201', ...wide })).status).toBe(400);
  });

  it('a submitted vat_returns row with other figures: 409 until acknowledged with a reason, which is kept on the version', async () => {
    await sql`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
      VALUES (${c()}::UUID, ${MISMATCH.periodStart}::DATE, ${MISMATCH.periodEnd}::DATE, 100, 0, 100)`;
    const before = await count('vat_period_locks', c());
    expect((await post(rf.admin.token, MISMATCH)).status).toBe(409);
    expect(await count('vat_period_locks', c())).toBe(before);
    expect((await post(rf.admin.token, { ...MISMATCH, acknowledgeVatReturnMismatch: true })).status).toBe(422); // no reason
    const r = await post(rf.admin.token, { ...MISMATCH, acknowledgeVatReturnMismatch: true, mismatchReason: 'Old record was a test' });
    expect(r.status).toBe(200);
    const d = (r.body as { data: { version: Row; vatReturn: Row } }).data;
    expect(d.vatReturn).toMatchObject({ status: 'submitted', mismatch: true });
    expect(d.version.figures).toMatchObject({ meta: { vatReturnMismatch: { reason: 'Old record was a test' } } });
  });

  it('concurrent finalise of one period: one lock, one version, the loser told it was just finalised', async () => {
    const p = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };
    const [a, b] = await Promise.all([post(rf.admin.token, p), post(rf.manager.token, p)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(JSON.stringify(loser.body)).toMatch(/already|just/);
    const rows = (await sql`SELECT COUNT(*)::INT AS n FROM tax_return_versions WHERE company_id = ${c()}::UUID
      AND period_start = ${p.periodStart}::DATE`) as Row[];
    expect(rows[0]!.n).toBe(1);
    const locks = (await sql`SELECT COUNT(*)::INT AS n FROM vat_period_locks WHERE company_id = ${c()}::UUID
      AND period_start = ${p.periodStart}::DATE`) as Row[];
    expect(locks[0]!.n).toBe(1);
  });

  it('drift is positive when the ledger moves after the return was finalised (output tax and the boxes)', async () => {
    const P = { periodStart: '2025-12-01', periodEnd: '2026-01-31' };
    expect((await post(rf.admin.token, P)).status).toBe(200);
    expect((await list(c(), rf.admin.token, P).then((r) => (r.body as { data: { versions: { drift: { drifted: boolean } }[] } }).data.versions[0]!.drift.drifted))).toBe(false);
    // A posted VAT sale dated inside the period, written straight to the ledger as a late back-dated posting would be.
    const acct = async (code: string) => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${c()}::UUID AND account_code = ${code}`) as Row[])[0]!.id);
    const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
      VALUES (${c()}::UUID, '2026-01-15', 'late sale', 'posted', ${rf.fx.userId}::UUID) RETURNING id`) as Row[])[0]!.id);
    for (const [code, debit, credit] of [['1100', 115, 0], ['2120', 0, 15], ['6000', 0, 100]] as const) {
      await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
        VALUES (${c()}::UUID, ${je}::UUID, ${await acct(code)}::UUID, ${debit}, ${credit})`;
    }
    const r = await list(c(), rf.admin.token, P);
    const v = (r.body as { data: { versions: { drift: { drifted: boolean; fields: { name: string; current: number }[]; changed: string[] } }[] } }).data.versions[0]!;
    expect(v.drift.drifted).toBe(true);
    expect(v.drift.fields.find((f) => f.name === 'outputTax')?.current).toBe(15);
    expect(v.drift.changed).toEqual(['sarsFields']);
  });

  it('dead end after an out-of-lifecycle unlock (pinned, L1b amend owns the way out): finalising again is 409, and so is an overlapping period', async () => {
    await sql`UPDATE vat_period_locks SET unlocked_at = now(), unlocked_by = ${rf.admin.userId}, unlock_reason = 'direct'
      WHERE company_id = ${c()}::UUID AND period_start = ${CLEAN.periodStart}::DATE AND unlocked_at IS NULL`;
    const locks = await count('vat_period_locks', c());
    expect((await post(rf.admin.token, CLEAN)).status).toBe(409);
    await sql`UPDATE companies SET vat_period = 'monthly' WHERE id = ${c()}::UUID`;
    const overlap = await post(rf.admin.token, { periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    await sql`UPDATE companies SET vat_period = 'bi-monthly' WHERE id = ${c()}::UUID`;
    expect(overlap.status).toBe(409);
    expect(JSON.stringify(overlap.body)).toMatch(/overlaps/);
    expect(await count('vat_period_locks', c())).toBe(locks);
  });

  it('another company sees no versions of this one, and finalising there writes only there', async () => {
    const seen = await list(other.fx.companyId, other.admin.token, CLEAN);
    expect((seen.body as { data: { versions: Row[] } }).data.versions).toEqual([]);
    const mine = await count('tax_return_versions', c());
    const own = await callRoute(finalise, other.fx.companyId, other.admin.token, 'POST', { form: 'vat201' }, CLEAN);
    expect(own.status).toBe(200);
    expect(await count('tax_return_versions', c())).toBe(mine);
    expect(await count('tax_return_versions', other.fx.companyId)).toBe(1);
  });
});
