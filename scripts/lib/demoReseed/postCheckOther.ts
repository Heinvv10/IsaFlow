/**
 * Post-checks over dates, payroll, SARS rows, assets and deploy-gate
 * preconditions (PLAN 7.2: D1, D2, P1, P2, V1, F1, G1, G2), plus the info-only
 * reports R1 and R2. Read-only.
 */

import type { CheckResult } from '../integrityTypes';
import { DATED, FUTURE_ALLOWED } from './dated';
import { addDays, type Window } from './dates';
import type { Tx } from './db';
import { findDeniedNames } from './denylist';
import { luhnValid } from './employees';
import { PRESERVE_APPEND_ONLY } from './wipePlan';
import { keptReport } from './wipe';

const pass = (label: string, detail: string): CheckResult => ({ label, status: 'pass', detail });
const judge = (label: string, lines: string[], ok: string): CheckResult => (lines.length === 0
  ? pass(label, ok) : { label, status: 'fail', offending: lines.length, detail: `${lines.length} problem(s)`, lines: lines.slice(0, 30) });

async function columnType(tx: Tx, table: string, column: string): Promise<string | null> {
  const [r] = await tx.query<{ t: string }>(
    `SELECT data_type AS t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
  return r?.t ?? null;
}

/** A date or timestamptz column as a SAST calendar day. */
const asDay = (column: string, type: string): string => (type.startsWith('timestamp') ? `(${column} AT TIME ZONE 'Africa/Johannesburg')::date` : column);

export async function checkD(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  const future: string[] = [];
  const floor: string[] = [];
  for (const d of DATED) {
    const type = await columnType(tx, d.table, d.column);
    if (!type) continue;
    const day = asDay(d.column, type);
    const extra = d.where ? ` AND ${d.where}` : '';
    const [r] = await tx.query<{ n: number; mx: string | null; mn: string | null }>(
      `SELECT count(*) FILTER (WHERE ${day} > $2::date)::int AS n, max(${day})::text AS mx, min(${day})::text AS mn
       FROM ${d.table} WHERE company_id = $1::uuid${extra}`, [companyId, win.today]);
    if ((r?.n ?? 0) > 0) future.push(`${d.table}.${d.column}: ${r!.n} after ${win.today} (max ${r!.mx})`);
    if (!d.noFloor && r?.mn && r.mn < win.windowStart) floor.push(`${d.table}.${d.column}: earliest ${r.mn} before ${win.windowStart}`);
  }
  for (const [key, days] of Object.entries(FUTURE_ALLOWED)) {
    const [table, column] = key.split('.') as [string, string];
    if (!(await columnType(tx, table, column))) continue;
    const [r] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1::uuid AND ${column} > $2::date`, [companyId, addDays(win.today, days)]);
    if ((r?.n ?? 0) > 0) future.push(`${key}: ${r!.n} more than ${days} days ahead`);
  }
  return [
    judge('D1 No future-dated transactions', future, `no transaction or posting date after ${win.today}`),
    judge('D2 Window floor', floor, `nothing transactional before ${win.windowStart}`),
  ];
}

