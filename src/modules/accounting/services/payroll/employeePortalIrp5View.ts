/**
 * An employee's IRP5/IT3(a) certificate as the employee portal shows it (wave 6 SS-c). Pure: it reads one certificate
 * of a FILED EMP501 version's stored figures (emp501Figures: the e@syFile input exactly as filed) and lists its
 * income and its deduction and tax codes with their amounts. Nothing is recalculated and nothing comes from the live
 * payroll. The ID and tax numbers are shown as their last four characters only.
 */
import type { StoredEmployee } from '@/modules/accounting/services/returns/emp501Figures';
import type { EmployerInput } from './easyFileTypes';
import { lumpSumPayeCode } from './payrollLumpSumFiling';
import { currentCertificate } from './easyFileLegacyCertificate';

export interface CertificateLine { code: string; label: string; amount: number }

export interface CertificateView {
  versionId: string;
  taxYear: number;
  kind: 'interim' | 'annual';
  filedAt: string | null;
  certificateNumber: string;
  employer: string;
  payeReference: string;
  employee: string;
  idNumberLast4: string | null;
  taxNumberLast4: string | null;
  periodFrom: string;
  periodTo: string | null;
  income: CertificateLine[];
  deductions: CertificateLine[];
  tax: CertificateLine[];
}

const INCOME: Record<string, string> = {
  '3601': 'Salary', '3605': 'Annual payment (bonus)', '3616': 'Independent contractor income', '3701': 'Travel allowance',
};
const cents = (n: number): number => Math.round(n * 100) / 100;
const last4 = (v: string | null | undefined): string | null => (v && v.trim().length >= 4 ? v.trim().slice(-4) : null);
const day = (ccyymmdd: string | null): string | null =>
  (ccyymmdd && /^\d{8}$/.test(ccyymmdd) ? `${ccyymmdd.slice(0, 4)}-${ccyymmdd.slice(4, 6)}-${ccyymmdd.slice(6, 8)}` : null);
const line = (code: string, label: string, amount: number | undefined): CertificateLine[] =>
  (amount !== undefined && cents(amount) !== 0 ? [{ code, label, amount: cents(amount) }] : []);

function sumByCode(items: Array<{ sourceCode: string; amount: number }>, label: (code: string) => string): CertificateLine[] {
  const by = new Map<string, number>();
  for (const i of items) by.set(i.sourceCode, (by.get(i.sourceCode) ?? 0) + i.amount);
  return [...by.keys()].sort().flatMap((code) => line(code, label(code), by.get(code)));
}

export function certificateView(
  version: { id: string; filedAt: string | null; taxYear: number; kind: 'interim' | 'annual' },
  employer: Pick<EmployerInput, 'tradingName' | 'payeReferenceNumber'>, stored: StoredEmployee,
): CertificateView {
  // The certificate's tax period, 3170 / 3180 (BRS V25.3.0 p. 32), as the printed IRP5 shows it; a certificate stored
  // before the BRS code fix is read in today's shape.
  const c = currentCertificate(stored, version.taxYear, version.kind);
  const lumps = c.lumpSums ?? [];
  const lumpPaye = (code: '4102' | '4115') => lumps.filter((l) => lumpSumPayeCode(l.sourceCode) === code).reduce((t, l) => t + l.paye, 0);
  const income = [
    ...line('3601', INCOME['3601']!, c.grossSalary3601),
    ...line('3605', INCOME['3605']!, c.annualPayments3605),
    ...line('3616', INCOME['3616']!, c.independentContractor3616),
    ...sumByCode(c.cashAllowances ?? [], (code) => INCOME[code] ?? 'Allowance'),
    ...sumByCode(c.fringeBenefits ?? [], () => 'Fringe benefit'),
    ...sumByCode(lumps, () => 'Lump sum (tax directive)'),
  ];
  const r = c.retirementFund;
  const m = c.medical;
  const deductions = [
    ...line('4001', 'Pension fund contributions', r?.pension4001),
    ...line('4003', 'Provident fund contributions', r?.provident4003),
    ...line('4006', 'Retirement annuity contributions', r?.annuity4006),
    ...line('4030', 'Donations', r?.donations4030),
    ...line('4005', 'Medical scheme fees', m?.fees),
  ];
  const tax = [
    ...line('4102', 'PAYE', c.paye4102 + lumpPaye('4102')),
    ...line('4115', 'PAYE on lump sums', lumpPaye('4115')),
    ...line('4116', 'Medical scheme fees tax credit', m?.credit),
    ...line('4120', 'Additional medical expenses tax credit', m?.additionalCredit),
    ...line('4141', 'UIF (employee and employer)', c.uifEmployee + c.uifEmployer),
    ...line('4142', 'SDL (paid by your employer)', c.sdl4142),
  ];
  return {
    versionId: version.id, taxYear: version.taxYear, kind: version.kind, filedAt: version.filedAt,
    certificateNumber: c.certificateNumber, employer: employer.tradingName, payeReference: employer.payeReferenceNumber,
    employee: `${c.firstNames} ${c.surname}`.trim(), idNumberLast4: last4(c.idNumber), taxNumberLast4: last4(c.taxNumber),
    periodFrom: day(c.taxPeriodStart) ?? '', periodTo: day(c.taxPeriodEnd), income, deductions, tax,
  };
}
