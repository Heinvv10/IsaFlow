/**
 * What a Golden Paths slot must hold, read from the database. The preconditions are the ones the suite itself relies
 * on: tests/e2e/golden-paths/_global-setup.ts (six system accounts), h-payroll-run (employees, an open Feb 2027 with no
 * run in it), f-bank-import-reconcile (a bank account), the close-agent specs (a second open 2027 period).
 */
import type { ClientBase } from 'pg';

export const REQUIRED_SYSTEM_SUBTYPES = ['receivable', 'default_revenue', 'vat_output', 'payable', 'vat_input', 'default_expense'] as const;
/** The payroll sandbox month (tests/e2e/golden-paths/_api.ts PAYROLL_SANDBOX_MONTH). */
const SANDBOX = { year: 2027, month: 2 } as const;

export interface SlotReport {
  companyId: string;
  systemAccounts: Record<string, number>;
  employees: number;
  bankAccounts: number;
  open2027Periods: number;
  sandboxPeriodOpen: boolean;
  payrollRunsInSandboxMonth: number;
  members: number;
}

export async function readSlotReport(db: ClientBase, companyId: string): Promise<SlotReport> {
  const count = async (sql: string): Promise<number> => Number((await db.query<{ n: string }>(sql, [companyId])).rows[0]!.n);
  const system = await db.query<{ account_subtype: string; n: string }>(
    `SELECT account_subtype, count(*) AS n FROM gl_accounts WHERE company_id = $1::uuid AND is_system_account GROUP BY 1`, [companyId]);
  return {
    companyId,
    systemAccounts: Object.fromEntries(REQUIRED_SYSTEM_SUBTYPES.map((s) => [s, Number(system.rows.find((r) => r.account_subtype === s)?.n ?? 0)])),
    employees: await count(`SELECT count(*) AS n FROM payroll_employees WHERE company_id = $1::uuid`),
    bankAccounts: await count(`SELECT count(*) AS n FROM gl_accounts WHERE company_id = $1::uuid AND account_subtype = 'bank'`),
    open2027Periods: await count(`SELECT count(*) AS n FROM fiscal_periods WHERE company_id = $1::uuid AND status = 'open' AND start_date >= '2027-01-01' AND start_date < '2028-01-01'`),
    sandboxPeriodOpen: (await count(`SELECT count(*) AS n FROM fiscal_periods WHERE company_id = $1::uuid AND status = 'open' AND start_date <= '2027-02-28' AND end_date >= '2027-02-01'`)) > 0,
    payrollRunsInSandboxMonth: await count(`SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1::uuid AND period_year = ${SANDBOX.year} AND period_month = ${SANDBOX.month}`),
    members: await count(`SELECT count(*) AS n FROM company_users WHERE company_id = $1::uuid`),
  };
}

/**
 * One message per precondition the suite would trip over; empty means the slot is usable.
 * @param fresh the company was created by this run: only then must the sandbox month hold no payroll run (a slot the
 *   suite has used keeps its reopened run there, and the spec reuses it)
 */
export function slotProblems(r: SlotReport, fresh: boolean): string[] {
  const out: string[] = [];
  const missing = REQUIRED_SYSTEM_SUBTYPES.filter((s) => !r.systemAccounts[s]);
  if (missing.length) out.push(`no system account for ${missing.join(', ')}`);
  if (r.employees < 1) out.push('no payroll employees (h-payroll-run needs one)');
  if (r.bankAccounts < 1) out.push('no bank account (f-bank-import-reconcile needs one)');
  if (!r.sandboxPeriodOpen) out.push('the payroll sandbox period 2027-02 is not open');
  if (r.open2027Periods < 2) out.push('fewer than two open 2027 periods (the sandbox month is reserved; the close specs need another)');
  if (fresh && r.payrollRunsInSandboxMonth > 0) out.push(`${r.payrollRunsInSandboxMonth} payroll run(s) already in the sandbox month 2027-02, which must start empty`);
  if (r.members !== 1) out.push(`${r.members} members; a slot has exactly one, its golden user`);
  return out;
}

export function formatSlotReport(label: string, r: SlotReport): string {
  const sys = REQUIRED_SYSTEM_SUBTYPES.map((s) => `${s}=${r.systemAccounts[s]}`).join(' ');
  return `${label} ${r.companyId}: system accounts [${sys}], employees ${r.employees}, bank accounts ${r.bankAccounts}, `
    + `open 2027 periods ${r.open2027Periods} (2027-02 open: ${r.sandboxPeriodOpen}), payroll runs in 2027-02: ${r.payrollRunsInSandboxMonth}, members ${r.members}`;
}
