// Shared fixture of the cash flow adversarial suites (disposals / cards and parity / tie-out): one fresh company and a second
// one, every scenario inside BEGIN ... ROLLBACK on one client bound through ALS so nothing persists between cases.
import { afterAll, beforeAll, describe } from 'vitest';
import { assertDisposableDb } from '../../helpers/assertDisposableDb';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { getIndirectCashFlow, type IndirectCashFlow } from '@/modules/accounting/services/reports/cashFlowIndirectService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';

export const CO = randomUUID();
export const OTHER_CO = randomUUID();
/** A hand-made "Long-term Loans" (2210) with NO subtype: a liability with none reads as current (a known limit; 958 fixes the seeded one). */
export const LT_LOANS_2210 = randomUUID();
export const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

/** Call once at the top of a suite file: creates both companies before the file's tests and removes them after. */
export function installCompanies(): void {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    assertDisposableDb('This test creates and deletes companies and accounts.');
    for (const c of [CO, OTHER_CO]) await pool.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)`, [c, `CF adv ${c.slice(0, 6)}`]);
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance) VALUES ($1,$2,'2210','Long-term Loans','liability',NULL,'credit')`, [LT_LOANS_2210, CO]);
  }, 60_000);
  afterAll(async () => {
    try {
      for (const c of [CO, OTHER_CO]) {
        await pool.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM gl_accounts WHERE company_id = $1', [c]);
        await pool.query('DELETE FROM companies WHERE id = $1', [c]);
      }
    } finally { await pool.end(); }
  });
}

export type Ctx = { c: PoolClient; acct: (t: string, s: string | null, nb?: string, parent?: string) => Promise<string>;
  j: (date: string, legs: Array<[string, number, number]>, o?: { status?: string; source?: string; co?: string }) => Promise<string> };

export async function inTx<T>(fn: (x: Ctx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  await c.query('BEGIN');
  try {
    const acct: Ctx['acct'] = async (t, s, nb, parent) => {
      const id = randomUUID();
      await c.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, parent_account_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, CO, `ADV${id.slice(0, 8)}`, `ADV ${t} ${s}`, t, s,
        nb ?? (['asset', 'expense'].includes(t) ? 'debit' : 'credit'), parent ?? null]);
      return id;
    };
    const j: Ctx['j'] = async (date, legs, o = {}) => {
      const co = o.co ?? CO;
      const e = await c.query(`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by)
        VALUES ($1,$2,$3,'adv1156','draft',$4,$1) RETURNING id`, [co, `ADV-${randomUUID().slice(0, 8)}`, date, o.source ?? 'manual']);
      for (const [a, dr, cr] of legs) await c.query(`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)`, [co, e.rows[0].id, a, dr, cr]);
      if ((o.status ?? 'posted') === 'posted') await c.query(`UPDATE gl_journal_entries SET status='posted' WHERE id=$1`, [e.rows[0].id]);
      return e.rows[0].id as string;
    };
    return await als.run({ client: c, userId: CO, companyId: CO, claims: {} } as never, () => fn({ c, acct, j }));
  } finally { await c.query('ROLLBACK'); c.release(); }
}

export const line = (r: IndirectCashFlow, label: string) => r.sections.flatMap((s) => s.items).find((i) => i.label === label)?.amount ?? 0;
export const sec = (r: IndirectCashFlow, name: string) => r.sections.find((s) => s.section.startsWith(name))!.total;
export async function tie(start: string, end: string) {
  const ind = await getIndirectCashFlow(CO, start, end);
  const gl = (await getCashBalance(CO, end)).total;
  const dir = await getCashFlowDirect(CO, start, end);
  return { ind, gl, dir };
}
export const P = ['2026-11-01', '2026-11-30'] as const;
