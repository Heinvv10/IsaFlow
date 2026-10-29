/**
 * Budgets P3 tenancy, on real PostgreSQL: company B's version id, cost-centre
 * ids and business-unit id, passed in company A's request, are a 404 that
 * names no B figure, both as the owner role (the app layer's own company_id
 * scoping, with RLS bypassed) and as app_user under forced RLS (as withAuth
 * runs a request). A's report as app_user carries none of B's ledger or
 * budget. Seed: helpers/budgetTrackingFixture.ts.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { asRequest, dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';
import { buildBudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/budgetTrackingService';
import type { TrackingParams } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
const NOW = new Date('2026-11-15T10:00:00+02:00');
const FY: TrackingParams = { period: 'fy', fiscalYear: 2027 };

beforeAll(async () => { f = await seedTrackingFixture(pool); }, 120_000);
afterAll(async () => {
  try { await dropTrackingFixture(pool, f); } finally { await pool.end(); }
});

const run = (p: TrackingParams, appUser: boolean) =>
  asRequest(pool, f.a, f.userA, () => buildBudgetTrackingReport(f.a, p, NOW), { appUser });

/** The refusal's status and the whole of what it says. */
async function refusal(p: Promise<unknown>): Promise<{ status: unknown; text: string }> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal').not.toBeNull();
  const e = err as { status?: unknown; message?: string };
  return { status: e.status, text: JSON.stringify({ message: e.message, ...(err as object) }) };
}

for (const appUser of [false, true]) {
  describe(appUser ? 'as app_user under forced RLS' : 'as the owner role (RLS bypassed)', () => {
    const cases: Array<[string, () => TrackingParams]> = [
      ["B's version id", () => ({ ...FY, versionId: f.v.b27 })],
      ["B's cost centre as cc1_id", () => ({ ...FY, cc1Id: f.cc.BX })],
      ["B's cost centre as cc2_id", () => ({ ...FY, cc2Id: f.cc.BX })],
      ["B's business unit", () => ({ ...FY, buId: f.bu.BBX })],
    ];
    for (const [name, params] of cases) {
      it(`${name} is a 404 that names nothing of B's`, async () => {
        const { status, text } = await refusal(run(params(), appUser));
        expect(status).toBe(404);
        expect(text).not.toMatch(/SECRET|12345|55555/);
      });
    }

    it("A's own report carries none of B's ledger or budget", async () => {
      const r = await run(FY, appUser);
      const body = JSON.stringify(r);
      expect(body).not.toMatch(/SECRET/);
      expect(body).not.toContain(f.acc.bSales);
      expect(r.lines.some((l) => l.budget === 12345 * 14)).toBe(false);
      const sales = r.lines.find((l) => l.accountId === f.acc.sales)!;
      expect(sales.budget).toBe(150 * 14);
      expect(r.version?.id).toBe(f.v.primary27);
    });
  });
}

it("an explicit level given A's own centre of the other kind is a 400 (review Q3)", async () => {
  for (const params of [{ ...FY, cc1Id: f.cc.P1 }, { ...FY, cc2Id: f.cc.FT }]) {
    const { status, text } = await refusal(run(params, true));
    expect(status, JSON.stringify(params)).toBe(400);
    expect(text).toMatch(/must name a CC[12] cost centre/);
  }
});

it("the owner role and app_user see the same figures for A (RLS hides nothing of A's own)", async () => {
  const [owner, app] = [await run(FY, false), await run(FY, true)];
  expect(app.lines).toEqual(owner.lines);
  expect(app.bands).toEqual(owner.bands);
  expect(owner.lines.length).toBeGreaterThan(3);
});
