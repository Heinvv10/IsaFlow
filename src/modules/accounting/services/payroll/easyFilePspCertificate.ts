/**
 * A personal service provider's own e@syFile certificate (wave 6 PSP-H): nature of person H, issued to the company / CC or
 * trust, separate from any natural-person certificate the same payroll employee has for months paid as an employee (SARS PAYE
 * Employer Reconciliation BRS V25.3.0 p. 17: a separate certificate when the nature of person changed). Built from the PSP's
 * lines only (pspLineFlag, decided per line) on the final runs of the period.
 *
 * Fields (BRS V25.3.0): 3010, 3015 IRP5, 3020 H (p. 17), 3025, 3030 the trading name (p. 20), never 3040 / 3050 / 3060 / 3080
 * (pp. 20-26), 3065 1 (company / CC) or 2 (trust) with 3066 the registration number when one is held (pp. 23-24), 3100 the
 * entity's tax reference starting with 9 (pp. 26-27), 3170 / 3180 the certificate's tax period (p. 32), 3200 / 3210 the
 * pay periods in the year and worked (p. 33), 3230 any IRP3(b) directive number (p. 41), 3601 the payments (PAYE-GEN-01-G21
 * p. 31), 4102 the PAYE, 4141 the UIF (nil on a PSP's lines), 4142 the SDL.
 *
 * Certified only with a trading name and a tax reference (3100 is mandatory when 4102 is above nil, p. 26); without them the
 * PSP's months stay off the file, named (pspFiling). A PSP with no PAYE in the period is refused: an IRP5 needs 4102 above nil
 * and SARS lists no IT3(a) reason for a PSP (UNVERIFIED), so the file is refused naming it; clearing its tax reference leaves it
 * off instead.
 *
 * CODE MAP: every identity and period field is written through the single e@syFile code map (easyFileCertificateCodes,
 * wave 6 EZF), with 3065 / 3066 added there. 3100 must pass the BRS modulus 10 test (Appendix B §8.1, pp. 117-118).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatField, passesIncomeTaxModulus10, UsageError } from './easyFileFields';
import { certificateField } from './easyFileCertificateCodes';
import { buildCertificateNumber } from './easyFileCertificateNumber';
import { payRunFinalSql } from './payRunFinalSql';
import { pspLineFlag } from './payrollOutsideTables';
import { validateCertificateTaxFields } from './irp5ValidationEngine';

export interface PspCertificateInput {
  employeeId: string;
  certificateNumber: string;
  yearOfAssessment: number;
  entityType: 'company' | 'trust';
  tradingName: string;
  registrationNumber: string | null;
  taxReference: string;
  /** CCYYMMDD: the first day of the first PSP month and the last day of the last, inside the period. */
  periodStart: string;
  periodEnd: string;
  /** The pay intervals in the year (12 / 26 / 52 by frequency) and those the PSP was paid in. */
  payPeriods: number;
  periodsWorked: number;
  directiveNumbers: string[];
  gross3601: number;
  paye4102: number;
  /** Nil for a PSP (no UIF on its lines); the lines' sum, so the certificate always equals what the EMP201 declared. */
  uif4141: number;
  sdl4142: number;
}

/** The H record, in BRS code order, validated as the natural-person record is (irp5ValidationEngine). */
export function buildPspCertificateRecord(c: PspCertificateInput): string[] {
  if (!/^9\d{9}$/.test(c.taxReference) || !passesIncomeTaxModulus10(c.taxReference)) {
    throw new UsageError(`${c.tradingName} (certificate ${c.certificateNumber}): the income tax reference (code 3100) must be 10 digits `
      + 'starting with 9 that pass the SARS modulus 10 test (BRS V25.3.0 pp. 26-27, 117-118). Correct it on the employee\'s Work card.');
  }
  if (c.paye4102 <= 0) {
    throw new UsageError(`${c.tradingName} (certificate ${c.certificateNumber}): a personal service provider with no PAYE this period cannot be `
      + 'certified (an IRP5 needs PAYE above nil; SARS lists no IT3(a) reason for a PSP). Clear its tax reference to leave it off the file.');
  }
  const lines: (string | null)[] = [
    certificateField('certificateNumber', c.certificateNumber),
    certificateField('certificateType', 'IRP5'),
    certificateField('natureOfPerson', 'H'),
    certificateField('yearOfAssessment', c.yearOfAssessment),
    certificateField('surname', c.tradingName), // 3030: for nature H the trading name (p. 20)
    c.registrationNumber ? certificateField('alternateIdType', c.entityType === 'company' ? 1 : 2) : null,
    c.registrationNumber ? certificateField('alternateIdNumber', c.registrationNumber) : null,
    certificateField('incomeTaxReference', c.taxReference),
    certificateField('taxPeriodStart', c.periodStart),
    certificateField('taxPeriodEnd', c.periodEnd),
    certificateField('payPeriodsInYear', c.payPeriods),
    certificateField('payPeriodsWorked', c.periodsWorked),
    ...c.directiveNumbers.map((n) => formatField(3230, n, 'AN')), // the directive number (p. 41)
    formatField(3601, c.gross3601 >= 1 ? c.gross3601 : null, 'N'),
    formatField(4102, c.paye4102, 'N_CENTS'),
    formatField(4141, c.uif4141, 'N_CENTS'),
    formatField(4142, c.sdl4142, 'N_CENTS'),
    '9999,9999',
  ];
  const record = lines.filter((l): l is string => l !== null);
  const broken = validateCertificateTaxFields(record);
  if (broken.length > 0) throw new UsageError(`${c.tradingName} (certificate ${c.certificateNumber}): ${broken.map((m) => m.message).join(' ')}`);
  return record;
}

