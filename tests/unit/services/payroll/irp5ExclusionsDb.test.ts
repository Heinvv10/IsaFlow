/**
 * The IRP5 completeness identity, against a real payroll.
 *
 * `universeTotal` was `mapped.length + excluded.length`, where `excluded` held
 * ONE AGGREGATE ROW standing for every non-declarable run in the year. That
 * satisfies buildEnvelope's arithmetic and still misreports the universe: on
 * isaflow_dev the 2031 tax year has a single `calculated` run carrying TEN
 * employees, and the report claimed a universe of 1.
 *
 * The contract's premise is that `rowsTotal + excludedTotal === universeTotal`
 * counts THE SAME KIND OF THING on both sides. `rows` are employees, so the
 * exclusions must be employees too — a run count would make the arithmetic
 * pass while adding employees to runs.
 *
 * DB-gated: skips (never fails) when no DB is reachable.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';

type AlsCtx = Parameters<typeof als.run>[0];
function alsCtx(client: unknown, companyId: string): AlsCtx {
  return { client, userId: 'probe', companyId, claims: {} } as unknown as AlsCtx;
}

/**
 * A company and tax year whose runs in the window are ALL non-declarable, plus
 * the number of distinct employees those runs carry. That is the shape the old
 * aggregate row collapsed, so the fixture must keep a non-declarable run with
 * MORE THAN ONE employee on it or the bug is invisible.
 */
async function findAllNonDeclarableYear(): Promise<
  { companyId: string; taxYear: number; employees: number } | null
> {
  const rows = (await sql`
    SELECT prh.company_id,
           -- SA tax year ending: Jan/Feb belong to the year named, Mar..Dec to the next.
           CASE WHEN prh.period_month <= 2 THEN prh.period_year ELSE prh.period_year + 1 END AS tax_year,
           COUNT(DISTINCT prl.employee_id)::INT AS employees,
           COUNT(*) FILTER (WHERE prh.status = ANY(ARRAY['approved','paid']))::INT AS declarable
    FROM payroll_run_headers prh
    JOIN payroll_run_lines prl ON prl.run_id = prh.id
    GROUP BY 1, 2
    HAVING COUNT(*) FILTER (WHERE prh.status = ANY(ARRAY['approved','paid'])) = 0
       AND COUNT(DISTINCT prl.employee_id) > 1
    ORDER BY 3 DESC
    LIMIT 1
  `) as Array<{ company_id: string; tax_year: number; employees: number }>;
  const r = rows[0];
  return r
    ? { companyId: String(r.company_id), taxYear: Number(r.tax_year), employees: Number(r.employees) }
    : null;
}

async function inReadTx(run: (client: unknown) => Promise<void>): Promise<void> {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(alsCtx(client, 'bootstrap'), () => run(client));
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('irp5_data completeness identity', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('counts EMPLOYEES on both sides of the identity, not runs', async () => {
    await inReadTx(async (client) => {
      const fixture = await findAllNonDeclarableYear();
      if (!fixture) return; // no such year on this DB — nothing to assert
      await als.run(alsCtx(client, fixture.companyId), async () => {
        const ds = await getIrp5EmployeeTotals(fixture.companyId, fixture.taxYear, false);

        // Every run in the window is non-declarable, so no certificate rows.
        expect(ds.rows).toHaveLength(0);
        expect(ds.rowsTotal).toBe(0);

        // The universe is the employees the report had to classify — the ten on
        // that run — not the one aggregate row that used to stand for them.
        expect(ds.universeTotal).toBe(fixture.employees);
        expect(ds.excludedTotal).toBe(fixture.employees);
        expect(ds.rowsTotal + ds.excludedTotal).toBe(ds.universeTotal);

        // And the excluded rows are employees, addressable one by one.
        expect(ds.excluded.length).toBeGreaterThan(1);
        expect(ds.excluded.every(e => e.reason === 'run_not_declarable')).toBe(true);
        expect(new Set(ds.excluded.map(e => e.id)).size).toBe(ds.excluded.length);
      });
    });
  });

  // An employee with BOTH a declarable and a non-declarable run in the year is
  // already a certificate row. Counting them on the excluded side too would
  // double-count them into the universe — which is what dropping the NOT EXISTS
  // does, and no fixture on this DB has the mixed case naturally.
  it.skipIf(!reachable)('never counts an employee who also has a declarable run', async () => {
    await inReadTx(async (client) => {
      const fixture = await findAllNonDeclarableYear();
      if (!fixture) return;
      await als.run(alsCtx(client, fixture.companyId), async () => {
        // Promote the year's only run to `approved`, then add a second,
        // non-declarable run over the SAME employees. Every one of them now has
        // both, so none of them may be excluded.
        const runs = (await sql`
          SELECT prh.id, prh.period_year, prh.period_month
          FROM payroll_run_headers prh
          WHERE prh.company_id = ${fixture.companyId}::uuid
          ORDER BY prh.period_year DESC, prh.period_month DESC
          LIMIT 1
        `) as Array<{ id: string; period_year: number; period_month: number }>;
        const run = runs[0]!;
        await sql`UPDATE payroll_run_headers SET status = 'approved' WHERE id = ${String(run.id)}::uuid`;

        // One run per (company, year, month), so the shadow run needs a
        // different month. Months 1 and 2 both belong to the tax year NAMED by
        // period_year, so either keeps the shadow inside the same window.
        const shadowMonth = run.period_month === 1 ? 2 : 1;
        const created = (await sql`
          INSERT INTO payroll_run_headers (company_id, period_month, period_year, status)
          VALUES (${fixture.companyId}::uuid, ${shadowMonth}, ${run.period_year}, ${'calculated'})
          RETURNING id
        `) as Array<{ id: string }>;
        const shadowId = String(created[0]!.id);
        await sql`
          INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, taxable_income, paye, uif_employee, uif_employer, sdl, eti, net_pay)
          SELECT ${shadowId}::uuid, prl.employee_id, 1000, 1000, 0, 0, 0, 0, 0, 1000
          FROM payroll_run_lines prl WHERE prl.run_id = ${String(run.id)}::uuid
        `;

        const ds = await getIrp5EmployeeTotals(fixture.companyId, fixture.taxYear, false);
        expect(ds.rowsTotal).toBe(fixture.employees);
        expect(ds.excludedTotal).toBe(0);
        expect(ds.excluded).toHaveLength(0);
        expect(ds.universeTotal).toBe(fixture.employees);
      });
    });
  });
});
