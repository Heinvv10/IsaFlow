/**
 * An EMP501 version's figures (wave 6 EFb): the e@syFile input exactly as the file is built from it (employer record
 * and certificates, assembleEasyFileInput), its warnings, totals, and the final runs it sums with their plan hashes.
 * The filing file is built from these stored figures, never from the live payroll, so a later change shows as drift
 * (amend, then finalise again) instead of silently changing what was filed.
 *
 * The certificates carry ID and tax numbers: they are read only through the payroll-detail EMP501 routes, which send
 * the totals, never the certificates.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { buildIrp5File, UsageError, type EmployeeInput, type EmployerInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { assembleEasyFileInput, EasyFileInputRefusal } from '@/modules/accounting/services/payroll/easyFileInput';
import type { PspCertificateInput } from '@/modules/accounting/services/payroll/easyFilePspCertificate';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { currentCertificate, currentEmployer, isLegacyLayout } from '@/modules/accounting/services/payroll/easyFileLegacyCertificate';
import { isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import type { Emp501Kind, Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { ReturnRefusal } from './returnVersionTypes';
import type { ReturnDrift } from './returnDrift';

export interface Emp501Totals { certificates: number; paye: number; uif: number; sdl: number }
export interface Emp501Run { id: string; approvedPlanHash: string | null; approvedAt: string | null }

/** A certificate as stored: the date of birth as its calendar day (YYYY-MM-DD), so the bytes never depend on the TZ. */
export type StoredEmployee = Omit<EmployeeInput, 'dateOfBirth'> & { dateOfBirth?: string | null };

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The calendar day of the builder's local-midnight Date (localDay), which emp501FileOf revives with localDay. */
export function storeEmployee(e: EmployeeInput): StoredEmployee {
  const { dateOfBirth, ...rest } = e;
  return dateOfBirth === undefined ? rest : { ...rest, dateOfBirth: dateOfBirth === null ? null : ymd(dateOfBirth) };
}

export interface Emp501Figures {
  taxYear: number;
  kind: Emp501Kind;
  employer: EmployerInput;
  employees: StoredEmployee[];
  warnings: string[];
  totals: Emp501Totals;
  runs: Emp501Run[];
  /**
   * Which payroll employee each certificate is for (wave 6 SS-c): the employee portal shows an employee their own
   * certificate from a FILED version by this map, never by a name or an ID number. Not part of the file or the drift
   * check (the certificates are), and never in emp501PublicFigures. Absent on a version finalised before SS-c.
   */
  certificateEmployees?: Array<{ certificateNumber: string; employeeId: string }>;
  /** Wave 6 PSP-H: each PSP's own H certificate, in the file after the natural persons'. Absent on a version finalised before. */
  pspCertificates?: PspCertificateInput[];
  /**
   * Wave 7 EA2 (ruling 25): this version's filing file is served with each account read live (easyFileBankOverlay).
   * Absent on a version finalised before EA2, which is served byte for byte as stored (it was filed without them).
   * Not part of the drift check or of emp501PublicFigures.
   */
  bankOverlay?: 1;
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** JSON with keys sorted at every level and undefined dropped: JSONB stores keys in its own order. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (x instanceof Date) return x.toISOString(); // as JSONB stores it (an object with no own keys otherwise)
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x).sort()
        .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v) ?? null);
}

export function emp501Totals(
  employees: Array<Pick<EmployeeInput, 'paye4102' | 'lumpSums' | 'uifEmployee' | 'uifEmployer' | 'sdl4142'>>,
  psp: Array<Pick<PspCertificateInput, 'paye4102' | 'uif4141' | 'sdl4142'>> = [],
): Emp501Totals {
  let paye = 0, uif = 0, sdl = 0;
  for (const e of employees) {
    paye += e.paye4102 + (e.lumpSums ?? []).reduce((t, l) => t + l.paye, 0);
    uif += e.uifEmployee + e.uifEmployer;
    sdl += e.sdl4142;
  }
  for (const c of psp) { paye += c.paye4102; uif += c.uif4141; sdl += c.sdl4142; } // wave 6 PSP-H: the H certificates
  return { certificates: employees.length + psp.length, paye: cents(paye), uif: cents(uif), sdl: cents(sdl) };
}

