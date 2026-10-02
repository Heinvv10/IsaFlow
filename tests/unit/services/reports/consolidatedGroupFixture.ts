/**
 * A two-member group in connection-local temp tables, rolled back — the brk-d4
 * consolidated harness (agents/brk-d4/brkD4Consolidated.test.ts), shared by
 * consolidatedTrialBalanceFiscalYearDb. Members A and B, five accounts each
 * mapped to group accounts G1000 bank, G1600 inventory, G3000 capital,
 * G4000 revenue, G5000 expense; eliminations are posted consolidation_adjustments.
 */
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';

export const GROUP = '80000000-0000-4000-8000-000000000001';
export const A = '10000000-0000-4000-8000-0000000000a1';
export const B = '10000000-0000-4000-8000-0000000000a2';
export const G = { bank: '81000000-0000-4000-8000-000000000001', rev: '81000000-0000-4000-8000-000000000002',
  exp: '81000000-0000-4000-8000-000000000003', inv: '81000000-0000-4000-8000-000000000004',
  cap: '81000000-0000-4000-8000-000000000005' };
const acct = (co: string, code: string) => `5${co.slice(-2)}00000-0000-4000-8000-00000000${code}`;
export const CODES: Array<[string, string, 'debit' | 'credit', keyof typeof G]> = [
  ['1000', 'asset', 'debit', 'bank'], ['1600', 'asset', 'debit', 'inv'], ['3000', 'equity', 'credit', 'cap'],
  ['4000', 'revenue', 'credit', 'rev'], ['5000', 'expense', 'debit', 'exp'],
];

export type J = [string, string, Array<[string, number, number]>]; // company, date, [code, dr, cr]
export type Adj = [string, string, Array<[keyof typeof G, number, number]>];

export async function withGroup(fyA: number, fyB: number, journals: J[], adjustments: Adj[], periods: Array<[string, string, string, string]>, run: () => Promise<void>) {
  assertNotProductionDb('brk-d4 consolidated');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: A, userId: '', claims: {} }, async () => {
      await sql`CREATE TEMP TABLE companies (id uuid, name text, financial_year_start int) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE fiscal_periods (id uuid, company_id uuid, start_date date, end_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_accounts (id uuid, company_id uuid, account_code text, account_name text,
        account_type text, normal_balance text, account_subtype text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_entries (id uuid, company_id uuid, status text, entry_date date,
        entry_number text, description text, reference text, source text, created_at timestamptz) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE gl_journal_lines (id uuid DEFAULT gen_random_uuid(), company_id uuid,
        journal_entry_id uuid, gl_account_id uuid, debit numeric, credit numeric, cost_center_id uuid,
        cc1_id uuid, cc2_id uuid, bu_id uuid, project_id uuid) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE company_group_members (group_id uuid, company_id uuid, ownership_pct numeric,
        consolidation_method text, is_holding boolean, left_date date) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE group_accounts (id uuid, account_code text, account_name text, account_type text, normal_balance text) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE group_coa_mappings (group_id uuid, company_id uuid, company_account_id uuid, group_account_id uuid) ON COMMIT DROP`;
      await sql`CREATE TEMP TABLE consolidation_adjustments (group_id uuid, status text, period_start date, period_end date, lines jsonb) ON COMMIT DROP`;
      await sql`INSERT INTO companies VALUES (${A}::uuid, 'Alpha', ${fyA}), (${B}::uuid, 'Beta', ${fyB})`;
      await sql`INSERT INTO company_group_members VALUES (${GROUP}::uuid, ${A}::uuid, 100, 'full', true, NULL), (${GROUP}::uuid, ${B}::uuid, 100, 'full', false, NULL)`;
      for (const [k, id] of Object.entries(G)) {
        const c = CODES.find(x => x[3] === k)!;
        await sql`INSERT INTO group_accounts VALUES (${id}::uuid, ${'G' + c[0]}, ${'Group ' + k}, ${c[1]}, ${c[2]})`;
      }
      for (const co of [A, B]) {
        for (const [code, type, nb, g] of CODES) {
          await sql`INSERT INTO gl_accounts VALUES (${acct(co, code)}::uuid, ${co}::uuid, ${code}, ${code}, ${type}, ${nb}, NULL)`;
          await sql`INSERT INTO group_coa_mappings VALUES (${GROUP}::uuid, ${co}::uuid, ${acct(co, code)}::uuid, ${G[g]}::uuid)`;
        }
      }
      for (const [id, co, s, e] of periods) {
        await sql`INSERT INTO fiscal_periods VALUES (${id}::uuid, ${co}::uuid, ${s}::date, ${e}::date)`;
      }
      for (const [n, [co, date, lines]] of journals.entries()) {
        const je = `40000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
        await sql`INSERT INTO gl_journal_entries VALUES (${je}::uuid, ${co}::uuid, 'posted', ${date}::date, ${String(n)}, 'x', '', 'manual', ${date}::timestamptz)`;
        for (const [code, d, c] of lines) {
          await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
            VALUES (${co}::uuid, ${je}::uuid, ${acct(co, code)}::uuid, ${d}, ${c})`;
        }
      }
      for (const [s, e, lines] of adjustments) {
        const js = JSON.stringify(lines.map(([g, debit, credit]) => ({ groupAccountId: G[g], debit, credit })));
        await sql`INSERT INTO consolidation_adjustments VALUES (${GROUP}::uuid, 'posted', ${s}::date, ${e}::date, ${js}::jsonb)`;
      }
      await run();
    });
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

export const net = (row: { consolidatedDebit: number; consolidatedCredit: number } | undefined) =>
  row ? Math.round((row.consolidatedCredit - row.consolidatedDebit) * 100) / 100 : 0;
