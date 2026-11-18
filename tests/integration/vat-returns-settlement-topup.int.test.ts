/**
 * Wave 6 VR, review round 1 (rev-1555 ledger breaker): what a VAT settlement is posted against, on a real ledger.
 *
 *   H1  a settlement belongs to the version it names: after an amend, the new version is NOT submitted until it is
 *       filed or settled, and settling it posts only the difference (a top-up linked to it); the VAT control accounts
 *       then clear.
 *   M3  a ledger that has drifted from the version (a back-dated post into the locked period) is refused, 409.
 *   L2  a version whose VAT lock was released outside the lifecycle is refused, 409.
 *   L3  a settlement whose period only overlaps an earlier settlement's (VAT category change) is refused, 409.
 * Every refusal is counted after the response: no vat_returns row and no journal (withAuth commits a 4xx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import {
  callRoute, dropReturnFixture, releaseLockDirectly, seedReturnFixture, type ReturnFixture,
} from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import { vatPeriodFilings } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { buildVatCard } from '@/modules/accounting/services/workbench/monthEndLedgerCards';
import { vatDueSignal } from '@/modules/bureau/services/bureauVatSignal';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type P = { periodStart: string; periodEnd: string };

const TOPUP = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const DRIFT = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const LOCK = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };

let rf: ReturnFixture;
let other: ReturnFixture;
const settle = (f: ReturnFixture, p: P) => callRoute(vatReturns, f.fx.companyId, f.admin.token, 'POST', {}, p);
const finaliseP = (f: ReturnFixture, p: P, extra: Record<string, unknown> = {}) => callRoute(finalise, f.fx.companyId,
  f.admin.token, 'POST', { form: 'vat201' }, { ...p, force: true, overrideReason: 'VR fixture', ...extra });
const amendV = (f: ReturnFixture, versionId: string) => callRoute(amend, f.fx.companyId, f.admin.token, 'POST',
  { form: 'vat201' }, { versionId, reason: 'VR: a sale was missed' });
const versionOf = (r: { body: unknown }) => (r.body as { data: { version: Row } }).data.version;
const code = (r: { body: unknown }) => (r.body as { error?: { details?: { code?: string } } }).error?.details?.code;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const counts = async (c: string) => one(sql`SELECT
  (SELECT COUNT(*)::INT FROM vat_returns WHERE company_id = ${c}::UUID) AS settlements,
  (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${c}::UUID) AS journals`);

/** A posted sale of `net` + 15 % VAT, dated inside the period, written straight to the ledger. */
async function sale(f: ReturnFixture, date: string, net: number): Promise<void> {
  const c = f.fx.companyId;
  const acct = async (codeNo: string) => String((await one(sql`SELECT id FROM gl_accounts
    WHERE company_id = ${c}::UUID AND account_code = ${codeNo}`)).id);
  const je = String((await one(sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c}::UUID, ${date}::DATE, 'VR sale', 'posted', ${f.fx.userId}::UUID) RETURNING id`)).id);
  for (const [codeNo, debit, credit] of [['1100', net * 1.15, 0], ['2120', 0, net * 0.15], ['6000', 0, net]] as const) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${c}::UUID, ${je}::UUID, ${await acct(codeNo)}::UUID, ${debit}, ${credit})`;
  }
}

/** Balance movement on a control account across every posted journal of the company (credit - debit). */
const control = async (c: string, codeNo: string) => Number((await one(sql`
  SELECT COALESCE(SUM(l.credit - l.debit), 0) AS b FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
   WHERE l.company_id = ${c}::UUID AND e.status = 'posted' AND a.account_code = ${codeNo}`)).b);