export async function checkP(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  const runs = await tx.query<{ y: number; m: number; status: string; n: number; tot_ok: boolean; je: boolean }>(`
    SELECT h.period_year AS y, h.period_month AS m, h.status, count(*) OVER (PARTITION BY h.period_year, h.period_month)::int AS n,
      (h.total_gross = coalesce((SELECT sum(gross_pay) FROM payroll_run_lines l WHERE l.run_id = h.id), 0)
       AND h.total_net = coalesce((SELECT sum(net_pay) FROM payroll_run_lines l WHERE l.run_id = h.id), 0)
       AND h.total_paye = coalesce((SELECT sum(paye) FROM payroll_run_lines l WHERE l.run_id = h.id), 0)) AS tot_ok,
      h.journal_entry_id IS NOT NULL AS je
    FROM payroll_run_headers h WHERE h.company_id = $1::uuid AND h.run_kind = 'regular'`, [companyId]);
  const p1: string[] = [];
  const cur = win.months[win.months.length - 1]!;
  for (const { year, month } of win.months) {
    const here = runs.filter((r) => r.y === year && r.m === month);
    const isCur = year === cur.year && month === cur.month;
    const want = isCur ? 'draft' : 'paid';
    if (here.length !== 1 || here[0]!.status !== want) p1.push(`${year}-${month}: want one ${want} run, have ${here.map((r) => r.status).join(',') || 'none'}`);
    else if (!isCur && (!here[0]!.tot_ok || !here[0]!.je)) p1.push(`${year}-${month}: totals do not match lines or no journal`);
  }
  for (const r of runs) if (r.y * 12 + r.m > cur.year * 12 + cur.month) p1.push(`${r.y}-${r.m}: a run after the current month (${r.status})`);
  const ids = await tx.query<{ employee_number: string; id_number: string | null }>(
    'SELECT employee_number, id_number FROM payroll_employees WHERE company_id = $1::uuid', [companyId]);
  const p2 = ids.filter((e) => e.id_number && luhnValid(e.id_number)).map((e) => `${e.employee_number}: id number passes Luhn`);
  return [
    judge('P1 Payroll runs', p1, 'one paid run per completed window month, a draft this month, none later; totals tie'),
    judge('P2 Employee id numbers fail Luhn', p2, `${ids.length} employees, every id number fails Luhn`),
  ];
}

const PRESERVED_SUBMISSION = 'id IN (SELECT sars_submission_id FROM tax_return_versions WHERE company_id = $1::uuid AND sars_submission_id IS NOT NULL)';

export async function checkV1(tx: Tx, companyId: string): Promise<CheckResult> {
  const [r] = await tx.query<{ vr: number; ss: number }>(`
    SELECT (SELECT count(*) FROM vat_returns WHERE company_id = $1::uuid)::int AS vr,
      (SELECT count(*) FROM sars_submissions WHERE company_id = $1::uuid AND NOT (${PRESERVED_SUBMISSION})
        AND (status <> 'draft' OR submitted_at IS NOT NULL OR submission_reference IS NOT NULL OR efiling_correlation_id IS NOT NULL))::int AS ss`, [companyId]);
  const lines: string[] = [];
  if ((r?.vr ?? 0) > 0) lines.push(`${r!.vr} vat_returns row(s)`);
  if ((r?.ss ?? 0) > 0) lines.push(`${r!.ss} sars_submissions row(s) marked as submitted`);
  return judge('V1 Nothing claims a SARS submission', lines, 'no VAT return or submission is marked as submitted');
}

export async function checkF1(tx: Tx, companyId: string): Promise<CheckResult> {
  const [r] = await tx.query<{ assets: string; gl: string }>(`
    SELECT (SELECT coalesce(sum(accumulated_depreciation), 0) FROM assets WHERE company_id = $1::uuid)::text AS assets,
      (SELECT coalesce(sum(jl.credit - jl.debit), 0) FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.company_id = $1::uuid AND je.status = 'posted' AND je.source = 'auto_depreciation'
          AND jl.gl_account_id IN (SELECT gl_depreciation_account_id FROM assets WHERE company_id = $1::uuid))::text AS gl`, [companyId]);
  return Number(r?.assets) === Number(r?.gl)
    ? pass('F1 Fixed assets tie', `accumulated depreciation ${r?.assets} on the assets and in the GL`)
    : judge('F1 Fixed assets tie', [`assets ${r?.assets} vs GL ${r?.gl}`], '');
}

