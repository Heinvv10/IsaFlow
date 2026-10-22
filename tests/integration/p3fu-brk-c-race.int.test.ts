/** Breaker round 3 on PR A, ported: apply, calculate/approve and cancel racing the release of a reversed payment never pay twice or leave a cancelled directive paid. */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import directiveRoute from '../../pages/api/accounting/tax-directives/[id]';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import type { Route } from './w3-01-payroll.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import {
  applyStandalone, approvedDirective, approveRun, calculatedSeverance, calculateRun, cleanSeveranceFixtures, createRunFor,
  directivePayments, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const fixtures: SeveranceFixture[] = [];
afterAll(async () => { try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); } });
const rev = (f: SeveranceFixture, id: string) =>
  f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id, action: 'reverse' } });
const patch = (f: SeveranceFixture, id: string, body: Record<string, unknown>) =>
  f.call(directiveRoute as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body });

async function setup(name: string) {
  const f = await seedRetrenchedEmployee(pool, '2026-09-30', name); fixtures.push(f);
  const d = await approvedDirective(f, calculatedSeverance('2026-09-30'), 0.1, '2026-09-01');
  expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(200);
  const j = String((await directivePayments(pool, d))[0]!.journal_entry_id);
  expect((await rev(f, j)).statusCode).toBe(200);
  const sept = await createRunFor(f, 9);
  return { f, d, sept };
}

describe('BRK-A r3', () => {
  for (let i = 0; i < 4; i += 1) {
    it(`G2.${i}: concurrent apply + calculate/approve after a reversal never pays twice`, async () => {
      const { f, d, sept } = await setup(`Brk3 race ${i}`);
      const [a, run] = await Promise.all([
        applyStandalone(f, d, '2026-09-20'),
        (async () => { const c = await calculateRun(f, sept); const ap = await approveRun(f, sept); return [c.statusCode, ap.statusCode]; })(),
      ]);
      const rows = await directivePayments(pool, d);
      const e = await generateEMP201(f.company, '2026-09-01', '2026-09-30');
      const line = (await pool.query(
        // Only a declarable run pays: an approval refused leaves a calculated run, whose line pays nothing.
        `SELECT count(*)::int n FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id,
           jsonb_array_elements(l.component_breakdown) i
         WHERE l.run_id=$1 AND h.status IN ('approved', 'paid') AND i->'directive' IS NOT NULL`, [sept])).rows[0].n;
      const paidTwice = rows.length >= 1 && e.directivePayments.length + line > 1;
      expect(paidTwice, 'severance paid by standalone AND by the run').toBe(false);
    });
  }
  it('G2 forced: calculate (releases the reversed payment), then apply, then approve: the approval is refused, paid once', async () => {
    const { f, d, sept } = await setup('Brk3 forced order');
    await calculateRun(f, sept);
    expect((await applyStandalone(f, d, '2026-09-20')).statusCode).toBe(200);
    const ap = await approveRun(f, sept);
    expect(ap.statusCode).toBe(400);
    expect(JSON.stringify(ap.body)).toMatch(/already paid outside payroll/);
    expect((await directivePayments(pool, d)).map(r => r.payroll_run_id)).toEqual([null]);
    expect((await generateEMP201(f.company, '2026-09-01', '2026-09-30')).directivePayments).toHaveLength(1);
  });

  it('G3: cancel racing the release leaves no cancelled directive with a standing payment', async () => {
    const { f, d, sept } = await setup('Brk3 cancel');
    await Promise.all([calculateRun(f, sept), patch(f, d, { status: 'cancelled' })]);
    const rows = await directivePayments(pool, d);
    const st = String((await pool.query('SELECT status FROM tax_directives WHERE id=$1', [d])).rows[0]!.status);
    const e = await generateEMP201(f.company, '2026-09-01', '2026-09-30');
    expect(st === 'cancelled' && (rows.length > 0 && e.directivePayments.length > 0)).toBe(false);
  });
});
