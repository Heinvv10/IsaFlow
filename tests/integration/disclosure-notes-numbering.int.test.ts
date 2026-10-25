/**
 * Disclosure notes numbering through the real routes (withAuth, request transaction, CSRF): the generated notes
 * are 1-7, or 1-8 in a year that is not twelve months (the IAS 1.36 reporting-period note is note 2). Manual
 * notes are stored under the number their author typed and shown under the first free number at or after it,
 * so a manual note never shares a number with a generated one, and saving never overwrites or duplicates a
 * note by way of the number it is shown under. The page has no edit path: it adds (the form posts a number)
 * and deletes by id. Disposable schema fixture only; synthetic data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import notesRoute from '../../pages/api/accounting/disclosure-notes';
import manualRoute from '../../pages/api/accounting/disclosure-notes-manual';
import { generateFiscalYearForDate } from '@/modules/accounting/services/gl/fiscalYearGenerator';
import { applyYearEndChange } from '@/modules/accounting/services/gl/financialYearEndChangeApply';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { callRoute, newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let u: SetupUser;
let co: string;

type Note = { noteNumber: number; source: string; title: string; id?: string };

async function notes(year: number): Promise<Note[]> {
  const req = request({ 'sb-access-token': u.token, active_company_id: co }, 'GET') as unknown as { url: string; query: Record<string, string> };
  req.url = '/api/accounting/disclosure-notes';
  req.query = { year: String(year) };
  const out = response();
  await (notesRoute as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  expect(out.state.statusCode, JSON.stringify(out.state.body).slice(0, 300)).toBe(200);
  return (out.state.body as { data: { notes: Note[] } }).data.notes;
}

const saveManual = (fiscalYear: number, noteNumber: number, title: string) =>
  callRoute(manualRoute, u, { fiscalYear, noteNumber, title, content: `text of ${title}` }, '/api/accounting/disclosure-notes-manual');
const storedRows = async (year: number) =>
  (await pool.query('SELECT note_number, title FROM disclosure_notes_manual WHERE company_id = $1 AND fiscal_year = $2 ORDER BY note_number', [co, year])).rows;
const shown = (list: Note[], title: string) => list.find((n) => n.title === title)?.noteNumber;

beforeAll(async () => {
  u = await newSetupUser(pool);
  co = u.homeCompanyId;
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [co]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await als.run({ client, companyId: co, userId: u.userId, claims: {} } as never, async () => {
      await generateFiscalYearForDate(co, '2025-05-01');
      await generateFiscalYearForDate(co, '2026-05-01');
      await applyYearEndChange(co, u.userId, { newYearEndMonth: 2, reason: 'Aligned with the holding company', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true }, '2026-10-23');
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
});

beforeEach(async () => { await pool.query('DELETE FROM disclosure_notes_manual WHERE company_id = $1', [co]); });

afterAll(async () => {
  try {
    await pool.query('DELETE FROM disclosure_notes_manual WHERE company_id = $1', [co]);
    await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [co]);
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [u.userId]);
  } finally { await pool.end(); }
}, 60000);

describe('a transition year (FY2026, generated notes 1-8)', () => {
  it('a manual note saved as 8 is shown as 9; the reporting-period note is note 2', async () => {
    expect((await saveManual(2026, 8, 'Manual eight')).status).toBe(200);
    const list = await notes(2026);
    const numbers = list.map((n) => n.noteNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(list.filter((n) => n.source === 'auto').map((n) => n.noteNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(shown(list, 'Reporting period')).toBe(2);
    expect(shown(list, 'Manual eight')).toBe(9);
  });

  it('saving the same stored number again edits that note: still one row, never a second', async () => {
    await saveManual(2026, 8, 'First wording');
    await saveManual(2026, 8, 'Second wording');
    expect(await storedRows(2026)).toEqual([{ note_number: 8, title: 'Second wording' }]);
    const list = await notes(2026);
    expect(list.filter((n) => n.source === 'manual').map((n) => `${n.noteNumber}:${n.title}`)).toEqual(['9:Second wording']);
  });

  it('typing the number a manual note is SHOWN under (9) adds a new note beside it; nothing is overwritten and no number repeats', async () => {
    await saveManual(2026, 8, 'Shown as nine');
    await saveManual(2026, 9, 'Typed nine');
    expect((await storedRows(2026)).map((r) => r.title)).toEqual(['Shown as nine', 'Typed nine']);
    const list = await notes(2026);
    expect(shown(list, 'Shown as nine')).toBe(9);
    expect(shown(list, 'Typed nine')).toBe(10);
    const numbers = list.map((n) => n.noteNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('a legacy manual note below 8 moves only if it collides with a generated note', async () => {
    await saveManual(2026, 3, 'Legacy three');
    expect(shown(await notes(2026), 'Legacy three')).toBe(9);
  });
});

describe('a normal year (FY2025, generated notes 1-7)', () => {
  it('manual notes from 8 up keep the numbers they were saved under', async () => {
    await saveManual(2025, 8, 'Manual eight');
    await saveManual(2025, 12, 'Manual twelve');
    const list = await notes(2025);
    expect(list.filter((n) => n.source === 'auto').map((n) => n.noteNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(shown(list, 'Manual eight')).toBe(8);
    expect(shown(list, 'Manual twelve')).toBe(12);
  });
});
