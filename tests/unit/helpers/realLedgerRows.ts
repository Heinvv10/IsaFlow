/**
 * Real-row builders for the unit-db ledger fixtures.
 *
 * WHY. These suites used to shadow `companies`, `fiscal_periods`, `gl_accounts`,
 * `gl_journal_entries` and `gl_journal_lines` with connection-local TEMP tables.
 * The fiscal-year registry's SQL functions (migration 940) pin
 * `search_path = pg_catalog, public, pg_temp`, so they read the REAL public
 * tables and never saw the temp world ("fiscal_year_template: company ... not
 * found"). The world is now built from real rows, inside one transaction the
 * caller ALWAYS rolls back, so the real triggers and constraints run on it.
 *
 * Every builder uses the `sql` tag, so it writes through the AsyncLocalStorage
 * client of the caller's transaction (see `als.run` in the fixtures).
 */
import { sql } from '@/lib/neon';

/** [gl account id, debit, credit] */
export type JournalLine = [account: string, debit: number, credit: number];

const NIL_USER = '00000000-0000-4000-8000-000000000000';

export async function insertCompany(id: string, financialYearStart: number | null, name = 'Fixture'): Promise<void> {
  await sql`INSERT INTO companies (id, name, financial_year_start)
    VALUES (${id}::uuid, ${name}, ${financialYearStart})`;
}

/**
 * A real fiscal period. fiscal_year_id is left NULL: trigger fiscal_periods_link_year
 * links it to the stored year holding it, creating the template year when none does
 * (an unusable financial_year_start gets the March read default and is flagged assumed).
 * The period must lie inside one financial year and overlap no other period of the company.
 */
export async function insertPeriod(id: string, companyId: string, start: string, end: string): Promise<void> {
  await sql`INSERT INTO fiscal_periods (id, company_id, period_name, period_number, fiscal_year, start_date, end_date)
    VALUES (${id}::uuid, ${companyId}::uuid, ${`P ${start}`}, EXTRACT(MONTH FROM ${start}::date)::int,
      EXTRACT(YEAR FROM ${start}::date)::int, ${start}::date, ${end}::date)`;
}

export async function insertAccount(
  id: string, companyId: string, code: string, name: string,
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense', normal: 'debit' | 'credit',
): Promise<void> {
  await sql`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance)
    VALUES (${id}::uuid, ${companyId}::uuid, ${code}, ${name}, ${type}, ${normal})`;
}

export async function insertBusinessUnit(id: string, companyId: string, code: string): Promise<void> {
  await sql`INSERT INTO business_units (id, company_id, code, name)
    VALUES (${id}::uuid, ${companyId}::uuid, ${code}, ${`BU ${code}`})`;
}

export async function insertCostCentre(id: string, companyId: string, code: string): Promise<void> {
  await sql`INSERT INTO cost_centres (id, company_id, code, name)
    VALUES (${id}::uuid, ${companyId}::uuid, ${code}, ${`CC ${code}`})`;
}

export interface FixtureJournal {
  id: string;
  companyId: string;
  date: string;
  lines: JournalLine[];
  /** Unique per company (uq_gl_je_company_entry_number). */
  entryNumber: string;
  /** 'draft' stays a draft; 'posted' (default) is posted after its lines exist. */
  status?: 'draft' | 'posted';
  description?: string;
  /** Omitted: the column default (now()). null: stored NULL, to exercise the ordering tie-break. */
  createdAt?: string | null;
}

/**
 * A journal built the way the application builds one: a draft header, its lines, then the
 * UPDATE to 'posted' (trigger enforce_balanced_entry checks the lines at that UPDATE, so the
 * header cannot come after them). fiscal_period_id is left NULL: trigger
 * gl_je_fiscal_period_from_date derives the period holding entry_date (NULL if none does).
 */
export async function insertJournal(j: FixtureJournal): Promise<void> {
  const description = j.description ?? 'Fixture';
  if (j.createdAt === undefined) {
    await sql`INSERT INTO gl_journal_entries (id, company_id, status, entry_date, entry_number, description,
        reference, source, created_by)
      VALUES (${j.id}::uuid, ${j.companyId}::uuid, 'draft', ${j.date}::date, ${j.entryNumber}, ${description},
        '', 'manual', ${NIL_USER}::uuid)`;
  } else {
    await sql`INSERT INTO gl_journal_entries (id, company_id, status, entry_date, entry_number, description,
        reference, source, created_at, created_by)
      VALUES (${j.id}::uuid, ${j.companyId}::uuid, 'draft', ${j.date}::date, ${j.entryNumber}, ${description},
        '', 'manual', ${j.createdAt}::timestamptz, ${NIL_USER}::uuid)`;
  }
  for (const [account, debit, credit] of j.lines) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${j.companyId}::uuid, ${j.id}::uuid, ${account}::uuid, ${debit}, ${credit})`;
  }
  if ((j.status ?? 'posted') === 'posted') {
    await sql`UPDATE gl_journal_entries SET status = 'posted' WHERE id = ${j.id}::uuid`;
  }
}
