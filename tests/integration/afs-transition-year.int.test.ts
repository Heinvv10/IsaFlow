/**
 * Feature D: AFS for a transition year, on real PostgreSQL. A company changes
 * its year end from December to February (the real service), so FY2026 is the
 * 14 months 1 January 2026 - 28 February 2027 and FY2028 the year after.
 * The statements say "for the 14 months ended", the comparative columns say
 * what they cover, an IAS 1.36 note discloses the reason and that the amounts
 * are not entirely comparable, and the filing deadline runs from the real year
 * end. All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { generateIncomeStatement } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { generateStatementOfFinancialPosition } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/balanceSheet';
import { generateCover } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/cover';
import { getReportingPeriod } from '@/modules/accounting/services/afs/afsReportingPeriod';
import { afsFilingDeadline } from '@/modules/accounting/services/afs/afsFilingDeadline';
import { generateDisclosureNotes } from '@/modules/accounting/services/reports/disclosureNoteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const co = crypto.randomUUID(), user = crypto.randomUUID();
const REASON = 'Aligned with the holding company year end';

async function inTx<T>(fn: () => Promise<T>, commit = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId: co, userId: user, claims: {} } as never, fn);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

type Block = { type: string; text?: string; headers?: string[] };
const blocks = (c: { content: { blocks: unknown[] } }) => c.content.blocks as Block[];
const texts = (c: { content: { blocks: unknown[] } }) => blocks(c).filter((b) => b.type === 'paragraph').map((b) => b.text);
const headers = (c: { content: { blocks: unknown[] } }) => blocks(c).find((b) => b.type === 'table')?.headers;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [user, `${user}@test.local`]);
  await pool.query(`INSERT INTO companies (id, name, financial_year_start) VALUES ($1, 'FYAFS co', 1)`, [co]);
  await pool.query('SELECT public.seed_company_afs_statement_lines($1)', [co]);
  await inTx(async () => {
    await generateFiscalYearForDate(co, '2025-05-01');
    await generateFiscalYearForDate(co, '2026-05-01');
    await applyYearEndChange(co, user, { newYearEndMonth: 2, reason: REASON, cipcFiledConfirmed: true, sarsNotifiedConfirmed: true }, '2026-10-23');
  }, true);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM afs_statement_lines WHERE company_id = $1', [co]);
    await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co]).catch(() => undefined); // audit/change rows are append-only
  } finally { await pool.end(); }
});

describe('the transition year FY2026 (14 months)', () => {
  it('reporting period: 14 months, comparative is the 12-month FY2025, not comparable', async () => {
    const p = await inTx(() => getReportingPeriod(co, 2026));
    expect(p.current).toMatchObject({ start: '2026-01-01', end: '2027-02-28', months: 14, phrase: '14 months ended 2027-02-28' });
    expect(p.prior).toMatchObject({ start: '2025-01-01', end: '2025-12-31', months: 12, phrase: 'year ended 2025-12-31' });
    expect(p.comparable).toBe(false);
    expect(p.comparabilityNote).toContain(REASON);
    expect(p.comparabilityNote).toContain('not entirely comparable (IAS 1.36)');
  });

  it('income statement: heading, column headers and the note', async () => {
    const is = await inTx(() => generateIncomeStatement(co, 2026, 'ifrs_sme' as never));
    expect(texts(is)[0]).toBe('For the 14 months ended 2027-02-28.');
    expect(texts(is).join(' ')).toMatch(/cover the 14 months from 2026-01-01 to 2027-02-28.*IAS 1\.36/);
    expect(headers(is)).toEqual(['Line', '14 months to 2027-02-28 (R)', 'Prior year (R)']);
  });

  it('balance sheet: as-at columns at the two real year ends, with the note', async () => {
    const bs = await inTx(() => generateStatementOfFinancialPosition(co, 2026, 'ifrs_sme' as never));
    expect(headers(bs)).toEqual(['Line', 'As at 2027-02-28 (R)', 'As at 2025-12-31 (R)']);
    expect(texts(bs).join(' ')).toMatch(/IAS 1\.36/);
  });

  it('cover says 14 months; the filing deadline is six months after 28 February 2027', async () => {
    expect(texts(await inTx(() => generateCover(co, 2026, 'ifrs_sme' as never)))).toContain('For the 14 months ended 2027-02-28');
    expect(await inTx(() => afsFilingDeadline(co, 2026))).toBe('2027-08-31');
  });
});

describe('disclosure notes (the AFS Notes tab)', () => {
  it('FY2026 carries a Reporting period note (IAS 1.36) right after the accounting policies; texts say 14 months', async () => {
    const notes = await inTx(() => generateDisclosureNotes(co, 2026));
    const i = notes.findIndex((n) => n.title === 'Reporting period');
    expect(i).toBe(1);
    expect(notes[i]!.content).toMatch(/14 months from 2026-01-01 to 2027-02-28.*IAS 1\.36/);
    expect(notes.map((n) => n.content).join(' ')).not.toMatch(/31 December 2026/);
    const vat = notes.find((n) => n.title === 'Taxation');
    expect(vat?.content).toContain('14 months ended 2027-02-28');
  });
  it('FY2025 (twelve months, with a twelve-month comparative) has no such note', async () => {
    const notes = await inTx(() => generateDisclosureNotes(co, 2025));
    expect(notes.some((n) => n.title === 'Reporting period')).toBe(false);
  });
});

describe('the year after, FY2028', () => {
  it('is a normal year whose comparative column is the 14-month transition year', async () => {
    const is = await inTx(() => generateIncomeStatement(co, 2028, 'ifrs_sme' as never));
    expect(texts(is)[0]).toBe('For the year ended 2028-02-29.');
    expect(headers(is)).toEqual(['Line', 'Current year (R)', '14 months to 2027-02-28 (R)']);
    expect(texts(is).join(' ')).toMatch(/comparative figures cover the 14 months from 2026-01-01 to 2027-02-28.*IAS 1\.36/);
  });

  it('a year with twelve-month comparatives carries no note', async () => {
    const p = await inTx(() => getReportingPeriod(co, 2025));
    expect(p.comparable).toBe(true);
    expect(p.comparabilityNote).toBeNull();
  });
});
