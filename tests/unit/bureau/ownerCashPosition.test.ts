// tests/unit/bureau/ownerCashPosition.test.ts
import { describe, it, expect } from 'vitest';
import {
  pickPayrollRun,
  shapePayrollAffordability,
  shapeVatSetAside,
  type PayrollRunRow,
} from '@/modules/bureau/services/ownerCashPositionService';

const run = (over: Partial<PayrollRunRow> = {}): PayrollRunRow => ({
  id: 'run-1', period_month: 6, period_year: 2026, status: 'approved',
  total_net: '90000', total_paye: '14000', total_uif: '1800', total_sdl: '1000', total_eti: '800',
  ...over,
});

describe('shapePayrollAffordability', () => {
  it('computes required = net + paye + uif + sdl − eti and canPay when cash covers it', () => {
    const p = shapePayrollAffordability(run(), 150000);
    expect(p).toEqual({
      runId: 'run-1', periodLabel: 'June 2026', status: 'approved',
      totalRequired: 106000, canPay: true, shortfall: 0, runsCounted: 1,
    });
  });

  it('canPay is true at exact boundary (cash === required)', () => {
    expect(shapePayrollAffordability(run(), 106000)!.canPay).toBe(true);
  });

  it('reports shortfall when cash is short', () => {
    const p = shapePayrollAffordability(run(), 100000);
    expect(p!.canPay).toBe(false);
    expect(p!.shortfall).toBe(6000);
  });

  it('labels draft/calculated runs as estimated', () => {
    expect(shapePayrollAffordability(run({ status: 'calculated' }), 0)!.status).toBe('estimated');
    expect(shapePayrollAffordability(run({ status: 'draft' }), 0)!.status).toBe('estimated');
  });

  it('returns null when there is no run', () => {
    expect(shapePayrollAffordability(null, 100)).toBeNull();
  });

  it('handles pg numeric strings and zero eti', () => {
    const p = shapePayrollAffordability(run({ total_eti: '0' }), 0);
    expect(p!.totalRequired).toBe(106800);
  });
});

