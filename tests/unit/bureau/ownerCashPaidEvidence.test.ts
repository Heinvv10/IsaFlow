// Wave 7 OCP (W34, W36): the owner cash position reads PAID EVIDENCE first (a run marked paid, either Mark paid path,
// else a confirmed salary bank file) and keeps the payday inference only for a run with neither, labelled.
import { describe, expect, it } from 'vitest';
import { pickPayrollRun, shapePayrollAffordability, type PayrollRunRow } from '@/modules/bureau/services/ownerCashPositionService';

const run = (over: Partial<PayrollRunRow> = {}): PayrollRunRow => ({
  id: 'run', period_month: 6, period_year: 2026, status: 'approved',
  total_net: '10000', total_paye: '2000', total_uif: '200', total_sdl: '100', total_eti: '0', final: true,
  ...over,
});
const STATUTORY = 2300;

describe('a paid run is shown as paid, not estimated (grill F2, :102)', () => {
  it('shapePayrollAffordability labels status paid as paid', () => {
    expect(shapePayrollAffordability(run({ status: 'paid' }), 0)!.status).toBe('paid');
    expect(shapePayrollAffordability(run({ status: 'approved' }), 0)!.status).toBe('approved');
    expect(shapePayrollAffordability(run({ status: 'calculated' }), 0)!.status).toBe('estimated');
  });
  it('a paid run that owes statutory amounts reports status paid, its basis and its payment date', () => {
    const paid = run({ status: 'paid', pay_date: '2026-06-25', paid_on: '2026-06-24' });
    expect(pickPayrollRun([paid], 1000, '2026-06-28')).toMatchObject({
      status: 'paid', paidBasis: 'recorded', paidOn: '2026-06-24', totalRequired: STATUTORY, canPay: false, shortfall: 1300,
    });
  });
});

describe('evidence, in order: marked paid, confirmed bank file, then the labelled inference', () => {
  it('typed-reference paid run, pay date still ahead: net pay has left, only statutory is owed', () => {
    const paid = run({ status: 'paid', pay_date: '2026-06-30', paid_on: '2026-06-20' });
    expect(pickPayrollRun([paid], 0, '2026-06-21')).toMatchObject({ paidBasis: 'recorded', totalRequired: STATUTORY });
  });
  it('legacy paid row with no payment date (the Demo reseed) is still paid, basis recorded', () => {
    const paid = run({ status: 'paid', pay_date: '2026-06-25', paid_on: null });
    expect(pickPayrollRun([paid], 0, '2026-06-28')).toMatchObject({ paidBasis: 'recorded', paidOn: null, totalRequired: STATUTORY });
  });
  it('two-run month: the paid regular run owes statutory only, the approved bonus due later owes all of it', () => {
    const regular = run({ id: 'regular', status: 'paid', pay_date: '2026-06-25', paid_on: '2026-06-25' });
    const bonus = run({ id: 'bonus', total_net: '5000', total_paye: '700', total_uif: '0', total_sdl: '0', pay_date: '2026-06-30' });
    const got = pickPayrollRun([regular, bonus], 10_000, '2026-06-28');
    expect(got).toMatchObject({ runId: 'bonus', runsCounted: 2, totalRequired: STATUTORY + 5700, canPay: true });
    expect(got!.paidBasis).toBeUndefined();
    // Ten times the amounts: the paid run's R23 000 statutory alone is short of R10 000 cash, so it is the one reported.
    const big = (x: PayrollRunRow): PayrollRunRow => ({ ...x, total_net: String(Number(x.total_net) * 10), total_paye: String(Number(x.total_paye) * 10),
      total_uif: String(Number(x.total_uif) * 10), total_sdl: String(Number(x.total_sdl) * 10) });
    expect(pickPayrollRun([big(regular), big(bonus)], 10_000, '2026-06-28')).toMatchObject({ runId: 'regular', totalRequired: STATUTORY * 10, canPay: false, shortfall: 13_000 });
  });
  // #1679 L1: a regular run reopened after payday. The bank file the bank accepted is the evidence; no approval-overlap needed.
  it('L1: reopened after payday with a confirmed bank file: paid on the file\'s action date, basis bank_file', () => {
    const reopened = run({ status: 'calculated', final: false, pay_date: '2026-06-25', bank_paid_on: '2026-06-25' });
    expect(pickPayrollRun([reopened], 0, '2026-06-28')).toMatchObject({ paidBasis: 'bank_file', paidOn: '2026-06-25', totalRequired: STATUTORY });
  });
  it('L1: the same reopened run with no file and no approval over payday still needs its net pay', () => {
    const reopened = run({ status: 'calculated', final: false, pay_date: '2026-06-25', disbursed: false });
    const got = pickPayrollRun([reopened], 0, '2026-06-28');
    expect(got).toMatchObject({ totalRequired: STATUTORY + 10_000 });
    expect(got!.paidBasis).toBeUndefined();
  });
  // #1679 L2: an off-cycle run approved and reopened on payday.
  it('L2: off-cycle approved and reopened on payday, no evidence: the inference holds, labelled inferred', () => {
    const bonus = run({ id: 'bonus', status: 'calculated', final: false, pay_date: '2026-06-20', disbursed: true, total_gross: '12000', paid_gross: '12000' });
    expect(pickPayrollRun([bonus], 0, '2026-06-21')).toMatchObject({ paidBasis: 'inferred', paidOn: '2026-06-20', totalRequired: STATUTORY });
  });
  it('L2: the same run with a confirmed file is bank_file, never inferred', () => {
    const bonus = run({ id: 'bonus', status: 'calculated', final: false, pay_date: '2026-06-20', disbursed: true, bank_paid_on: '2026-06-20', total_gross: '12000', paid_gross: '12000' });
    expect(pickPayrollRun([bonus], 0, '2026-06-21')).toMatchObject({ paidBasis: 'bank_file', paidOn: '2026-06-20' });
  });
  it('a final run past its pay date with no evidence is inferred, and says so', () => {
    expect(pickPayrollRun([run({ pay_date: '2026-06-25' })], 0, '2026-06-28')).toMatchObject({ paidBasis: 'inferred', paidOn: '2026-06-25' });
  });
  it('evidence order: marked paid beats a bank file beats the inference', () => {
    const all = run({ status: 'paid', pay_date: '2026-06-25', paid_on: '2026-06-24', bank_paid_on: '2026-06-25', disbursed: true });
    expect(pickPayrollRun([all], 0, '2026-06-28')).toMatchObject({ paidBasis: 'recorded', paidOn: '2026-06-24' });
    expect(pickPayrollRun([{ ...all, status: 'approved', paid_on: null }], 0, '2026-06-28')).toMatchObject({ paidBasis: 'bank_file' });
  });
  it('a confirmed file whose action date is still ahead has not paid yet: the net pay is owed', () => {
    const scheduled = run({ pay_date: '2026-06-30', bank_paid_on: '2026-06-30' });
    const got = pickPayrollRun([scheduled], 0, '2026-06-28');
    expect(got).toMatchObject({ totalRequired: STATUTORY + 10_000 });
    expect(got!.paidBasis).toBeUndefined();
  });
});
