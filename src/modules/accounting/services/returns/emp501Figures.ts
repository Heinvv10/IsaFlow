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
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import type { Emp501Kind, Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { ReturnRefusal } from './returnVersionTypes';
import type { ReturnDrift } from './returnDrift';

export interface Emp501Totals { certificates: number; paye: number; uif: number; sdl: number }
export interface Emp501Run { id: string; approvedPlanHash: string | null; approvedAt: string | null }

export interface Emp501Figures {
  taxYear: number;
  kind: Emp501Kind;
  employer: EmployerInput;
  employees: EmployeeInput[];
  warnings: string[];
  totals: Emp501Totals;
  runs: Emp501Run[];
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/** JSON with keys sorted at every level and undefined dropped: JSONB stores keys in its own order. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown => {
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

export function emp501Totals(employees: EmployeeInput[]): Emp501Totals {
  let paye = 0, uif = 0, sdl = 0;
  for (const e of employees) {
    paye += e.paye4102 + (e.lumpSums ?? []).reduce((t, l) => t + l.paye, 0);
    uif += e.uifEmployee + e.uifEmployer;
    sdl += e.sdl4142;
  }
  return { certificates: employees.length, paye: cents(paye), uif: cents(uif), sdl: cents(sdl) };
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
    if (!(err instanceof EasyFileInputRefusal)) throw err;
    if (err.kind === 'not_found') throw new ReturnRefusal(404, 'Company not found.');
    throw new ReturnRefusal(409, err.message, null, err.details ?? null);
  }
  try {
    buildIrp5File({ employer: input.employer, employees: input.employees });
  } catch (err) {
    if (err instanceof UsageError) throw new ReturnRefusal(409, err.message);
    throw err;
  }
  return {
    taxYear: p.taxYear, kind: p.kind, employer: input.employer, employees: input.employees, warnings: input.warnings,
    totals: emp501Totals(input.employees), runs: await finalRuns(companyId, p, lock),
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
  const changed = [
    ...(same(recorded.employer, now.employer) ? [] : ['employer']),
    ...(same(recorded.employees, now.employees) ? [] : ['certificates']),
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
