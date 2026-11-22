/**
 * vat_displayed_differs_from_posted: behaviour, and the plan it runs under.
 *
 * Production incident 2026-11-21 (Bugsink 0e7c6050): the check hit
 * `canceling statement due to statement timeout` for a tenant imported a couple
 * of hours earlier. Postgres had no statistics for the new company_id, so under
 * the tenant-isolation policy (`company_id IN (SELECT auth.user_companies())`)
 * it estimated ONE row on every table, chose nested loops that filter on the
 * join keys instead of using their indexes, and so ran bank_transactions x
 * gl_journal_lines x gl_journal_lines once per VAT line.
 *
 * Two things are pinned here:
 *   1. the rewrite returns exactly what the old two-statement query returned
 *      (count, amount and the sample rows, with and without a limit);
 *   2. it finishes quickly for a company the planner has never seen, as the app
 *      role, with RLS on. That is the half that fails on the old query.
 *
 * Every row lives inside BEGIN ... ROLLBACK on one client.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getPoolForTests, sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { vatDisplayedDiffersFromPosted } from '@/modules/accounting/services/gl/integrityChecks/vatChecks';
import type { IntegrityCheckContext } from '@/modules/accounting/services/gl/integrityChecks/types';

const AS_AT = '2026-09-30';
const USER = '00000000-0000-0000-0000-0000000000bb';

type Ctx = Parameters<typeof als.run>[0];
const ctxFor = (client: PoolClient, companyId: string): Ctx =>
  ({ client, userId: USER, companyId, claims: {} } as unknown as Ctx);

/** The query this check ran before the fix, verbatim, with a tie-break on bt.id so two runs are comparable. */
async function legacy(companyId: string, limit: number) {
  const where = sql`
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_lines vl ON vl.journal_entry_id = jl.journal_entry_id AND vl.company_id = bt.company_id
    JOIN gl_accounts ga ON ga.id = vl.gl_account_id AND ga.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.transaction_date <= ${AS_AT}::DATE
      AND ga.account_subtype = ANY(ARRAY['vat_input', 'vat_output']::TEXT[])
      AND ABS(vl.debit - vl.credit) > 0.005
      AND COALESCE(bt.suggested_vat_code, 'no_vat') = 'no_vat'
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(vl.debit - vl.credit)), 0) AS amount ${where}
  `) as DbRow[];
  const rows = (await sql`
    SELECT bt.id::TEXT AS id,
           COALESCE(NULLIF(bt.reference, ''), bt.bank_reference, LEFT(COALESCE(bt.description, ''), 60)) AS label,
           ABS(vl.debit - vl.credit) AS amount,
           'displayed "' || COALESCE(bt.suggested_vat_code, 'No VAT')
             || '" but posted ' || ga.account_code || ' ' || ga.account_name AS detail
    ${where}
    ORDER BY ABS(vl.debit - vl.credit) DESC, bt.id
    LIMIT ${limit}
  `) as DbRow[];
  return {
    count: Number(totals[0]?.count),
    amount: Math.round(Number(totals[0]?.amount) * 100) / 100,
    sample: rows.map((r) => ({
      id: String(r.id), label: String(r.label), amount: Math.round(Number(r.amount) * 100) / 100, detail: String(r.detail),
    })),
  };
}

interface Accounts { bank: string; vatIn: string; vatOut: string; opex: string }

async function seedCompany(client: PoolClient, name: string): Promise<{ companyId: string; acct: Accounts }> {
  const { rows: [co] } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name],
  );
  const companyId = co!.id;
  const account = async (code: string, accName: string, type: string, subtype: string): Promise<string> => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [companyId, code, accName, type, subtype, type === 'asset' || type === 'expense' ? 'debit' : 'credit'],
    );
    return rows[0]!.id;
  };
  return {
    companyId,
    acct: {
      bank: await account('1000', 'Bank', 'asset', 'bank'),
      vatIn: await account('1200', 'VAT Input', 'asset', 'vat_input'),
      vatOut: await account('2200', 'VAT Output', 'liability', 'vat_output'),
      opex: await account('6000', 'Office Costs', 'expense', 'operating_expense'),
    },
  };
}

