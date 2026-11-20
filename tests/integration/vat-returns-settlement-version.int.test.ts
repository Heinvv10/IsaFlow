/**
 * Wave 6 VR (§0a.12): the return lifecycle is the record of a VAT201, vat_returns the settlement record.
 *
 * Against a real ledger, two tenants:
 *   - POST /api/accounting/vat-returns for a period with no finalised version is 409 and writes nothing (withAuth
 *     commits a 4xx, so the rows are counted after the response);
 *   - with a version, the settlement row names it (return_version_id), and the composite FK refuses another tenant's;
 *   - every filed-record reader (docs/sars/vat-returns-readers.md) answers for three periods: BOTH (a version and its
 *     settlement), LIFECYCLE (a finalised version only) and LEGACY (a vat_returns row from before the lifecycle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import { vatPeriodFilings } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { getVatMultiYearSummary, getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';
import { vatReviewedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck';
import { buildVatCard } from '@/modules/accounting/services/workbench/monthEndLedgerCards';
import { vatDueSignal } from '@/modules/bureau/services/bureauVatSignal';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;

// The fixture company files bi-monthly, periods ending in odd months.
const BOTH = { periodStart: '2026-02-01', periodEnd: '2026-03-31' };
const LIFECYCLE = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const LEGACY = { periodStart: '2026-06-01', periodEnd: '2026-07-31' };
const NONE = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };

let rf: ReturnFixture;
let other: ReturnFixture;
const settle = (f: ReturnFixture, p: typeof BOTH) => callRoute(vatReturns, f.fx.companyId, f.admin.token, 'POST', {}, p);
const finaliseP = (f: ReturnFixture, p: typeof BOTH) => callRoute(finalise, f.fx.companyId, f.admin.token, 'POST',
  { form: 'vat201' }, { ...p, force: true, overrideReason: 'VR integration fixture' });
const n = async (q: Promise<unknown>) => Number(((await q) as Row[])[0]!.n);
const rowsOf = (c: string) => ({
  vatReturns: n(sql`SELECT COUNT(*)::INT AS n FROM vat_returns WHERE company_id = ${c}::UUID`),
  journals: n(sql`SELECT COUNT(*)::INT AS n FROM gl_journal_entries WHERE company_id = ${c}::UUID`),
});

/** A posted sale of 10 000 + 1 500 VAT dated inside the period, written straight to the ledger. */
async function sale(f: ReturnFixture, date: string): Promise<void> {
  const c = f.fx.companyId;
  const acct = async (code: string) => String(((await sql`SELECT id FROM gl_accounts
    WHERE company_id = ${c}::UUID AND account_code = ${code}`) as Row[])[0]!.id);
  const je = String(((await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c}::UUID, ${date}::DATE, 'VR sale', 'posted', ${f.fx.userId}::UUID) RETURNING id`) as Row[])[0]!.id);
  for (const [code, debit, credit] of [['1100', 11500, 0], ['2120', 0, 1500], ['6000', 0, 10000]] as const) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${c}::UUID, ${je}::UUID, ${await acct(code)}::UUID, ${debit}, ${credit})`;
  }
}

