// tests/integration/statutory-filings-as-at.int.test.ts
//
// THE OVERDUE-FILINGS QUERY, AGAINST REAL ROWS.
//
// `statutoryFilingsService` lists the annual financial statements that were
// outstanding AS AT a board pack's date. Its unit tests stub `sql`, so they
// can only read the statement's text: nothing had ever run its predicate —
// the status filter, the `locked_at` comparison in South African time, the
// tenant scope — against a database. A predicate that parses and selects the
// wrong rows passes every one of them.
//
// Seeds two companies and one statement per case, and calls the real service.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposableDb, isDisposableDb } from '../helpers/assertDisposableDb';
import { getOverdueStatutoryFilings } from '@/modules/accounting/services/reports/statutoryFilingsService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY_A = '00000000-0000-0000-0000-0000005f0a01';
const COMPANY_B = '00000000-0000-0000-0000-0000005f0b01';

/** The date the pack reports to. */
const PACK_DATE = '2026-09-07';

interface Doc {
  company: string;
  fiscalYear: number | null;
  status: 'draft' | 'in_review' | 'partner_review' | 'signed_off' | 'filed';
  lockedAt: string | null;
  type?: 'afs' | 'management_pack';
}

// Company A's financial year starts in March, so FY N ends on the last day of
// February N and its statements fall due on 31 August N.
const DOCS: Doc[] = [
  // Never signed off: outstanding on any date after its deadline.
  { company: COMPANY_A, fiscalYear: 2024, status: 'draft', lockedAt: null },
  { company: COMPANY_A, fiscalYear: 2026, status: 'in_review', lockedAt: null },
  // Signed off BEFORE the pack date: not outstanding on it.
  { company: COMPANY_A, fiscalYear: 2023, status: 'signed_off', lockedAt: '2023-10-01T08:00:00Z' },
  // Signed off AFTER the pack date: still outstanding on it.
  { company: COMPANY_A, fiscalYear: 2025, status: 'signed_off', lockedAt: '2026-09-20T08:00:00Z' },
  // Signed off at 23:30 SAST ON the pack date (21:30 UTC): not after it.
  { company: COMPANY_A, fiscalYear: 2021, status: 'signed_off', lockedAt: '2026-09-07T21:30:00Z' },
  // Signed off at 00:30 SAST the day AFTER (22:30 UTC on the pack date): a UTC
  // comparison would call this the same day. In South Africa it is the 8th.
  { company: COMPANY_A, fiscalYear: 2020, status: 'signed_off', lockedAt: '2026-09-07T22:30:00Z' },
  // Filed, with no timestamp at all: cannot be dated, and stays out.
  { company: COMPANY_A, fiscalYear: 2022, status: 'filed', lockedAt: null },
  // Filed after having been signed off after the pack date.
  { company: COMPANY_A, fiscalYear: 2019, status: 'filed', lockedAt: '2026-09-15T08:00:00Z' },
  // Not an AFS: a management pack is not a statutory filing, even one that
  // names a fiscal year and was never signed off.
  { company: COMPANY_A, fiscalYear: 2017, status: 'draft', lockedAt: null, type: 'management_pack' },
  // An AFS row with no fiscal year has no deadline to be measured against.
  { company: COMPANY_A, fiscalYear: null, status: 'draft', lockedAt: null },
  // The other tenant: an unsigned FY2024 and an unsigned FY2018.
  { company: COMPANY_B, fiscalYear: 2024, status: 'draft', lockedAt: null },
  { company: COMPANY_B, fiscalYear: 2018, status: 'draft', lockedAt: null },
];

// Only on a throwaway database: this seeds whole companies. On a shared one
// (isaflow_dev) the suite skips rather than write to it.
const describeIfDb = isDisposableDb(DATABASE_URL) ? describe : describe.skip;

