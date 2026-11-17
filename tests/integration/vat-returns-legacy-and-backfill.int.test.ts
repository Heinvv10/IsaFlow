/**
 * Wave 6 VR, review round 1 (rev-1555 ledger breaker), on a real ledger:
 *
 *   M1  999g's backfill never claims a legacy settlement was posted against a version finalised after it;
 *   M2  a legacy settlement stays a filing unless a LIVE version has exactly its period: one that only overlaps it
 *       (a VAT category change) does not hide it, nor does a version that was superseded and not finalised again;
 *   L1  a settlement can name only a version of its own period (the FK is on company, id and period).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { callRoute, dropReturnFixture, seedReturnFixture, type ReturnFixture } from './helpers/returnVersionsFixture';
import finalise from '../../pages/api/accounting/sars/returns/[form]/finalise';
import amend from '../../pages/api/accounting/sars/returns/[form]/amend';
import { vatPeriodFilings } from '@/modules/accounting/services/returns/vatPeriodFilings';
import { vatReviewedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck';
import { getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type P = { periodStart: string; periodEnd: string };

const BACKFILL = { periodStart: '2026-04-01', periodEnd: '2026-05-31' };
const SUPERSEDED = { periodStart: '2026-08-01', periodEnd: '2026-09-30' };

let rf: ReturnFixture;
let other: ReturnFixture;
const finaliseP = (f: ReturnFixture, p: P) => callRoute(finalise, f.fx.companyId, f.admin.token, 'POST',
  { form: 'vat201' }, { ...p, force: true, overrideReason: 'VR fixture', acknowledgeVatReturnMismatch: true, mismatchReason: 'legacy row' });
const amendV = (f: ReturnFixture, versionId: string) => callRoute(amend, f.fx.companyId, f.admin.token, 'POST',
  { form: 'vat201' }, { versionId, reason: 'VR: amend' });
const versionId = (r: { body: unknown }) => String(((r.body as { data: { version: Row } }).data.version).id);
const legacy = (c: string, p: P, net: number, ago = '0 days') => sql`INSERT INTO vat_returns
  (company_id, period_start, period_end, total_output_tax, total_input_tax, net_vat, submitted_at)
  VALUES (${c}::UUID, ${p.periodStart}::DATE, ${p.periodEnd}::DATE, ${net}, 0, ${net}, now() - ${ago}::INTERVAL)`;

describeIfDb('VR review round 1: legacy settlements and the 999g backfill', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test seeds companies, VAT locks, return versions and settlements.');
    rf = await seedReturnFixture('VRL', DATABASE_URL!);
    other = await seedReturnFixture('VRL2', DATABASE_URL!);
    for (const f of [rf, other]) {
      await sql`UPDATE companies SET vat_period = 'bi-monthly', vat_period_alignment = 'odd' WHERE id = ${f.fx.companyId}::UUID`;
    }
  }, 240000);

  afterAll(async () => {
    if (rf) await dropReturnFixture(rf);
    if (other) await dropReturnFixture(other);
  }, 120000);

  it('M1 (repro B): the backfill leaves NULL a settlement made before every version of its period', async () => {
    const c = rf.fx.companyId;
    await legacy(c, BACKFILL, 0, '40 days');
    const v1 = versionId(await finaliseP(rf, BACKFILL));
    expect((await amendV(rf, v1)).status).toBe(200);
    expect((await finaliseP(rf, BACKFILL)).status).toBe(200);
    // The migration's UPDATE, exactly as written in the file.
    const file = readFileSync('scripts/migrations/sql/999g_vat_returns_return_version.sql', 'utf8');
    const update = file.slice(file.indexOf('UPDATE vat_returns vr'), file.indexOf('ALTER TABLE vat_returns VALIDATE'));
    const pool = new Pool({ connectionString: DATABASE_URL });
    try { await pool.query(update); } finally { await pool.end(); }
    const row = ((await sql`SELECT return_version_id FROM vat_returns
      WHERE company_id = ${c}::UUID AND period_start = ${BACKFILL.periodStart}::DATE`) as Row[])[0]!;
    expect(row.return_version_id).toBeNull();
  });

  it('M1: the backfill does link a settlement made while its version was already the live one', async () => {
    const c = other.fx.companyId;
    const v = versionId(await finaliseP(other, BACKFILL));
    await legacy(c, BACKFILL, 0); // settled now, after the version was finalised
    const file = readFileSync('scripts/migrations/sql/999g_vat_returns_return_version.sql', 'utf8');
    const update = file.slice(file.indexOf('UPDATE vat_returns vr'), file.indexOf('ALTER TABLE vat_returns VALIDATE'));
    const pool = new Pool({ connectionString: DATABASE_URL });
    try { await pool.query(update); } finally { await pool.end(); }
    const row = ((await sql`SELECT return_version_id FROM vat_returns
      WHERE company_id = ${c}::UUID AND period_start = ${BACKFILL.periodStart}::DATE`) as Row[])[0]!;
    expect(row.return_version_id).toBe(v);
  });

  it('M2: a legacy settlement whose only version was superseded (not finalised again) is still a filing', async () => {
    const c = rf.fx.companyId;
    await legacy(c, SUPERSEDED, 500);
    expect((await amendV(rf, versionId(await finaliseP(rf, SUPERSEDED)))).status).toBe(200);
    const f = (await vatPeriodFilings([c], { from: SUPERSEDED.periodStart, to: SUPERSEDED.periodEnd }))
      .filter((x) => x.periodStart === SUPERSEDED.periodStart);
    expect(f.map((x) => [x.source, x.netVat, x.submitted])).toEqual([['legacy', 500, true]]);
  });

  it('M2 (repro C): a monthly version overlapping a bi-monthly legacy settlement does not hide it', async () => {
    const c = other.fx.companyId;
    await legacy(c, { periodStart: '2026-06-01', periodEnd: '2026-07-31' }, 1000);
    await sql`UPDATE companies SET vat_period = 'monthly' WHERE id = ${c}::UUID`;
    expect((await finaliseP(other, { periodStart: '2026-07-01', periodEnd: '2026-07-31' })).status).toBe(200);
    expect((await vatReviewedCheck(c, { startDate: '2026-06-01', endDate: '2026-06-30' })).status).toBe('pass');
    const filings = await vatPeriodFilings([c], { from: '2026-06-01', to: '2026-07-31' });
    expect(filings.map((x) => [x.periodStart, x.periodEnd, x.source, x.settlement?.netVat ?? null])).toEqual([
      ['2026-06-01', '2026-07-31', 'legacy', 1000], ['2026-07-01', '2026-07-31', 'lifecycle', null],
    ]);
    const recon = await getVatReconciliation(c, '2026-06-01', '2026-07-31');
    expect(recon.months.find((m) => m.month === '2026-06')?.returnNetVat).toBe(1000);
  });

  it('L1: a settlement cannot name a version of another period of its own company (FK on the period too)', async () => {
    const c = other.fx.companyId;
    const v = String(((await sql`SELECT id FROM tax_return_versions WHERE company_id = ${c}::UUID
      AND period_start = ${BACKFILL.periodStart}::DATE AND status <> 'superseded'`) as Row[])[0]!.id);
    await expect(sql`UPDATE vat_returns SET return_version_id = ${v}::UUID
      WHERE company_id = ${c}::UUID AND period_start = '2026-06-01'::DATE`).rejects.toMatchObject({ code: '23503' });
  });
});