describeIfDb('VR: vat_returns unified with the return lifecycle, against a real ledger', () => {
  let bothVersionId = '';

  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VRU', DATABASE_URL!);
    other = await seedReturnFixture('VRU2', DATABASE_URL!);
    for (const f of [rf, other]) {
      await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd'
        WHERE id = ${f.fx.companyId}::UUID`;
    }
    await sale(rf, '2026-02-15');
    await sale(other, '2026-02-20');
  }, 240000);

  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
    if (other) await dropReturnFixture(other);
  }, 120000);

  it('settling a period with no finalised VAT201: 409 VAT201_NOT_FINALISED, no row, no journal', async () => {
    const c = rf.fx.companyId;
    const before = rowsOf(c);
    const [vr0, je0] = [await before.vatReturns, await before.journals];
    const r = await settle(rf, BOTH);
    expect(r.status).toBe(409);
    expect((r.body as { error: { details?: { code?: string } } }).error.details?.code).toBe('VAT201_NOT_FINALISED');
    const after = rowsOf(c);
    expect([await after.vatReturns, await after.journals]).toEqual([vr0, je0]);
  });

  it('after finalising: the settlement posts and names the version it settled', async () => {
    const f = await finaliseP(rf, BOTH);
    expect(f.status).toBe(200);
    bothVersionId = String(((f.body as { data: { version: Row } }).data.version).id);
    const r = await settle(rf, BOTH);
    expect(r.status).toBe(200);
    expect((r.body as { data: Row }).data).toMatchObject({ returnVersionId: bothVersionId, totalOutputTax: 1500 });
    const row = ((await sql`SELECT return_version_id, journal_entry_id FROM vat_returns
      WHERE company_id = ${rf.fx.companyId}::UUID AND period_start = ${BOTH.periodStart}::DATE`) as Row[])[0]!;
    expect(row.return_version_id).toBe(bothVersionId);
    expect(row.journal_entry_id).not.toBeNull();
  });

  it('two tenants: each links its own version, and the FK refuses another tenant\'s', async () => {
    expect((await finaliseP(other, BOTH)).status).toBe(200);
    expect((await settle(other, BOTH)).status).toBe(200);
    const theirs = String(((await sql`SELECT return_version_id FROM vat_returns
      WHERE company_id = ${other.fx.companyId}::UUID`) as Row[])[0]!.return_version_id);
    expect(theirs).not.toBe(bothVersionId);
    await expect(sql`UPDATE vat_returns SET return_version_id = ${theirs}::UUID
      WHERE company_id = ${rf.fx.companyId}::UUID AND period_start = ${BOTH.periodStart}::DATE`)
      .rejects.toMatchObject({ code: '23503' });
  });

  it('seeds the other two periods: a finalised version only, and a legacy row only', async () => {
    expect((await finaliseP(rf, LIFECYCLE)).status).toBe(200);
    // Old colour: an insert that names no return_version_id (NULL) is accepted.
    await sql`INSERT INTO vat_returns (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat)
      VALUES (${rf.fx.companyId}::UUID, ${LEGACY.periodStart}::DATE, ${LEGACY.periodEnd}::DATE, 1000, 0, 1000)`;
  });

  it('vatPeriodFilings: one filing per period, the version first, the legacy row only where no version is', async () => {
    const all = await vatPeriodFilings([rf.fx.companyId], { from: '2026-01-01', to: '2026-12-31' });
    expect(all.map((f) => [f.periodStart, f.source, f.status, f.submitted, f.netVat])).toEqual([
      [BOTH.periodStart, 'lifecycle', 'finalised', true, 1500],
      [LIFECYCLE.periodStart, 'lifecycle', 'finalised', false, 0],
      [LEGACY.periodStart, 'legacy', 'submitted', true, 1000],
    ]);
    expect(all[0]!.settlement).toMatchObject({ returnVersionId: bothVersionId });
    expect(all.every((f) => f.companyId === rf.fx.companyId)).toBe(true);
  });

  it('VAT reconciliation: each month\'s return figures and status from its filing', async () => {
    const recon = await getVatReconciliation(rf.fx.companyId, '2026-02-01', '2026-09-30');
    const byMonth = Object.fromEntries(recon.months.map((m) => [m.month, [m.returnStatus, m.returnOutputVat, m.returnNetVat]]));
    expect(byMonth).toMatchObject({
      '2026-02': ['finalised', 1500, 1500], '2026-04': ['finalised', 0, 0], '2026-06': ['submitted', 1000, 1000],
    });
    expect(recon.months.find((m) => m.month === '2026-02')!.outputVatVariance).toBe(0);
    const summary = await getVatMultiYearSummary(rf.fx.companyId, 3);
    expect(summary.find((y) => y.year === 2026)?.returnsSubmitted).toBe(2); // BOTH (settled) + LEGACY
  });

  it('period-close "VAT reviewed": pass for a lifecycle-only and a legacy-only period, warn for none', async () => {
    const check = (startDate: string, endDate: string) => vatReviewedCheck(rf.fx.companyId, { startDate, endDate });
    expect((await check('2026-04-01', '2026-04-30')).status).toBe('pass');
    expect((await check('2026-07-01', '2026-07-31')).status).toBe('pass');
    expect((await check('2026-09-01', '2026-09-30')).status).toBe('warn');
    expect((await vatReviewedCheck(other.fx.companyId, { startDate: '2026-06-01', endDate: '2026-06-30' })).status).toBe('warn');
  });

  it('month-end VAT card: ready when submitted or settled, in progress when only finalised', async () => {
    const card = (p: typeof BOTH) => buildVatCard(rf.fx.companyId, p.periodStart, p.periodEnd);
    expect(await card(BOTH)).toMatchObject({ status: 'ready', secondary: 'finalised' });
    expect(await card(LIFECYCLE)).toMatchObject({ status: 'in_progress', secondary: 'finalised' });
    expect(await card(LEGACY)).toMatchObject({ status: 'ready', secondary: 'submitted' });
    expect(await card(NONE)).toMatchObject({ status: 'not_started' });
  });

  it('bureau "VAT return due": covered by a settled or legacy period, due for a finalised-only one', async () => {
    const meta = new Map([rf, other].map((f) => [f.fx.companyId,
      { bureau_id: 'b', bureau_name: 'B', company_id: f.fx.companyId, company_name: f.fx.tag }]));
    const due = async (today: string) => (await vatDueSignal([rf.fx.companyId, other.fx.companyId], meta,
      new Date(`${today}T08:00:00Z`))).map((w) => [w.companyId === rf.fx.companyId ? 'rf' : 'other', w.detail]).sort();
    expect(await due('2026-04-10')).toEqual([]); // Feb-Mar: both companies settled
    expect(await due('2026-06-10')).toEqual([['other', 'Apr–May 2026'], ['rf', 'Apr–May 2026']]);
    expect(await due('2026-08-10')).toEqual([['other', 'Jun–Jul 2026']]); // rf: the legacy row covers it
  });
});