describeIfDb('overdue statutory filings, read from real rows as at the pack date', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertDisposableDb('This test inserts and deletes companies and AFS documents.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active, financial_year_start) VALUES
         ($1, 'Filings Fixture A', true, 3),
         ($2, 'Filings Fixture B', true, 1)`,
      [COMPANY_A, COMPANY_B],
    );
    for (const [index, doc] of DOCS.entries()) {
      await admin.query(
        `INSERT INTO afs_documents (company_id, fiscal_year, period, document_type, reporting_framework, status, locked_at)
         VALUES ($1, $2, $3, $4, 'ifrs_smes', $5, $6)`,
        [
          doc.company, doc.fiscalYear, doc.type === 'management_pack' ? `2026-0${index}` : null,
          doc.type ?? 'afs', doc.status, doc.lockedAt,
        ],
      );
    }
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  const yearsOf = async (company: string, asAt: string): Promise<number[]> =>
    (await getOverdueStatutoryFilings(company, asAt)).map((f) => f.fiscalYear).sort((a, b) => a - b);

  it('lists what was outstanding on the pack date, including statements signed off since', async () => {
    // 2024 and 2026 were never signed; 2019, 2020 and 2025 were signed AFTER
    // the pack date. 2021 was signed on it, 2023 before it, 2022 is undated.
    expect(await yearsOf(COMPANY_A, PACK_DATE)).toEqual([2019, 2020, 2024, 2025, 2026]);
  });

  it('reads the sign-off day in South African time, not UTC', async () => {
    const years = await yearsOf(COMPANY_A, PACK_DATE);
    // 22:30 UTC on the 7th is the 8th in Johannesburg: after the pack date.
    expect(years).toContain(2020);
    // 21:30 UTC on the 7th is still the 7th there: not after it.
    expect(years).not.toContain(2021);
  });

  it('drops each statement from the day after it was signed off', async () => {
    expect(await yearsOf(COMPANY_A, '2026-09-08')).toEqual([2019, 2024, 2025, 2026]);
    expect(await yearsOf(COMPANY_A, '2026-09-15')).toEqual([2024, 2025, 2026]);
    expect(await yearsOf(COMPANY_A, '2026-09-20')).toEqual([2024, 2026]);
  });

  it('never lists a statement that is signed off or filed with no date, or signed before', async () => {
    const years = await yearsOf(COMPANY_A, '2030-01-01');
    expect(years).toEqual([2024, 2026]);
  });

  it('states each deadline and the days overdue as at the pack date', async () => {
    const filings = await getOverdueStatutoryFilings(COMPANY_A, PACK_DATE);
    const byYear = new Map(filings.map((f) => [f.fiscalYear, f]));
    expect(byYear.get(2026)).toEqual({
      filingType: 'Annual Financial Statements', fiscalYear: 2026, deadline: '2026-08-31', daysOverdue: 7,
    });
    // FY2024 ended 29 February 2024, a leap year; due 31 August 2024.
    expect(byYear.get(2024)!.deadline).toBe('2024-08-31');
    expect(byYear.get(2024)!.daysOverdue).toBe(737);
    // Longest overdue first.
    expect(filings.map((f) => f.fiscalYear)).toEqual([2019, 2020, 2024, 2025, 2026]);
  });

  it('lists nothing before a deadline has passed', async () => {
    expect(await yearsOf(COMPANY_A, '2019-08-31')).toEqual([]);
    expect(await yearsOf(COMPANY_A, '2019-09-01')).toEqual([2019]);
  });

  it('keeps each company to its own statements and its own year end', async () => {
    // Company B's year starts in January: FY2024 ends 31 December 2024 and is
    // due 30 June 2025; FY2018 is due 30 June 2019.
    const b = await getOverdueStatutoryFilings(COMPANY_B, PACK_DATE);
    expect(b.map((f) => [f.fiscalYear, f.deadline])).toEqual([
      [2018, '2019-06-30'], [2024, '2025-06-30'],
    ]);
    // And none of B's reach A: A has no FY2018, and A's FY2024 is due in August.
    const a = await getOverdueStatutoryFilings(COMPANY_A, PACK_DATE);
    expect(a.map((f) => f.fiscalYear)).not.toContain(2018);
    expect(a.find((f) => f.fiscalYear === 2024)!.deadline).toBe('2024-08-31');
  });

  it('answers nothing for a company that does not exist', async () => {
    expect(await getOverdueStatutoryFilings('00000000-0000-0000-0000-0000005f0c01', PACK_DATE)).toEqual([]);
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM afs_documents WHERE company_id = ANY($1)', [[COMPANY_A, COMPANY_B]]);
  await admin.query('DELETE FROM companies WHERE id = ANY($1)', [[COMPANY_A, COMPANY_B]]);
}