describe('pickPayrollRun', () => {
  const zero = { total_net: '0', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0' };
  const prev = run({ id: 'prev', period_month: 5, total_net: '300', total_paye: '100', total_uif: '0', total_sdl: '0', total_eti: '0' });
  const cur = run({ id: 'cur', period_month: 6, total_net: '4000', total_paye: '1000', total_uif: '0', total_sdl: '0', total_eti: '0' });

  it('reports this month when last month is covered and this month is short, against both (cash pays them in turn)', () => {
    const p = pickPayrollRun([prev, cur], 1000);
    // 400 for last month leaves 600 of the 1 000 for this month's 5 000: short 4 400 (review #1549 L1).
    expect(p).toMatchObject({ runId: 'cur', canPay: false, shortfall: 4400, totalRequired: 5400, runsCounted: 2 });
  });

  it('with asAt, a run whose pay date has passed is judged alone, never added to the runs still due (review #1549 N-H1)', () => {
    const paid = { ...prev, pay_date: '2026-05-25', final: true };
    const due = { ...cur, pay_date: '2026-06-30' };
    expect(pickPayrollRun([paid, due], 5000, '2026-06-11')).toMatchObject({ runId: 'cur', canPay: true, totalRequired: 5000, runsCounted: 1 });
    expect(pickPayrollRun([paid, due], 4000, '2026-06-11')).toMatchObject({ runId: 'cur', canPay: false, shortfall: 1000, runsCounted: 1 });
    // A paid run never produces a shortfall (review #1679 codex 4): the due run is the one short.
    expect(pickPayrollRun([paid, due], 300, '2026-06-11')).toMatchObject({ runId: 'cur', canPay: false, shortfall: 4700 });
    // A pay date of today is still due.
    expect(pickPayrollRun([{ ...paid, pay_date: '2026-06-11' }, due], 5000, '2026-06-11')).toMatchObject({ runId: 'cur', canPay: false, runsCounted: 2 });
  });

  // Review #1679 codex 3 and 4: the forecast follows the PAY DATE, not the costing order (regular before off-cycle).
  describe('by pay date (review #1679)', () => {
    const regular = run({ id: 'regular', total_net: '600', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-30' });
    it('a bonus due tomorrow is funded first; the shortfall falls on the regular run at month-end', () => {
      const bonus = run({ id: 'bonus', total_net: '600', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-12' });
      // Rows arrive in costing order (regular first); cash pays the bonus first.
      expect(pickPayrollRun([regular, bonus], 1000, '2026-06-11')).toMatchObject({ runId: 'regular', canPay: false, shortfall: 200, runsCounted: 2 });
      expect(pickPayrollRun([regular, bonus], 1200, '2026-06-11')).toMatchObject({ runId: 'regular', canPay: true, totalRequired: 1200 });
    });
    it('a bonus already paid never reports a shortfall over an affordable due run', () => {
      const due = { ...regular, total_net: '500' };
      const paidBonus = run({ id: 'bonus', total_net: '2000', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-05', final: true });
      expect(pickPayrollRun([due, paidBonus], 1000, '2026-06-11')).toMatchObject({ runId: 'regular', canPay: true, totalRequired: 500, runsCounted: 1 });
    });
    // Review #1679 codex M3: only a FINAL run past its pay date has been paid; an overdue calculated run is still owed.
    it('zero cash and yesterday\'s calculated R20 000 run: R20 000 short', () => {
      const overdue = run({ id: 'overdue', status: 'calculated', total_net: '20000', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-10', final: false });
      expect(pickPayrollRun([overdue], 0, '2026-06-11')).toMatchObject({ runId: 'overdue', canPay: false, shortfall: 20000 });
      // A row that does not say it is final is not taken as paid.
      const { final: _f, ...unknown } = overdue;
      expect(pickPayrollRun([unknown], 0, '2026-06-11')).toMatchObject({ runId: 'overdue', canPay: false, shortfall: 20000 });
    });
    it('an overdue calculated run still counts against the run due after it', () => {
      const overdue = run({ id: 'overdue', status: 'calculated', total_net: '20000', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-10', final: false });
      expect(pickPayrollRun([overdue, regular], 20_400, '2026-06-11')).toMatchObject({ runId: 'regular', canPay: false, shortfall: 200, totalRequired: 20_600, runsCounted: 2 });
    });
    // Gate rulings 4 and 5 on 7630d9379f: payday settles net pay only; PAYE, UIF and SDL stay owed until the month's
    // EMP201 is due (7th of the next month: after it, assumed paid, as the 13-week forecast does). A reopened run that
    // was paid out owes only what is above its paid snapshot.
    it('a final run past payday still owes its PAYE, UIF and SDL until its EMP201 is due', () => {
      const june = run({ id: 'june', total_net: '10000', total_paye: '2000', total_uif: '200', total_sdl: '100', total_eti: '0', pay_date: '2026-06-25', final: true });
      expect(pickPayrollRun([june], 1000, '2026-06-30')).toMatchObject({ runId: 'june', canPay: false, totalRequired: 2300, shortfall: 1300 });
      expect(pickPayrollRun([june], 1000, '2026-07-07')).toMatchObject({ runId: 'june', totalRequired: 2300 });
      expect(pickPayrollRun([june], 1000, '2026-07-08')).toMatchObject({ runId: 'june', canPay: true, shortfall: 0 });
    });
    it('the EMP201 due date moves back off a weekend: a Saturday 7th to Friday the 6th, a Sunday 7th to Friday the 5th', () => {
      const paidRun = (month: number, year: number) => run({ id: `r${month}`, period_month: month, period_year: year, total_net: '1000',
        total_paye: '300', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: `${year}-${String(month).padStart(2, '0')}-25`, final: true });
      // October 2026: due Saturday 7 November, so Friday the 6th.
      expect(pickPayrollRun([paidRun(10, 2026)], 0, '2026-11-06')).toMatchObject({ totalRequired: 300, canPay: false });
      expect(pickPayrollRun([paidRun(10, 2026)], 0, '2026-11-07')).toMatchObject({ canPay: true, shortfall: 0 });
      // January 2027: due Sunday 7 February, so Friday the 5th.
      expect(pickPayrollRun([paidRun(1, 2027)], 0, '2027-02-05')).toMatchObject({ totalRequired: 300, canPay: false });
      expect(pickPayrollRun([paidRun(1, 2027)], 0, '2027-02-06')).toMatchObject({ canPay: true, shortfall: 0 });
    });
    it('a paid run whose statutory figure is negative (ETI above its PAYE, UIF and SDL) nets against its month (review L2)', () => {
      // A bonus paid on the 15th with R300 more ETI than its PAYE: the month's EMP201 owes R300 less.
      const credit = run({ id: 'credit', total_net: '5000', total_paye: '200', total_uif: '0', total_sdl: '0', total_eti: '500', pay_date: '2026-06-15', final: true });
      const june = run({ id: 'june', total_net: '10000', total_paye: '2000', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-25', final: true });
      expect(pickPayrollRun([credit, june], 0, '2026-06-30')).toMatchObject({ runId: 'june', canPay: false, totalRequired: 1700, runsCounted: 1 });
      // Another month's credit is not netted (its own EMP201).
      const may = { ...credit, id: 'may', period_month: 5, pay_date: '2026-05-15' };
      expect(pickPayrollRun([may, june], 0, '2026-06-05')).toMatchObject({ runId: 'june', totalRequired: 12000 });
    });
    it('a reopened bonus already paid out owes only the gross above its paid snapshot (after its EMP201 is due)', () => {
      const reopened = run({ id: 'bonus', status: 'calculated', total_gross: '5500', total_net: '4000', total_paye: '1500', total_uif: '0',
        total_sdl: '0', total_eti: '0', pay_date: '2026-06-05', final: false, disbursed: true, paid_gross: '5000' });
      expect(pickPayrollRun([reopened], 100, '2026-07-08')).toMatchObject({ runId: 'bonus', canPay: false, totalRequired: 500, shortfall: 400 });
      // Never approved and overdue: still owed in full (review #1679 M3).
      expect(pickPayrollRun([{ ...reopened, disbursed: false }], 100, '2026-07-08')).toMatchObject({ totalRequired: 5500 });
    });
    it('with only paid runs, the latest is reported as covered (its money has left)', () => {
      const paidBonus = run({ id: 'bonus', total_net: '2000', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-05', final: true });
      expect(pickPayrollRun([paidBonus], 100, '2026-06-11')).toMatchObject({ runId: 'bonus', canPay: true, shortfall: 0 });
    });
    // Review #1679 Codex of 7630d9379: salaries paid, PAYE / UIF / SDL still owed until the month's EMP201 is due.
    it('a paid run keeps its PAYE, UIF and SDL less ETI in the requirement until the 7th of the next month', () => {
      const paid = run({ id: 'paid', period_month: 6, total_net: '9000', total_paye: '1400', total_uif: '180', total_sdl: '100', total_eti: '80', pay_date: '2026-06-25', final: true });
      expect(pickPayrollRun([paid], 1000, '2026-06-26')).toMatchObject({ runId: 'paid', canPay: false, totalRequired: 1600, shortfall: 600 });
      expect(pickPayrollRun([paid], 1600, '2026-07-07')).toMatchObject({ runId: 'paid', canPay: true, totalRequired: 1600 });
      expect(pickPayrollRun([paid, regular], 1700, '2026-06-26')).toMatchObject({ runId: 'regular', canPay: false, totalRequired: 2200, shortfall: 500, runsCounted: 2 });
      // After the due date the remittance is taken as made: the run needs nothing.
      expect(pickPayrollRun([paid], 0, '2026-07-08')).toMatchObject({ runId: 'paid', canPay: true, shortfall: 0 });
      // December's EMP201 is due in January of the next year.
      const december = { ...paid, period_month: 12, pay_date: '2026-12-24' };
      expect(pickPayrollRun([december], 0, '2027-01-07')).toMatchObject({ canPay: false, shortfall: 1600 });
      expect(pickPayrollRun([december], 0, '2027-01-08')).toMatchObject({ canPay: true, shortfall: 0 });
    });
    it('a run reopened after its salaries left (approved over its pay date) is not counted as a new net payment', () => {
      const reopened = run({ id: 'bonus', status: 'calculated', total_net: '20000', total_paye: '500', total_uif: '0', total_sdl: '0', total_eti: '0', pay_date: '2026-06-10', final: false, disbursed: true });
      expect(pickPayrollRun([reopened], 500, '2026-06-11')).toMatchObject({ runId: 'bonus', canPay: true, totalRequired: 500 });
      expect(pickPayrollRun([reopened], 0, '2026-06-11')).toMatchObject({ runId: 'bonus', canPay: false, shortfall: 500 });
      // Never approved over its pay date: still owed in full (review #1679 M3).
      expect(pickPayrollRun([{ ...reopened, disbursed: false }], 0, '2026-06-11')).toMatchObject({ canPay: false, shortfall: 20500 });
      // Before its pay date it is due in full whatever its history.
      expect(pickPayrollRun([reopened], 0, '2026-06-10')).toMatchObject({ canPay: false, shortfall: 20500 });
    });
  });

  it('cash that covers each run alone but not both is short on the second', () => {
    expect(pickPayrollRun([prev, cur], 5000)).toMatchObject({ runId: 'cur', canPay: false, shortfall: 400, runsCounted: 2 });
    expect(pickPayrollRun([prev, cur], 5400)).toMatchObject({ runId: 'cur', canPay: true, shortfall: 0, totalRequired: 5400, runsCounted: 2 });
  });

  it('reports the earliest short run when both are short', () => {
    expect(pickPayrollRun([prev, cur], 100)!.runId).toBe('prev');
  });

  it('a draft with no totals does not hide a shortfall on the other run', () => {
    expect(pickPayrollRun([run({ id: 'draft', period_month: 5, ...zero }), cur], 1000)!.runId).toBe('cur');
  });

  it('when every run is covered, reports the latest run with totals', () => {
    expect(pickPayrollRun([prev, run({ id: 'draft', ...zero })], 1000)).toMatchObject({ runId: 'prev', canPay: true });
  });

  it('falls back to the earliest run when none has totals, and null for none', () => {
    expect(pickPayrollRun([run({ id: 'a', ...zero }), run({ id: 'b', ...zero })], 0)!.runId).toBe('a');
    expect(pickPayrollRun([], 0)).toBeNull();
  });
});

describe('shapeVatSetAside', () => {
  it('shapes a bi-monthly period label with netVat', () => {
    const v = shapeVatSetAside(23000, { periodStart: '2026-05-01', periodEnd: '2026-06-30', dueDate: '2026-07-25' });
    expect(v).toEqual({ periodLabel: 'May–Jun 2026', dueDate: '2026-07-25', netVat: 23000 });
  });

  it('shapes a monthly period label', () => {
    const v = shapeVatSetAside(-500, { periodStart: '2026-06-01', periodEnd: '2026-06-30', dueDate: '2026-07-25' });
    expect(v.periodLabel).toBe('Jun 2026');
    expect(v.netVat).toBe(-500);
  });

  it('labels a cross-year bi-monthly period with the end year', () => {
    const v = shapeVatSetAside(100, { periodStart: '2025-12-01', periodEnd: '2026-01-31', dueDate: '2026-02-25' });
    expect(v.periodLabel).toBe('Dec–Jan 2026');
  });
});