/** One journal (status draft: the check does not read status, and posted journals fire balance triggers per line). */
async function journal(
  client: PoolClient, companyId: string, no: string, date: string,
  lines: Array<[string, number, number]>,
): Promise<{ jeId: string; lineIds: string[] }> {
  const { rows: [je] } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     VALUES ($1,$2,$3,$5,'auto_bank_recon','draft',$4) RETURNING id`,
    // $2 must not double as the description: one parameter, one deduced type.
    [companyId, no, date, USER, no],
  );
  const lineIds: string[] = [];
  for (const [acct, debit, credit] of lines) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, je!.id, acct, debit, credit],
    );
    lineIds.push(rows[0]!.id);
  }
  return { jeId: je!.id, lineIds };
}

async function bankTx(
  client: PoolClient, companyId: string, bankAcct: string, ref: string, date: string,
  matched: string | null, vatCode: string | null, description = ref,
) {
  await client.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
       reference, status, matched_journal_line_id, suggested_vat_code)
     VALUES ($1,$2,$3,-100,$4,$5,'imported',$6,$7)`,
    [companyId, bankAcct, date, description, ref, matched, vatCode],
  );
}

/** Every shape the predicate has to get right, with distinct amounts so ordering is unambiguous. */
async function seedEdgeCases(client: PoolClient): Promise<string> {
  const { companyId, acct } = await seedCompany(client, 'VAT plan fixture');
  const a = acct;
  // 15.00 of input VAT, NULL code (how production rows look).
  const j1 = await journal(client, companyId, 'J1', '2026-06-10', [[a.opex, 100, 0], [a.vatIn, 15, 0], [a.bank, 0, 115]]);
  await bankTx(client, companyId, a.bank, 'BT-NULL', '2026-06-09', j1.lineIds[2]!, null);
  // Two VAT lines in one journal: one bank transaction yields TWO rows (30 and 20.50).
  const j2 = await journal(client, companyId, 'J2', '2026-06-11', [
    [a.opex, 100, 0], [a.vatIn, 30, 0], [a.vatOut, 0, 20.5], [a.bank, 0, 109.5],
  ]);
  await bankTx(client, companyId, a.bank, 'BT-TWO-VAT', '2026-06-11', j2.lineIds[3]!, 'no_vat');
  // The code says standard: displayed and posted agree, excluded.
  const j3 = await journal(client, companyId, 'J3', '2026-06-12', [[a.opex, 100, 0], [a.vatIn, 99.99, 0], [a.bank, 0, 199.99]]);
  await bankTx(client, companyId, a.bank, 'BT-STANDARD', '2026-06-12', j3.lineIds[2]!, 'standard');
  // Dated after as_at, excluded.
  const j4 = await journal(client, companyId, 'J4', '2026-10-05', [[a.opex, 100, 0], [a.vatIn, 77, 0], [a.bank, 0, 177]]);
  await bankTx(client, companyId, a.bank, 'BT-LATE', '2026-10-05', j4.lineIds[2]!, null);
  // A VAT line with no amount (debit and credit both 0), excluded. The columns are numeric(15,2),
  // so the 0.005 floor in the SQL cannot be told from `> 0` by any stored value.
  const j5 = await journal(client, companyId, 'J5', '2026-06-13', [[a.opex, 100, 0], [a.vatIn, 0, 0], [a.bank, 0, 100]]);
  await bankTx(client, companyId, a.bank, 'BT-ZERO-VAT', '2026-06-13', j5.lineIds[2]!, null);
  // Not matched to any journal line, excluded.
  await bankTx(client, companyId, a.bank, 'BT-UNMATCHED', '2026-06-14', null, null);
  // A journal with no VAT line at all, excluded.
  const j6 = await journal(client, companyId, 'J6', '2026-06-15', [[a.opex, 100, 0], [a.bank, 0, 100]]);
  await bankTx(client, companyId, a.bank, 'BT-NO-VAT-LINE', '2026-06-15', j6.lineIds[1]!, null);
  // One more hit, dated exactly on as_at (the boundary is inclusive); empty reference so the label falls back to the description.
  const j7 = await journal(client, companyId, 'J7', '2026-06-16', [[a.opex, 100, 0], [a.vatIn, 7.25, 0], [a.bank, 0, 107.25]]);
  await bankTx(client, companyId, a.bank, '', AS_AT, j7.lineIds[2]!, null, 'only a description');
  // The VAT-bearing journal belongs to ANOTHER company, whose own bank transaction is its hit, not ours.
  const other = await seedCompany(client, 'VAT plan other tenant');
  const jo = await journal(client, other.companyId, 'JO', '2026-06-10', [
    [other.acct.opex, 100, 0], [other.acct.vatIn, 500, 0], [other.acct.bank, 0, 600],
  ]);
  await bankTx(client, other.companyId, other.acct.bank, 'BT-OTHER', '2026-06-10', jo.lineIds[2]!, null);
  return companyId;
}

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  assertNotProductionDb('This test inserts rows (rolled back).');
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

