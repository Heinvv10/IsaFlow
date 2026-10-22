/** Breaker round 1 on PR A, ported: reversal-of-reversal revival, re-paying after a reversal, taxable income, issued-date range. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import directiveRoute from '../../pages/api/accounting/tax-directives/[id]';
import directives from '../../pages/api/accounting/tax-directives';
import jeAction from '../../pages/api/accounting/journal-entries-action';
import type { Route } from './w3-01-payroll.helpers';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getIrp5EmployeeTotals } from '@/modules/accounting/services/payroll/irp5DataService';
import {
  applyStandalone, approvedDirective, cleanSeveranceFixtures, directivePayments, seedRetrenchedEmployee, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];
const patch = (f: SeveranceFixture, id: string, body: Record<string, unknown>) =>
  f.call(directiveRoute as Route, 'PATCH', `/api/accounting/tax-directives/${id}`, id, { body });
const reverseJournal = (f: SeveranceFixture, id: string) =>
  f.call(jeAction as Route, 'POST', '/api/accounting/journal-entries-action', undefined, { body: { id, action: 'reverse' } });
const reversalOf = async (id: string) =>
  String((await pool.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [id])).rows[0]!.id);

beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); } });

describe('BRK-A', () => {
  it('R1: reversing the reversal of a directive payment is refused, so no payment stands on the cancelled directive', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'Brk revival'); fixtures.push(f);
    const d = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(200);
    const j = String((await directivePayments(pool, d))[0]!.journal_entry_id);
    expect((await reverseJournal(f, j)).statusCode).toBe(200);
    expect((await patch(f, d, { status: 'cancelled' })).statusCode).toBe(200);
    const rr = await reverseJournal(f, await reversalOf(j));
    expect(rr.statusCode).not.toBe(200);
    expect(JSON.stringify(rr.body)).toMatch(/apply it again/);
    const st = String((await pool.query('SELECT status FROM tax_directives WHERE id=$1', [d])).rows[0]!.status);
    const e = await generateEMP201(f.company, '2026-09-01', '2026-09-30');
    expect(!(st === 'cancelled' && e.directivePayments.length === 1), 'cancelled directive declared on EMP201').toBe(true);
  });

  it('R2: after the payment journal is reversed the directive can be paid again, and is declared once', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'Brk deadend'); fixtures.push(f);
    const d = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(200);
    const j = String((await directivePayments(pool, d))[0]!.journal_entry_id);
    expect((await applyStandalone(f, d, '2026-09-16')).statusCode).toBe(409); // still paid: refused
    expect((await reverseJournal(f, j)).statusCode).toBe(200);
    const again = await applyStandalone(f, d, '2026-09-20');
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect((await directivePayments(pool, d))).toHaveLength(1);
    const e = await generateEMP201(f.company, '2026-09-01', '2026-09-30');
    expect(e.directivePayments.map(p => p.paymentDate)).toEqual(['2026-09-20']);
    expect(e.totalPAYE).toBe(10_000);
    // The first payment's row is gone; reviving its journal is still refused (by its narrative).
    expect((await reverseJournal(f, await reversalOf(j))).statusCode).not.toBe(200);
    expect((await generateEMP201(f.company, '2026-09-01', '2026-09-30')).totalPAYE).toBe(10_000);
  });

  it('R3: an employee paid only outside payroll: taxableIncome carries the payment, as grossSalary does', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'Brk taxable'); fixtures.push(f);
    const d = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    expect((await applyStandalone(f, d, '2026-09-15')).statusCode).toBe(200);
    const t = await getIrp5EmployeeTotals(f.company, 2027);
    const row = t.rows.find(r => r.employeeId === f.employee)!;
    expect(row.taxableIncome).toBeGreaterThanOrEqual(row.grossSalary - 0.01);
  });

  it('R4: an issued_date before 2000 or in the future is refused', async () => {
    const f = await seedRetrenchedEmployee(pool, '2026-09-30', 'Brk dates'); fixtures.push(f);
    const d = await approvedDirective(f, 50_000, 0.2, '2026-09-01');
    const a = await patch(f, d, { issued_date: '0001-01-01' });
    const b = await patch(f, d, { issued_date: '9999-12-31' });
    expect(a.statusCode).toBe(400);
    expect(b.statusCode).toBe(400);
  });
});
