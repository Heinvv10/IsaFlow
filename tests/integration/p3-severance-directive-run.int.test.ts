/**
 * Audit 2026-10-18 P3: severance (3901) is paid in the pay run at the figures
 * on its SARS directive, once.
 *
 * SARS PAYE-GEN-01-G21 (2027) Rev 1, "Lump sums by employers – severance
 * benefits" (p. 22): paragraph 9(3) of the Fourth Schedule requires a directive
 * before the lump sum is paid, and the employer may not deviate from it (p. 15).
 * So: no directive → the run leaves severance out and says so; the first run
 * after the directive is approved pays it alone; the run that pays it claims
 * the directive at approval, after which neither another run nor the
 * stand-alone directive payment can pay it again. Real routes (withAuth,
 * app_user, RLS); disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { updateTaxDirectiveStatus } from '@/modules/accounting/services/payroll/taxDirectiveService';
import {
  applyStandalone, approvedDirective, approveRun, calculatedSeverance, calculateRun, cleanSeveranceFixtures, codes,
  createRunFor, directivePayments, previewRun, reopenRun, runLine, seedRetrenchedEmployee, SALARY_PAYE, type SeveranceFixture,
} from './p3-severance.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fixtures: SeveranceFixture[] = [];

beforeAll(async () => {
  fixtures.push(await seedRetrenchedEmployee(pool, '2026-04-30', 'P3 no directive yet'));
  fixtures.push(await seedRetrenchedEmployee(pool, '2026-07-31', 'P3 directive in the final run'));
  fixtures.push(await seedRetrenchedEmployee(pool, '2026-08-31', 'P3 paid outside payroll'));
  fixtures.push(await seedRetrenchedEmployee(pool, '2026-10-31', 'P3 directive cancelled'));
});

afterAll(async () => {
  try { await cleanSeveranceFixtures(pool, fixtures); } finally { await pool.end(); }
});

describe('P3: final run before the directive, then the directive', () => {
  it('pays salary only, warns, then pays the severance alone in the next run, once', async () => {
    const f = fixtures[0]!;
    const april = await createRunFor(f, 4);
    await calculateRun(f, april);
    const final = await runLine(pool, april, f.employee);
    expect(final.gross).toBe(20_000);
    expect(final.paye).toBe(SALARY_PAYE);
    const awaiting = (final.validation_results as Array<{ code: string; message: string }>)
      .find(v => v.code === 'SEVERANCE_AWAITING_DIRECTIVE');
    expect(awaiting?.message).toContain('W301-1');
    expect(awaiting?.message).toContain(calculatedSeverance('2026-04-30').toFixed(2));
    expect((await approveRun(f, april)).statusCode).toBe(200);

    // The directive differs from the calculated severance: its figures are paid.
    const directive = await approvedDirective(f, 30_000, 0.1, '2026-05-05');
    const may = await createRunFor(f, 5);
    await calculateRun(f, may);
    await calculateRun(f, may);
    expect(await directivePayments(pool, directive)).toEqual([]); // a draft consumes nothing
    const sev = await runLine(pool, may, f.employee);
    expect(sev).toMatchObject({ gross: 30_000, paye: 3_000, net: 27_000, uif_employee: 0, uif_employer: 0, sdl: 0 });
    expect((sev.component_breakdown as Array<{ sarsSourceCode: string }>).map(c => c.sarsSourceCode)).toEqual(['3901']);
    expect(codes(sev.validation_results)).toContain('SEVERANCE_DIRECTIVE_MISMATCH');

    expect((await approveRun(f, may)).statusCode).toBe(200);
    expect(await directivePayments(pool, directive)).toEqual([
      { payroll_run_id: may, gross: 30_000, paye: 3_000, net: 27_000, journal_entry_id: null },
    ]);
    // Severance gross is labour cost, its PAYE a liability, through the run's own journal.
    const journal = (await pool.query(
      `SELECT a.account_code, l.debit::float8 AS debit, l.credit::float8 AS credit
         FROM payroll_run_headers h JOIN gl_journal_lines l ON l.journal_entry_id = h.journal_entry_id
         JOIN gl_accounts a ON a.id = l.gl_account_id WHERE h.id = $1 AND a.account_code IN ('5200','2140')`, [may])).rows;
    expect(journal).toEqual(expect.arrayContaining([
      { account_code: '5200', debit: 30_000, credit: 0 }, { account_code: '2140', debit: 0, credit: 3_000 },
    ]));

    const refused = await applyStandalone(f, directive);
    expect(refused.statusCode).toBe(409);
    expect(await directivePayments(pool, directive)).toHaveLength(1);

    const june = await createRunFor(f, 6);
    await calculateRun(f, june);
    expect(await runLine(pool, june, f.employee)).toBeUndefined();
  });
});

describe('P3: the directive is approved before the final run', () => {
  it('the final run pays it at the directive figures, keeps the claim through a reopen, and the stand-alone path refuses', async () => {
    const f = fixtures[1]!;
    const severance = calculatedSeverance('2026-07-31');
    const directive = await approvedDirective(f, severance, 0.1, '2026-07-01');
    const july = await createRunFor(f, 7);
    await calculateRun(f, july);
    const l = await runLine(pool, july, f.employee);
    const tax = Math.round(severance * 10) / 100;
    expect(l.gross).toBeCloseTo(20_000 + severance, 2);
    expect(l.paye).toBeCloseTo(SALARY_PAYE + tax, 2);
    expect(codes(l.validation_results)).not.toContain('SEVERANCE_DIRECTIVE_MISMATCH');
    expect(codes(l.validation_results)).not.toContain('SEVERANCE_AWAITING_DIRECTIVE');
    expect(await directivePayments(pool, directive)).toEqual([]);

    expect((await approveRun(f, july)).statusCode).toBe(200);
    expect((await applyStandalone(f, directive)).statusCode).toBe(409);

    expect((await reopenRun(f, july)).statusCode).toBe(200);
    expect(await directivePayments(pool, directive)).toHaveLength(1); // the reopened run keeps its claim
    expect((await applyStandalone(f, directive)).statusCode).toBe(409);
    const august = await createRunFor(f, 8);
    await calculateRun(f, august);
    expect(await runLine(pool, august, f.employee)).toBeUndefined(); // no other run is offered it

    expect((await approveRun(f, july)).statusCode).toBe(200);
    const paid = await directivePayments(pool, directive);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payroll_run_id).toBe(july);
  });
});

describe('P3: the directive is paid outside payroll', () => {
  it('a draft that carried it is refused at approval, and recalculating leaves it out', async () => {
    const f = fixtures[2]!;
    const directive = await approvedDirective(f, 25_000, 0.2, '2026-08-01');
    const aug = await createRunFor(f, 8);
    await calculateRun(f, aug);
    expect((await runLine(pool, aug, f.employee)).gross).toBe(45_000);

    expect((await applyStandalone(f, directive)).statusCode).toBe(200);
    const refused = await approveRun(f, aug);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/directive/i);

    await calculateRun(f, aug);
    const l = await runLine(pool, aug, f.employee);
    expect(l.gross).toBe(20_000);
    expect(codes(l.validation_results)).toContain('SEVERANCE_PAID_BY_DIRECTIVE');
    expect(codes(l.validation_results)).not.toContain('SEVERANCE_AWAITING_DIRECTIVE');
    expect((await approveRun(f, aug)).statusCode).toBe(200);
    const paid = await directivePayments(pool, directive);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payroll_run_id).toBeNull();
  });
});

describe('P3: the directive changes after the run is calculated', () => {
  it('approval is refused and writes nothing; recalculating leaves the severance out and says why', async () => {
    const f = fixtures[3]!;
    const directive = await approvedDirective(f, 25_000, 0.2, '2026-10-01');
    const oct = await createRunFor(f, 10);
    await calculateRun(f, oct);
    expect((await runLine(pool, oct, f.employee)).gross).toBe(45_000);
    await updateTaxDirectiveStatus(f.company, directive, 'cancelled', f.admin);
    // The confirmation a person reads before approving names it too.
    expect((await previewRun(f, oct)).body.data?.blocker?.code).toBe('severance_directive_unavailable');
    const refused = await approveRun(f, oct);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error?.message).toMatch(/no longer approved/);
    expect(await directivePayments(pool, directive)).toEqual([]);
    expect((await pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [oct])).rows[0]!.status).toBe('calculated');

    await calculateRun(f, oct);
    const l = await runLine(pool, oct, f.employee);
    expect(l.gross).toBe(20_000);
    expect(codes(l.validation_results)).toContain('SEVERANCE_AWAITING_DIRECTIVE');
  });
});