describeIfDb('VR review round 1: settlement against its own version, top-up, drift, lock, overlap', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VRT', DATABASE_URL!);
    other = await seedReturnFixture('VRT2', DATABASE_URL!);
    for (const f of [rf, other]) {
      await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${f.fx.companyId}::UUID`;
    }
  }, 240000);

  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
    if (other) await dropReturnFixture(other);
  }, 120000);

  it('H1: an amended version is not submitted by its predecessor\'s settlement; its top-up posts only the difference', async () => {
    const c = rf.fx.companyId;
    await sale(rf, '2026-02-15', 10000);
    const v1 = versionOf(await finaliseP(rf, TOPUP));
    expect((await settle(rf, TOPUP)).status).toBe(200);
    expect((await amendV(rf, String(v1.id))).status).toBe(200);
    await sale(rf, '2026-02-20', 10000); // the correction the amend was for
    const f2 = await finaliseP(rf, TOPUP, { acknowledgeVatReturnMismatch: true, mismatchReason: 'v1 settled; v2 corrects' });
    expect(f2.status).toBe(200);
    const v2 = versionOf(f2);

    // Repro A: before the top-up, v2 is finalised and unsettled, so nothing calls it submitted.
    const before = (await vatPeriodFilings([c], { from: TOPUP.periodStart, to: TOPUP.periodEnd }))[0]!;
    expect(before).toMatchObject({ versionId: v2.id, netVat: 3000, submitted: false });
    expect(before.settlement).toMatchObject({ netVat: 1500, returnVersionId: v1.id, linkedToVersion: false });
    expect((await buildVatCard(c, TOPUP.periodStart, TOPUP.periodEnd)).status).toBe('in_progress');
    const meta = new Map([[c, { bureau_id: 'b', bureau_name: 'B', company_id: c, company_name: 'x' }]]);
    expect((await vatDueSignal([c], meta, new Date('2026-04-10T08:00:00Z'))).map((d) => d.detail)).toEqual(['Feb–Mar 2026']);

    const top = await settle(rf, TOPUP);
    expect(top.status).toBe(200);
    expect((top.body as { data: Row }).data).toMatchObject({
      returnVersionId: v2.id, totalOutputTax: 1500, totalInputTax: 0, netVat: 1500,
    });
    const after = (await vatPeriodFilings([c], { from: TOPUP.periodStart, to: TOPUP.periodEnd }))[0]!;
    expect(after).toMatchObject({ submitted: true });
    expect(after.settlement).toMatchObject({ netVat: 3000, count: 2, returnVersionId: v2.id, linkedToVersion: true });
    expect(await control(c, '2120')).toBe(0); // output VAT 3000 raised, 1500 + 1500 cleared
    expect(await control(c, '1140')).toBe(0);
    const again = await settle(rf, TOPUP);
    expect(again.status).toBe(409);
    expect(code(again)).toBe('VAT_ALREADY_SETTLED');
    expect(JSON.stringify(again.body)).toContain('already been submitted against version 2');
  });

  it('M3: a ledger that moved after finalising (back-dated post into the locked period) is 409, nothing written', async () => {
    const c = rf.fx.companyId;
    await sale(rf, '2026-04-10', 10000);
    expect((await finaliseP(rf, DRIFT)).status).toBe(200);
    await sale(rf, '2026-05-10', 1000); // straight to the ledger, past the lock
    const before = await counts(c);
    const r = await settle(rf, DRIFT);
    expect(r.status).toBe(409);
    expect(code(r)).toBe('VAT_SETTLEMENT_DRIFT');
    expect(await counts(c)).toEqual(before);
  });

  it('L2: a version whose lock was released outside the lifecycle is 409, nothing written', async () => {
    const c = rf.fx.companyId;
    const v = versionOf(await finaliseP(rf, LOCK));
    await releaseLockDirectly(rf.fx.pool, String(v.vatPeriodLockId), rf.admin.userId);
    const before = await counts(c);
    const r = await settle(rf, LOCK);
    expect(r.status).toBe(409);
    expect(code(r)).toBe('VAT201_LOCK_RELEASED');
    expect(await counts(c)).toEqual(before);
  });

  it('L3: a period that only overlaps an earlier settlement (VAT category change) is 409, nothing written', async () => {
    const c = other.fx.companyId;
    await sql`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
      VALUES (${c}::UUID, '2026-06-01'::DATE, '2026-07-31'::DATE, 1000, 0, 1000)`;
    await sql`UPDATE companies SET vat_period = 'monthly' WHERE id = ${c}::UUID`;
    const july = { periodStart: '2026-07-01', periodEnd: '2026-07-31' };
    expect((await finaliseP(other, july)).status).toBe(200);
    const before = await counts(c);
    const r = await settle(other, july);
    expect(r.status).toBe(409);
    expect(code(r)).toBe('VAT_SETTLEMENT_PERIOD_OVERLAP');
    expect(await counts(c)).toEqual(before);
  });
});
