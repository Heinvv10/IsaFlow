/** Breaker probe for PR 1578 (AN). Drives calculatePayrollLine month by month; compares to an independent hand model. */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { expectRecomputes, stepsByKey } from './payrollExplainRecompute.helpers';
import type { PayeYearToDate, PayrollLineInput, EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const F = 365 / 30.4166;
const r2 = (n: number) => Math.round(n * 100) / 100;
const BR = [[1, 245_100, 0, 0.18], [245_101, 383_100, 44_118, 0.26], [383_101, 530_200, 79_998, 0.31], [530_201, 695_800, 125_599, 0.36],
  [695_801, 887_000, 185_215, 0.39], [887_001, 1_878_600, 259_783, 0.41], [1_878_601, Infinity, 666_339, 0.45]] as const;
const gross = (x: number) => { const b = BR.find(b => x <= b[1]) ?? BR[6]; return b[2] + b[3] * (x - b[0] + 1); };
const afterRebates = (x: number, age: number) => Math.max(0, gross(x) - 17_820 - (age >= 65 ? 9_765 : 0) - (age >= 75 ? 3_249 : 0));
const mtcMonth = (b: number) => (b <= 0 ? 0 : b === 1 ? 376 : 752 + (b - 2) * 254);

interface M { salary: number; bonus?: number; fees?: number; ra?: number }
/** Hand model of the rulings: AE = P×F÷n; R = afterRebates(AE−D)×n÷F; credits ×n÷12 capped; bonus unweighted. */
function hand(months: M[], age: number, ben: number, factor = F) {
  let P = 0, A = 0, fees = 0, C = 0, paid = 0, n = 0;
  const out: { paye: number; mtc: number; amtc: number; ded: number }[] = [];
  let mtcRec = 0, amtcRec = 0, dedRec = 0;
  for (const m of months) {
    n += 1; P += m.salary; A += m.bonus ?? 0; fees += m.fees ?? 0; C += m.ra ?? 0;
    const AE = (P * factor) / n;
    const D = Math.min((C * factor) / n, 0.275 * (AE + A), (430_000 * factor) / 12);
    const offP = Math.min(D, AE);
    const tAE = AE - offP;
    const mtcA = mtcMonth(ben) * 12;
    const amtcA = (x: number) => age >= 65 ? 0.333 * Math.max(0, (fees * 12) / n - 3 * mtcA) : 0;
    const creds = (x: number) => { const t = afterRebates(x, age); const u1 = Math.min(mtcA, t); const u2 = Math.min(amtcA(x), t - u1); return { t, u1, u2, tax: t - u1 - u2 }; };
    const ae = creds(tAE), all = creds(tAE + A);
    const R = (ae.t * n) / factor;
    const mtcOn = Math.min((ae.u1 * n) / 12, R);
    const amtcOn = Math.min((ae.u2 * n) / 12, R - mtcOn);
    const liability = R - mtcOn - amtcOn + (all.tax - ae.tax);
    const due = Math.max(0, r2(liability - paid));
    paid = r2(paid + due);
    const mtcTD = mtcOn + all.u1 - ae.u1, amtcTD = amtcOn + all.u2 - ae.u2, dedTD = (offP * n) / factor;
    out.push({ paye: due, mtc: r2(mtcTD - mtcRec), amtc: r2(amtcTD - amtcRec), ded: r2(dedTD - dedRec) });
    mtcRec = r2(mtcRec + r2(mtcTD - mtcRec)); amtcRec = r2(amtcRec + r2(amtcTD - amtcRec)); dedRec = r2(dedRec + r2(dedTD - dedRec));
  }
  return out;
}

const comp = (id: string, code: string, type: 'earning' | 'deduction', amount: number): EmployeeComponent => ({
  component: { id, name: code, sarsSourceCode: code, componentType: type, isTaxable: true, isUifApplicable: type === 'earning', isSdlApplicable: type === 'earning' },
  amount,
});

/** Runs the engine for consecutive months from (year, month), carrying the year to date the way the reader would. */
function engine(months: M[], dob: string, ben: number, start = { year: 2026, month: 3 }) {
  let ytd: PayeYearToDate = { periods: 0, retirementCapPeriods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0,
    medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, donations: 0, donationReceipted: 0, donationBase: 0, donationDeduction: 0,
    sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0, sdlDonationDeduction: 0 };
  const out: { paye: number; mtc: number; amtc: number; ded: number; recompute: unknown; bounded: boolean }[] = [];
  months.forEach((m, i) => {
    const mm = ((start.month - 1 + i) % 12) + 1; const yy = start.year + Math.floor((start.month - 1 + i) / 12);
    const components = [comp('s', '3601', 'earning', m.salary)];
    if (m.bonus) components.push(comp('b', '3605', 'earning', m.bonus));
    if (m.fees) components.push(comp('f', '4005', 'deduction', m.fees));
    if (m.ra) components.push(comp('r', '4006', 'deduction', m.ra));
    const input = {
      employee: { id: 'e', companyId: 'c', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent', startDate: new Date('2020-03-01'),
        dateOfBirth: new Date(dob), uifExcluded: true, medicalAidMainMember: ben > 0, medicalAidDependantsCount: Math.max(0, ben - 1), s18aReceiptHeld: false,
        taxStatus: 'statutory', payBasis: 'monthly' },
      components, period: { year: yy, month: mm }, taxYear: 2027, annualPayrollEstimate: 10_000_000, ...(i > 0 ? { ytd } : {}),
    } as unknown as PayrollLineInput;
    const line = calculatePayrollLine(input);
    let rec: unknown = 'ok';
    try { expectRecomputes(line); } catch (e) { rec = String(e); }
    out.push({ paye: line.paye.monthlyPaye, mtc: line.medicalCredit, amtc: line.additionalMedicalCredit, ded: line.retirementDeduction, recompute: rec,
      bounded: stepsByKey(line.explanations.paye).has('paye.retirement.toDate') });
    ytd = { ...ytd, periods: ytd.periods + 1, retirementCapPeriods: (ytd.retirementCapPeriods ?? 0) + 1, periodicTaxable: r2(ytd.periodicTaxable + line.periodicTaxable),
      annualPayments: r2(ytd.annualPayments + line.annualTaxable), tablePaye: r2(ytd.tablePaye + line.paye.monthlyPaye),
      medicalCredit: r2(ytd.medicalCredit + line.medicalCredit), additionalMedicalCredit: r2(ytd.additionalMedicalCredit + line.additionalMedicalCredit),
      medicalSchemeFees: r2(ytd.medicalSchemeFees + (m.fees ?? 0)), retirementContributions: r2((ytd.retirementContributions ?? 0) + (m.ra ?? 0)),
      retirementDeduction: r2((ytd.retirementDeduction ?? 0) + line.retirementDeduction),
      sdlApplicable: r2((ytd.sdlApplicable ?? 0) + m.salary + (m.bonus ?? 0)), sdlLeviable: r2((ytd.sdlLeviable ?? 0) + line.sdlLeviable),
      sdlRetirementDeduction: r2((ytd.sdlRetirementDeduction ?? 0) + line.retirementDeduction) } as PayeYearToDate;
  });
  return out;
}

const rep = (name: string, e: ReturnType<typeof engine>, h: ReturnType<typeof hand>) => {
  const rows = e.map((x, i) => ({ i: i + 1, engPaye: x.paye, handPaye: h[i]!.paye, engMtc: x.mtc, handMtc: h[i]!.mtc, engAmtc: x.amtc, handAmtc: h[i]!.amtc, engDed: x.ded, handDed: h[i]!.ded, rec: x.recompute }));
  const sum = (k: 'engPaye' | 'handPaye' | 'engMtc' | 'handMtc' | 'engAmtc' | 'handAmtc' | 'engDed' | 'handDed') => r2(rows.reduce((t, r) => t + (r[k] as number), 0));
  // eslint-disable-next-line no-console
  console.log(name, JSON.stringify({ totals: { engPaye: sum('engPaye'), handPaye: sum('handPaye'), engMtc: sum('engMtc'), handMtc: sum('handMtc'), engAmtc: sum('engAmtc'), handAmtc: sum('handAmtc'), engDed: sum('engDed'), handDed: sum('handDed') }, diffs: rows.filter(r => r.engPaye !== r.handPaye || r.engMtc !== r.handMtc || r.engAmtc !== r.handAmtc || r.engDed !== r.handDed || r.rec !== 'ok') }));
  return rows;
};
const year = (m: M) => Array.from({ length: 12 }, () => ({ ...m }));

describe('PR 1578 breaker', () => {
  it('S1 12 months medical 1 beneficiary', () => { const m = year({ salary: 45_000, fees: 2_000 }); const rows = rep('S1', engine(m, '1986-01-01', 1), hand(m, 40, 1)); expect(rows.every(r => r.engPaye === r.handPaye && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
  it('S2 12 months medical 3 beneficiaries', () => { const m = year({ salary: 45_000, fees: 5_000 }); const rows = rep('S2', engine(m, '1986-01-01', 3), hand(m, 40, 3)); expect(rows.every(r => r.engPaye === r.handPaye && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
  it('S2b low earner where the credit binds', () => { const m = year({ salary: 9_500, fees: 3_000 }); const rows = rep('S2b', engine(m, '1986-01-01', 3), hand(m, 40, 3)); expect(rows.every(r => r.engPaye === r.handPaye && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
  it('S3 mid-year starter n = 5', () => { const m = Array.from({ length: 5 }, () => ({ salary: 40_000, fees: 2_000 })); const rows = rep('S3', engine(m, '1986-01-01', 1, { year: 2026, month: 10 }), hand(m, 40, 1)); expect(rows.every(r => r.engPaye === r.handPaye && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
  it('S4 65+ fees above 3 x MTC', () => { const m = year({ salary: 30_000, fees: 5_000 }); const rows = rep('S4', engine(m, '1958-01-01', 1), hand(m, 69, 1)); expect(rows.every(r => r.engPaye === r.handPaye && r.engAmtc === r.handAmtc && r.rec === 'ok')).toBe(true); });
  it('S5 RF hits the cap mid-year', () => { const m = Array.from({ length: 12 }, (_, i) => ({ salary: 200_000, ra: i < 6 ? 10_000 : 100_000 })); const rows = rep('S5', engine(m, '1986-01-01', 0), hand(m, 40, 0)); expect(rows.every(r => r.engPaye === r.handPaye && r.engDed === r.handDed && r.rec === 'ok')).toBe(true); });
  it('S6 annual bonus in month 9, with medical aid', () => { const m = year({ salary: 30_000, fees: 2_000 }); m[8]!.bonus = 60_000; const rows = rep('S6', engine(m, '1986-01-01', 2), hand(m, 40, 2)); expect(rows.every(r => r.engPaye === r.handPaye && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
  it('S7 terminated after 7 months', () => { const m = Array.from({ length: 7 }, () => ({ salary: 60_000, fees: 2_500, ra: 5_000 })); const rows = rep('S7', engine(m, '1986-01-01', 2), hand(m, 40, 2)); expect(rows.every(r => r.engPaye === r.handPaye && r.rec === 'ok')).toBe(true); });
  it('S8 65+ low earner, AMTC binds', () => { const m = year({ salary: 18_000, fees: 6_000 }); const rows = rep('S8', engine(m, '1958-01-01', 2), hand(m, 69, 2)); expect(rows.every(r => r.engPaye === r.handPaye && r.engAmtc === r.handAmtc && r.engMtc === r.handMtc && r.rec === 'ok')).toBe(true); });
});
describe('PR 1578 round 3: no spurious bound at the cap', () => {
  it('S10 twelve months at the cap (R200 000, RA R50 000): no line\'s drawer shows the bounded step, and the year deducts R430 000', () => {
    const e = engine(Array.from({ length: 12 }, () => ({ salary: 200_000, ra: 50_000 })), '1986-01-01', 0);
    expect(e.map(x => x.bounded)).toEqual(Array(12).fill(false));
    expect(Math.round(e.reduce((t, x) => t + x.ded, 0) * 100)).toBe(43_000_000);
  });
});

describe('PR 1578 round 2: a 13th line at the cap', () => {
  it('S9 13 lines at R200 000 with a R50 000 RA: each explanation recomputes, and the deduction stops at the cap', () => {
    const m = Array.from({ length: 13 }, () => ({ salary: 200_000, ra: 50_000 }));
    const e = engine(m, '1986-01-01', 0);
    expect(e.map(x => x.recompute)).toEqual(Array(13).fill('ok'));
    expect(e.map(x => x.bounded)).toEqual([...Array(12).fill(false), true]); // only the 13th line is bounded
    expect(Math.round(e.reduce((t, x) => t + x.ded, 0) * 100)).toBe(43_000_000);
  });
});
describe('statute x12 deltas', () => {
  it('prints', () => {
    const cases: [string, M[], number, number][] = [
      ['S1', year({ salary: 45_000, fees: 2_000 }), 40, 1], ['S2', year({ salary: 45_000, fees: 5_000 }), 40, 3],
      ['S2b', year({ salary: 9_500, fees: 3_000 }), 40, 3], ['S3', Array.from({ length: 5 }, () => ({ salary: 40_000, fees: 2_000 })), 40, 1],
      ['S4', year({ salary: 30_000, fees: 5_000 }), 69, 1], ['S5', Array.from({ length: 12 }, (_, i) => ({ salary: 200_000, ra: i < 6 ? 10_000 : 100_000 })), 40, 0],
      ['S7', Array.from({ length: 7 }, () => ({ salary: 60_000, fees: 2_500, ra: 5_000 })), 40, 2], ['S8', year({ salary: 18_000, fees: 6_000 }), 69, 2],
    ];
    const tot = (h: ReturnType<typeof hand>, k: 'paye' | 'mtc' | 'amtc' | 'ded') => r2(h.reduce((t, x) => t + x[k], 0));
    for (const [n, m, age, ben] of cases) {
      const a = hand(m, age, ben), s = hand(m, age, ben, 12);
      // eslint-disable-next-line no-console
      console.log('DELTA', n, JSON.stringify({ an: [tot(a, 'paye'), tot(a, 'mtc'), tot(a, 'amtc'), tot(a, 'ded')], x12: [tot(s, 'paye'), tot(s, 'mtc'), tot(s, 'amtc'), tot(s, 'ded')] }));
    }
  });
});
import { calculateCumulativePaye } from '@/modules/accounting/services/payroll/payeCumulative';
describe('weekly 52 / 53 and monthly 13', () => {
  const run = (factor: number, periods: number, salary: number, ra: number) => {
    let ytd: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, retirementCapPeriods: 0 };
    let paye = 0, mtc = 0, ded = 0;
    for (let i = 0; i < periods; i++) {
      const r = calculateCumulativePaye({ taxYear: 2027, rebateAge: 40, monthlyMedicalBeneficiaries: 1, medicalSchemeFees: 0, factor, periodsInYear: factor === F ? 12 : factor, regularTaxable: salary, annualPayments: 0,
        periodicRemuneration: salary, annualPaymentRemuneration: 0, retirementContributions: ra, ytd });
      paye += r.regular.monthlyPaye; mtc += r.medicalCredit; ded += r.retirementDeduction;
      ytd = { ...ytd, periods: ytd.periods + 1, retirementCapPeriods: (ytd.retirementCapPeriods ?? 0) + 1, periodicTaxable: ytd.periodicTaxable + salary, tablePaye: r2(ytd.tablePaye + r.regular.monthlyPaye),
        medicalCredit: r2(ytd.medicalCredit + r.medicalCredit), retirementContributions: (ytd.retirementContributions ?? 0) + ra, retirementDeduction: r2((ytd.retirementDeduction ?? 0) + r.retirementDeduction) };
    }
    return { paye: r2(paye), mtc: r2(mtc), ded: r2(ded) };
  };
  it('prints', () => {
    // eslint-disable-next-line no-console
    console.log('WK', JSON.stringify({ w52: run(52, 52, 50_000, 10_000), w53: run(52, 53, 50_000, 10_000), m12: run(F, 12, 220_000, 45_000), m13: run(F, 13, 220_000, 45_000) }));
  });
});
describe('AN_CENTS', () => {
  it('prints', () => {
    const es: [string, number, number, number, number][] = [['E0', 20_000, 46, 0, 0], ['E1', 30_000, 40, 2, 3_000], ['E2', 25_000, 40, 0, 0], ['E3', 30_000, 70, 2, 0], ['E4', 18_000, 70, 0, 0], ['E6', 20_000, 66, 1, 1_000]];
    const out: Record<string, number> = {};
    for (const [n, s, age, ben, fees] of es) {
      const m = Array.from({ length: 3 }, () => ({ salary: s, fees }));
      const a = hand(m, age, ben), x = hand(m, age, ben, 12);
      a.forEach((r, i) => { out[`${n} ${i + 3}`] = Math.round(r.paye * 100) - Math.round(x[i]!.paye * 100); });
    }
    // eslint-disable-next-line no-console
    console.log('ANC', JSON.stringify(out));
  });
});
