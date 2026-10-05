/**
 * Non-supply VAT exception (findVatNonSupplyLines): a reversed PAIR whose two
 * halves both fall inside the period moves no VAT in that period, so neither
 * half is listed (Hein, 2026-10-05 — Velocity Fibre Jan–Aug 2026 carried 34
 * such rows after every original had been re-coded, blocking the filing on
 * R0,00 of net tax). An unreversed line is still listed, and so is the
 * in-window half of a pair that straddles the period boundary (either way
 * round). Only an ISOLATED pair is dropped: every link of a chain
 * O <- R <- R2 inside the period stays listed (R2 puts O's claim back) — when
 * R2 falls in a later period the in-window pair still drops — a draft reversal clears
 * nothing, and a reversal pointing at another company's journal is no pair.
 *
 * Journals are inserted directly: the posting-time non-supply guard would
 * (rightly) coerce a salary line's VAT code, and this test is about legacy
 * rows posted before that guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PERIOD = { start: '2026-07-01', end: '2026-08-31' };
type Row = Record<string, unknown>;
let fx: Fixture;
let other: Fixture;
let salaries = '';
let vatInput = '';
const je: Record<string, string> = {};

async function salaryJournal(
  key: string, date: string, sign: 1 | -1, reversalOf?: string, status: 'posted' | 'draft' = 'posted',
): Promise<void> {
  const rows = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, reversal_of_id)
    VALUES (${fx.companyId}::UUID, ${`NS-${key}-${fx.tag}`}, ${date}::DATE, ${`salary ${key}`}, ${status},
            ${fx.userId}::UUID, ${reversalOf ?? null}::UUID)
    RETURNING id`) as Row[];
  const id = String(rows[0]!.id);
  const legs: [string, number, number, string | null][] = [
    [salaries, sign > 0 ? 100 : 0, sign > 0 ? 0 : 100, 'standard'],
    [vatInput, sign > 0 ? 15 : 0, sign > 0 ? 0 : 15, 'standard'],
    [fx.bankAccountId, sign > 0 ? 0 : 115, sign > 0 ? 115 : 0, null],
  ];
  for (const [account, debit, credit, vatType] of legs) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type)
      VALUES (${fx.companyId}::UUID, ${id}::UUID, ${account}::UUID, ${debit}, ${credit}, ${vatType})`;
  }
  je[key] = id;
}

describeIfDb('non-supply VAT exception ignores reversed pairs inside the period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test inserts journals.');
    fx = await seedFixture('NSR', DATABASE_URL!);
    const acct = (await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '49784360', ${`Salaries & Wages ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[];
    salaries = String(acct[0]!.id);
    vatInput = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
    await salaryJournal('pairA', '2026-07-10', 1);
    await salaryJournal('pairB', '2026-07-10', -1, je.pairA);
    await salaryJournal('open', '2026-07-15', 1);
    await salaryJournal('straddleOrig', '2026-06-30', 1);
    await salaryJournal('straddleRev', '2026-07-05', -1, je.straddleOrig);
    await salaryJournal('mirrorOrig', '2026-08-30', 1);
    await salaryJournal('mirrorRev', '2026-09-02', -1, je.mirrorOrig);
    await salaryJournal('chainO', '2026-07-20', 1);
    await salaryJournal('chainR', '2026-07-21', -1, je.chainO);
    await salaryJournal('chainR2', '2026-07-22', 1, je.chainR);
    await salaryJournal('preP', '2026-06-25', 1);
    await salaryJournal('preO', '2026-07-12', -1, je.preP);
    await salaryJournal('preR', '2026-07-13', 1, je.preO);
    await salaryJournal('outO', '2026-08-10', 1);
    await salaryJournal('outR', '2026-08-11', -1, je.outO);
    await salaryJournal('outR2', '2026-09-05', 1, je.outR);
    await salaryJournal('draftOrig', '2026-07-25', 1);
    await salaryJournal('draftRev', '2026-07-26', -1, je.draftOrig, 'draft');
    other = await seedFixture('NSX', DATABASE_URL!);
    const foreign = (await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by)
      VALUES (${other.companyId}::UUID, ${`NS-foreign-${other.tag}`}, '2026-07-27'::DATE, 'foreign', 'posted', ${other.userId}::UUID)
      RETURNING id`) as Row[];
    await salaryJournal('crossRev', '2026-07-28', -1, String(foreign[0]!.id));
    // Isolated pairs whose only extra neighbour does not count: a DRAFT
    // re-reversal, and another company's journal pointing at the reversal.
    await salaryJournal('isoDraftO', '2026-07-03', 1);
    await salaryJournal('isoDraftR', '2026-07-04', -1, je.isoDraftO);
    await salaryJournal('isoDraftR2', '2026-07-06', 1, je.isoDraftR, 'draft');
    await salaryJournal('isoForeignO', '2026-07-07', 1);
    await salaryJournal('isoForeignR', '2026-07-08', -1, je.isoForeignO);
    await sql`INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, reversal_of_id)
      VALUES (${other.companyId}::UUID, ${`NS-foreignrev-${other.tag}`}, '2026-07-09'::DATE, 'foreign rev', 'posted', ${other.userId}::UUID, ${je.isoForeignR}::UUID)`;
  }, 480000);

  afterAll(async () => {
    // Links run both ways between the two companies: clear them all first.
    for (const f of [fx, other]) {
      if (f) await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${f.companyId}::UUID`;
    }
    if (fx) await dropFixture(fx);
    if (other) await dropFixture(other);
  }, 240000);

  it('drops only the isolated in-window pair', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId).sort();
    const listed = ['open', 'straddleRev', 'mirrorOrig', 'chainO', 'chainR', 'chainR2', 'draftOrig', 'crossRev'];
    expect(ids).toEqual(listed.map((k) => je[k]).sort());
    expect(r.vatNonSupplyCount).toBe(listed.length);
  });

  it('a reversal of a reversal keeps the whole chain listed: R2 puts the claim back', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = new Set(r.vatNonSupplyLines.map((l) => l.journalEntryId));
    expect([je.chainO, je.chainR, je.chainR2].every((id) => ids.has(id))).toBe(true);
  });

  it('a chain continuing in a later period: the in-window pair drops here, the re-reversal lists in its own', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId);
    expect(ids).not.toContain(je.outO);
    expect(ids).not.toContain(je.outR);
    const later = await inTx(fx, () => getVatExceptions(fx.companyId, '2026-09-01', '2026-10-31'));
    expect(later.vatNonSupplyLines.map((l) => l.journalEntryId)).toContain(je.outR2);
  });

  it('a chain that STARTS before the period: the in-window pair drops, the earlier link lists in its own', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId);
    expect(ids).not.toContain(je.preO);
    expect(ids).not.toContain(je.preR);
    const earlier = await inTx(fx, () => getVatExceptions(fx.companyId, '2026-05-01', '2026-06-30'));
    expect(earlier.vatNonSupplyLines.map((l) => l.journalEntryId)).toContain(je.preP);
  });

  it('a draft re-reversal or another company\'s journal does not break an isolated pair', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId);
    for (const k of ['isoDraftO', 'isoDraftR', 'isoForeignO', 'isoForeignR']) expect(ids).not.toContain(je[k]);
  });

  it('a pair straddling the period END is listed on its in-window side', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId);
    expect(ids).toContain(je.mirrorOrig);
    expect(ids).not.toContain(je.mirrorRev);
  });

  it('a draft reversal does not clear the original, and another company\'s journal is no partner', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId);
    expect(ids).toContain(je.draftOrig);
    expect(ids).not.toContain(je.draftRev);
    expect(ids).toContain(je.crossRev);
  });

  it('the straddling original is still listed in its own period', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, '2026-05-01', '2026-06-30'));
    expect(r.vatNonSupplyLines.map((l) => l.journalEntryId).sort()).toEqual([je.straddleOrig, je.preP].sort());
  });
});