const ccyymmdd = (y: number, m: number, d: number) => `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The period's H certificates, numbered on from `seq` (the natural-person certificates' last), for every PSP whose lines
 * carry pay and whose particulars are complete (a trading name and a tax reference). This company only.
 */
export async function loadPspCertificates(
  companyId: string, bounds: { start: string; end: string }, payeRef: string, taxYear: number, reconciliationMonth: 2 | 8, seq: number,
): Promise<PspCertificateInput[]> {
  const rows = (await sql`
    WITH lines AS (
      SELECT l.employee_id, l.gross_pay, l.paye, l.sdl, l.uif_employee + l.uif_employer AS uif, l.validation_results, h.id AS run_id, h.period_year, h.period_month
        FROM payroll_run_lines l
        JOIN payroll_run_headers h ON h.id = l.run_id
       WHERE h.company_id = ${companyId}::uuid
         AND ${sql.unsafe(payRunFinalSql('h'))}
         AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
         AND l.validation_results @> ${pspLineFlag}::jsonb
    )
    SELECT e.id::text AS employee_id, e.psp_entity_type, e.psp_entity_name, e.psp_registration_number, e.psp_tax_reference, e.pay_frequency,
           SUM(x.gross_pay)::numeric AS gross, SUM(x.paye)::numeric AS paye, SUM(x.uif)::numeric AS uif, SUM(x.sdl)::numeric AS sdl,
           MIN(x.period_year * 100 + x.period_month) AS first_month, MAX(x.period_year * 100 + x.period_month) AS last_month,
           COUNT(DISTINCT (x.period_year, x.period_month))::int AS months, COUNT(DISTINCT x.run_id)::int AS runs,
           COALESCE((SELECT array_agg(DISTINCT v->'directive'->>'number')
                       FROM lines y CROSS JOIN LATERAL jsonb_array_elements(y.validation_results) v
                      WHERE y.employee_id = e.id AND v->>'code' = 'PAYE_OUTSIDE_TABLES' AND v->>'treatment' = 'directive'), '{}') AS directives
      FROM lines x
      JOIN payroll_employees e ON e.id = x.employee_id AND e.company_id = ${companyId}::uuid
     WHERE e.psp_entity_name IS NOT NULL AND e.psp_tax_reference IS NOT NULL
     GROUP BY e.id, e.psp_entity_type, e.psp_entity_name, e.psp_registration_number, e.psp_tax_reference, e.pay_frequency, e.last_name, e.first_name
     ORDER BY e.last_name, e.first_name, e.id
  `) as DbRow[];
  // 3200: the pay intervals in a year by the payroll's frequency; 3210: those the PSP was paid in (FQc's weekly runs count by run).
  const PERIODS: Record<string, number> = { monthly: 12, fortnightly: 26, weekly: 52 };
  return rows.map((r, i) => {
    const first = Number(r.first_month), last = Number(r.last_month);
    const [fy, fm, ly, lm] = [Math.floor(first / 100), first % 100, Math.floor(last / 100), last % 100];
    return {
      employeeId: String(r.employee_id),
      certificateNumber: buildCertificateNumber(payeRef, taxYear, reconciliationMonth, seq + i + 1),
      yearOfAssessment: taxYear,
      entityType: r.psp_entity_type === 'trust' ? 'trust' : 'company',
      tradingName: String(r.psp_entity_name),
      registrationNumber: r.psp_registration_number == null ? null : String(r.psp_registration_number),
      taxReference: String(r.psp_tax_reference),
      periodStart: ccyymmdd(fy, fm, 1),
      periodEnd: ccyymmdd(ly, lm, lastDay(ly, lm)),
      payPeriods: PERIODS[String(r.pay_frequency)] ?? 12,
      periodsWorked: (PERIODS[String(r.pay_frequency)] ?? 12) === 12 ? Number(r.months) : Number(r.runs),
      directiveNumbers: (r.directives as unknown[]).filter((n): n is string => typeof n === 'string' && n !== ''),
      gross3601: Math.round(Number(r.gross) * 100) / 100,
      paye4102: Math.round(Number(r.paye) * 100) / 100,
      uif4141: Math.round(Number(r.uif) * 100) / 100,
      sdl4142: Math.round(Number(r.sdl) * 100) / 100,
    };
  });
}
