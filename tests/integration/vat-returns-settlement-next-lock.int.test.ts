/**
 * Wave 6 VR, coordinator ruling: the VAT settlement's clearing journal (dated the day after the period it settles) is
 * exempt from the NEXT period's VAT lock, exactly:
 *   - only its own source ('auto_vat_submission', written by submitVATReturn);
 *   - only on the first day of that lock (periodEnd + 1), with the period it settles finalised;
 * so a period can be settled after the next one is finalised, without amending the next one, and the next period's
 * VAT201 and version are unchanged by it. A manual journal on that same day into the next period is still refused.
 * (Demo Jul-Aug 2026 could not settle while Sep-Oct was finalised; this is that shape on a fixture company.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import versions from '../../pages/api/accounting/sars/returns/[form]/versions';
import vatReturns from '../../pages/api/accounting/vat-returns/index';
import journalEntries from '../../pages/api/accounting/journal-entries';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type P = { periodStart: string; periodEnd: string };

const SETTLED = { periodStart: '2025-08-01', periodEnd: '2025-09-30' };
const NEXT = { periodStart: '2025-10-01', periodEnd: '2025-11-30' };

let rf: ReturnFixture;
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const acct = async (codeNo: string) => String((await one(sql`SELECT id FROM gl_accounts
  WHERE company_id = ${rf.fx.companyId}::UUID AND account_code = ${codeNo}`)).id);
const finaliseP = (p: P) => callRoute(finalise, rf.fx.companyId, rf.admin.token, 'POST', { form: 'vat201' },
  { ...p, force: true, overrideReason: 'VR fixture' });
const view = async (p: P) => ((await callRoute(versions, rf.fx.companyId, rf.admin.token, 'GET',
  { form: 'vat201', ...p })).body as { data: { versions: Row[] } }).data.versions;
const live = async (p: P) => (await view(p)).find((v) => v.status !== 'superseded')!;

/** A posted sale of `net` + 15 % VAT inside the period, written straight to the ledger. */
async function sale(date: string, net: number): Promise<void> {
  const c = rf.fx.companyId;
  const je = String((await one(sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c}::UUID, ${date}::DATE, 'VR sale', 'posted', ${rf.fx.userId}::UUID) RETURNING id`)).id);
  for (const [codeNo, debit, credit] of [['1100', net * 1.15, 0], ['2120', 0, net * 0.15], ['6000', 0, net]] as const) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${c}::UUID, ${je}::UUID, ${await acct(codeNo)}::UUID, ${debit}, ${credit})`;
  }
}

describeIfDb('VR: the settlement clearing journal is exempt from the next period\'s VAT lock, and nothing else is', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, journals, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VRN', DATABASE_URL!);
    await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${rf.fx.companyId}::UUID`;
  }, 240000);

  afterAll(async () => { if (rf) await dropReturnFixture(rf); }, 120000);

  it('settles a period while the next one is finalised (not amended); the next VAT201 and version are unchanged', async () => {
    const c = rf.fx.companyId;
    await sale('2025-08-15', 10000);
    await sale('2025-10-15', 4000);
    expect((await finaliseP(SETTLED)).status).toBe(200);
    expect((await finaliseP(NEXT)).status).toBe(200);
    const nextBefore = await live(NEXT);
    expect(nextBefore.figures).toMatchObject({ outputTax: 600, inputTax: 0, netVat: 600 });
    const report = async () => {
      const r = await getVat201Report(c, NEXT.periodStart, NEXT.periodEnd, { detail: 'summary' });
      return { totals: r.totals, boxes: r.boxes };
    };
    const reportBefore = await report();

    const r = await callRoute(vatReturns, c, rf.admin.token, 'POST', {}, SETTLED);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const je = await one(sql`SELECT entry_date::TEXT AS d, status, source FROM gl_journal_entries
      WHERE id = ${String((r.body as { data: Row }).data.journalEntryId)}::UUID`);
    expect(je).toEqual({ d: '2025-10-01', status: 'posted', source: 'auto_vat_submission' });

    const nextAfter = await live(NEXT);
    expect(nextAfter.id).toBe(nextBefore.id); // not amended
    expect(nextAfter.status).toBe('finalised');
    expect(await report()).toEqual(reportBefore); // the next VAT201, every total and box, is unchanged
    expect(nextAfter.drift).toEqual(nextBefore.drift); // and so is its drift (no figure moved)
    expect((nextAfter.drift as { fields: unknown[] }).fields).toEqual([]);
    expect(Number((await one(sql`SELECT COUNT(*) AS n FROM vat_period_locks WHERE company_id = ${c}::UUID
      AND period_start = '2025-10-01'::DATE AND unlocked_at IS NULL`)).n)).toBe(1); // its lock still active
  });

  it('a manual journal on the same day into the locked next period is still refused, and writes nothing', async () => {
    const c = rf.fx.companyId;
    const before = Number((await one(sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${c}::UUID`)).n);
    const r = await callRoute(journalEntries, c, rf.admin.token, 'POST', {}, {
      entryDate: '2025-10-01', description: 'VR: manual VAT journal into a locked period',
      lines: [
        { glAccountId: await acct('1100'), debit: 115, credit: 0 },
        { glAccountId: await acct('2120'), debit: 0, credit: 15 },
        { glAccountId: await acct('6000'), debit: 0, credit: 100 },
      ],
    });
    expect(r.status).not.toBe(200);
    expect(JSON.stringify(r.body)).toMatch(/locked because its VAT201 has been filed/);
    expect(Number((await one(sql`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE company_id = ${c}::UUID`)).n))
      .toBe(before);
  });
});