/** The final runs of the period; at finalise share-locked, so a reopen waits for its transaction. */
async function finalRuns(companyId: string, p: Emp501Period, lock: boolean): Promise<Emp501Run[]> {
  const rows = (await sql`
    SELECT h.id, h.approved_plan_hash, h.approved_at FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::UUID AND ${sql.unsafe(payRunFinalSql('h'))}
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${p.start}::DATE AND ${p.end}::DATE
    ORDER BY h.period_year, h.period_month, h.id
    ${sql.unsafe(lock ? 'FOR SHARE OF h' : '')}
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    approvedPlanHash: r.approved_plan_hash == null ? null : String(r.approved_plan_hash),
    approvedAt: r.approved_at == null ? null : new Date(r.approved_at as string | Date).toISOString(),
  }));
}

/** The figures as they stand now; a refusal (409) when no file could be built from them. */
export async function buildEmp501Figures(companyId: string, p: Emp501Period, lock = true): Promise<Emp501Figures> {
  let input;
  try {
    input = await assembleEasyFileInput(companyId, p.taxYear, p.kind);
  } catch (err) {
    if (isRunKindUnsupported(err)) {
      throw new ReturnRefusal(409, err.message, err.code, { action: err.action, reasons: err.reasons });
    }
    if (!(err instanceof EasyFileInputRefusal)) throw err;
    if (err.kind === 'not_found') throw new ReturnRefusal(404, 'Company not found.');
    throw new ReturnRefusal(409, err.message, null, err.details ?? null);
  }
  try {
    buildIrp5File({ employer: input.employer, employees: input.employees, pspCertificates: input.pspCertificates });
  } catch (err) {
    if (err instanceof UsageError) throw new ReturnRefusal(409, err.message);
    throw err;
  }
  return {
    taxYear: p.taxYear, kind: p.kind, employer: input.employer, employees: input.employees.map(storeEmployee), warnings: input.warnings,
    totals: emp501Totals(input.employees, input.pspCertificates), runs: await finalRuns(companyId, p, lock), certificateEmployees: input.certificateEmployees,
    // Only when there are any: a version with none stores (and so compares) exactly as before PSP-H.
    ...(input.pspCertificates.length > 0 ? { pspCertificates: input.pspCertificates } : {}),
    bankOverlay: 1,
  };
}

/** Re-build now and compare with what was finalised: totals, the certificates and employer record, the run set. */
export async function emp501Drift(companyId: string, p: Emp501Period, recorded: Record<string, unknown>): Promise<ReturnDrift> {
  let now: Emp501Figures;
  try {
    now = await buildEmp501Figures(companyId, p, false);
  } catch (err) {
    if (err instanceof ReturnRefusal) return { drifted: true, fields: [], changed: ['input'], unfinalRuns: 0, notes: [err.message] };
    throw err;
  }
  const was = (recorded.totals ?? {}) as Record<string, unknown>;
  const fields = (Object.keys(now.totals) as Array<keyof Emp501Totals>)
    .map((name) => ({ name, recorded: cents(Number(was[name] ?? 0)), current: now.totals[name] }))
    .filter((f) => f.recorded !== f.current);
  const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
  // Figures recorded before the BRS code fix compare in today's shape (easyFileLegacyCertificate): the certificates' tax
  // period and pay periods, and the employer with no province under 2065. A certificate that cannot be rebuilt is drift.
  const recordedEmployees = Array.isArray(recorded.employees) ? (recorded.employees as object[]) : [];
  const legacy = isLegacyLayout(recordedEmployees);
  let employeesNow: unknown = recorded.employees;
  try {
    employeesNow = legacy ? recordedEmployees.map((e) => currentCertificate(e, p.taxYear, p.kind)) : recorded.employees;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    employeesNow = null;
  }
  const employerNow = legacy && recorded.employer && typeof recorded.employer === 'object'
    ? currentEmployer(recorded.employer as EmployerInput, true) : recorded.employer;
  const changed = [
    ...(same(employerNow, now.employer) ? [] : ['employer']),
    ...(same(employeesNow, now.employees) && same(recorded.pspCertificates ?? [], now.pspCertificates ?? []) ? [] : ['certificates']),
    ...(same(recorded.runs, now.runs) ? [] : ['runs']),
  ];
  return { drifted: fields.length + changed.length > 0, fields, changed, unfinalRuns: 0 };
}

/**
 * What an EMP501 version may put anywhere a non-payroll role can read (the sars_submissions form_data that
 * listSubmissions/getSubmission serve): the period, totals, warning count and the runs' ids and plan hashes. Never the
 * certificates, the employer record or the warning texts (they name employees and amounts).
 */
export function emp501PublicFigures(figures: Record<string, unknown>): Record<string, unknown> {
  const f = figures as Partial<Emp501Figures>;
  return {
    taxYear: f.taxYear, kind: f.kind, totals: f.totals ?? null,
    warningCount: Array.isArray(f.warnings) ? f.warnings.length : 0,
    runs: (f.runs ?? []).map((r) => ({ id: r.id, approvedPlanHash: r.approvedPlanHash })),
  };
}