export async function checkG(tx: Tx, companyId: string, win: Window): Promise<CheckResult[]> {
  const g1: string[] = [];
  for (const role of ['receivable', 'default_revenue', 'vat_output', 'payable', 'vat_input', 'default_expense']) {
    const [r] = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1::uuid AND is_system_account AND account_subtype = $2', [companyId, role]);
    if ((r?.n ?? 0) !== 1) g1.push(`${r?.n ?? 0} system ${role} accounts`);
  }
  const [x] = await tx.query<Record<string, number>>(`
    SELECT (SELECT count(*) FROM gl_accounts WHERE company_id = $1::uuid AND account_subtype = 'bank' AND is_active)::int AS banks,
      (SELECT count(*) FROM payroll_employees e WHERE e.company_id = $1::uuid AND e.status = 'active' AND e.pay_frequency = 'monthly'
         AND EXISTS (SELECT 1 FROM payroll_employee_components c WHERE c.employee_id = e.id))::int AS paid_staff,
      (SELECT count(*) FROM payroll_run_headers WHERE company_id = $1::uuid AND period_year = 2027 AND period_month = 2
         AND status NOT IN ('draft', 'calculated'))::int AS sandbox,
      (SELECT count(*) FROM payroll_run_headers WHERE company_id = $1::uuid AND status = 'calculated')::int AS calculated,
      (SELECT count(*) FROM vat_period_locks WHERE company_id = $1::uuid AND unlocked_at IS NULL
         AND $2::date BETWEEN period_start AND period_end)::int AS locks`, [companyId, win.today]);
  if ((x?.banks ?? 0) < 1) g1.push('no active bank account');
  if ((x?.paid_staff ?? 0) < 1) g1.push('no active monthly employee with a pay component');
  if ((x?.sandbox ?? 0) > 0) g1.push('a 2027-02 pay run past calculated (the golden payroll sandbox)');
  if ((x?.calculated ?? 0) > 0) g1.push(`${x!.calculated} pay run(s) left calculated`);
  if ((x?.locks ?? 0) > 0) g1.push('a VAT period lock covers today');
  const periods = await tx.query<{ d: string; status: string | null }>(`
    SELECT d::text, (SELECT status FROM fiscal_periods WHERE company_id = $1::uuid AND start_date <= d AND end_date >= d LIMIT 1) AS status
    FROM unnest(ARRAY[$2::date, '2027-02-15'::date]) AS d`, [companyId, win.today]);
  return [
    judge('G1 Deploy-gate preconditions', g1, 'system accounts, bank, staff, payroll sandbox and VAT locks as the golden suite needs'),
    { label: 'G2 Fiscal periods the golden suite posts into', status: 'info', lines: periods.map((p) => `${p.d}: ${p.status ?? 'NO PERIOD'}${p.status === 'open' ? '' : '  <-- needs a human'}`) },
  ];
}

export async function infoR(tx: Tx, companyId: string): Promise<CheckResult[]> {
  const r1: string[] = [];
  for (const t of PRESERVE_APPEND_ONLY) {
    const [r] = await tx.query<{ n: number; txt: string | null }>(
      `SELECT count(*)::int AS n, left(string_agg(to_jsonb(x)::text, ' '), 2000000) AS txt FROM ${t} x WHERE company_id = $1::uuid`, [companyId]);
    if ((r?.n ?? 0) > 0) r1.push(`${t}: ${r!.n} row(s), ${findDeniedNames(r!.txt ?? '').length} denylist term(s) in their text`);
  }
  const [pr] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM sars_submissions WHERE company_id = $1::uuid AND ${PRESERVED_SUBMISSION}`, [companyId]);
  if ((pr?.n ?? 0) > 0) r1.push(`sars_submissions preserved (named by tax_return_versions): ${pr!.n}`);
  const kept = await keptReport(tx, companyId);
  return [
    { label: 'R1 Residual (append-only)', status: 'info', lines: r1.length ? r1 : ['none'] },
    { label: 'R2 Kept tables with Demo rows', status: 'info', lines: kept.map((k) => `kept ${k.table}: ${k.n}`) },
  ];
}