const ctxOf = (companyId: string, limit: number): IntegrityCheckContext => ({ companyId, asAt: AS_AT, limit });

describe('vat_displayed_differs_from_posted: same answer as the query it replaces', () => {
  it.each([1, 2, 3, 100])('matches the old query exactly at limit %i', async (limit) => {
    await withTx(async (client) => {
      const companyId = await seedEdgeCases(client);
      await als.run(ctxFor(client, companyId), async () => {
        const before = await legacy(companyId, limit);
        const after = await vatDisplayedDiffersFromPosted(ctxOf(companyId, limit));
        expect(before.count).toBe(4);
        expect(before.amount).toBe(72.75);
        expect({ count: after.count, amount: after.amount, sample: after.sample }).toEqual(before);
      });
    });
  });

  it('reports zero, not null, when nothing fails', async () => {
    await withTx(async (client) => {
      const { companyId } = await seedCompany(client, 'VAT plan empty');
      await als.run(ctxFor(client, companyId), async () => {
        const after = await vatDisplayedDiffersFromPosted(ctxOf(companyId, 20));
        expect(after).toMatchObject({ id: 'vat_displayed_differs_from_posted', count: 0, amount: 0, sample: [] });
      });
    });
  });
});

/** A tenant of the size that timed out in production: 1,546 matched bank transactions, ~5,000 lines, 150 accounts. */
async function seedUnseenTenant(client: PoolClient, name: string): Promise<{ companyId: string; expected: number }> {
  const { companyId, acct } = await seedCompany(client, name);
  await client.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance)
     SELECT $1, (7000 + g)::text, 'Expense ' || g, 'expense', 'operating_expense', 'debit' FROM generate_series(1, 146) g`,
    [companyId],
  );
  await client.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by)
     SELECT $1, 'U' || g, DATE '2026-01-01' + (g % 200), 'unseen ' || g, 'auto_bank_recon', 'draft', $2
     FROM generate_series(1, 2100) g`,
    [companyId, USER],
  );
  // Journals 1..1546 are bank-matched: bank + expense, plus a VAT line on every ninth.
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 0, 115 FROM gl_journal_entries je
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT <= 1546`,
    [companyId, acct.bank],
  );
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 100, 0 FROM gl_journal_entries je WHERE je.company_id = $1`,
    [companyId, acct.opex],
  );
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 15 + (n % 7), 0
     FROM (SELECT id, substring(entry_number from 2)::INT AS n FROM gl_journal_entries WHERE company_id = $1) je
     WHERE je.n <= 1546 AND je.n % 9 = 0`,
    [companyId, acct.vatIn],
  );
  // Filler lines on the 554 non-bank journals.
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     SELECT $1, je.id, $2, 0, 100 FROM gl_journal_entries je
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT > 1546`,
    [companyId, acct.bank],
  );
  await client.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description,
       reference, status, matched_journal_line_id, suggested_vat_code)
     SELECT $1, $2, DATE '2026-01-01' + (substring(je.entry_number from 2)::INT % 200), -115, 'tx', 'ref-' || je.entry_number,
            'imported', jl.id, NULL
     FROM gl_journal_entries je
     JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.gl_account_id = $2
     WHERE je.company_id = $1 AND substring(je.entry_number from 2)::INT <= 1546`,
    [companyId, acct.bank],
  );
  return { companyId, expected: Math.floor(1546 / 9) };
}

describe('vat_displayed_differs_from_posted: a tenant the planner has never seen', () => {
  it('finishes in seconds as the app role under row-level security', async () => {
    await withTx(async (client) => {
      // Decoy tenants first, then ANALYZE (transactional: rolled back with the rest), so statistics
      // exist for the tables but know nothing about the company seeded after.
      for (let i = 0; i < 3; i++) await seedUnseenTenant(client, `VAT plan decoy ${i}`);
      await client.query('ANALYZE bank_transactions');
      await client.query('ANALYZE gl_journal_lines');
      await client.query('ANALYZE gl_accounts');
      const { companyId, expected } = await seedUnseenTenant(client, 'VAT plan unseen tenant');
      await client.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')`, [companyId, USER]);

      await client.query(`SET LOCAL statement_timeout = '20s'`);
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USER, role: 'authenticated', company_id: companyId })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);

      await als.run(ctxFor(client, companyId), async () => {
        const started = Date.now();
        const result = await vatDisplayedDiffersFromPosted(ctxOf(companyId, 20));
        const elapsed = Date.now() - started;
        expect(result.count).toBe(expected);
        expect(result.sample).toHaveLength(20);
        expect(elapsed).toBeLessThan(5000);
      });
    });
  }, 60_000);
});
