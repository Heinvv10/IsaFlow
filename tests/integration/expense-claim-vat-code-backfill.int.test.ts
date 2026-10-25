/**
 * Migration 702 is FIGURE-NEUTRAL (Hein, 2026-09-25: backfill, prove it first).
 *
 * Legacy expense-claim journals carry an uncoded VAT Input leg. The migration
 * codes it 'standard'. For a company holding every shape it touches — an
 * on-time claim, a late-claimed one (its companion carries the leg), a
 * reversed one — every VAT201 field, the lock snapshot figures, the box basis,
 * the legacy getVATReturn totals and the journal membership are identical
 * before and after; only the uncoded-line exception changes. A non-claim
 * journal's uncoded leg is left alone, and a re-run changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { approveClaim, createClaim, postClaimToGl, submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';
import { getVatPeriodLines } from '@/modules/accounting/services/reports/vatBoxBasisQuery';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import type { VAT201Box } from '@/modules/accounting/types/gl.report.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { NEXT, P, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIGRATION = readFileSync(join(__dirname, '../../scripts/migrations/sql/702_expense_claim_vat_line_code_backfill.sql'), 'utf8');
type Row = Record<string, unknown>;
let fx: LateFixture;
let employee = '';
let reimburse = '';
let manualJe = '';
let claimJournals: string[] = [];

async function claim(date: string, late = false): Promise<string> {
  return inTx(fx, async () => {
    const c = await createClaim({ companyId: fx.companyId, employeeId: employee, claimDate: date, createdBy: fx.userId, lines: [{
      lineDate: date, description: 'Taxi', merchant: 'Cab', amount: 230, vatAmount: 30, vatCode: 'standard',
      glAccountId: fx.expenseId, costCentreId: null, projectId: null, sourceDocumentId: null,
      kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
    }] });
    await submitClaim(c.id, fx.companyId);
    await approveClaim(c.id, fx.companyId, fx.userId);
    const posted = await postClaimToGl(c.id, fx.companyId, {
      userId: fx.userId, reimbursementAccountId: reimburse, vatInputAccountId: fx.vatInputId, allowLateInputClaim: late,
    });
    return posted!.postedJeId!;
  });
}

/** Everything a statutory or lock figure is read from, for one period. */
async function figures(p: { start: string; end: string }) {
  return inTx(fx, async () => {
    const { outputInvoices: _o, inputInvoices: _i, ...ledger } = await getLedgerVAT201(fx.companyId, p.start, p.end);
    const { rows: _r, ...report } = await getVat201Report(fx.companyId, p.start, p.end, { detail: 'summary' });
    const legacy = await getVATReturn(fx.companyId, p.start, p.end);
    const lock = (await computeVatLockFigures(fx.companyId, p.start, p.end)).figures;
    const members = [...new Set((await getVatPeriodLines(fx.companyId, p.start, p.end)).lines.map((l) => l.journalEntryId))].sort();
    // The legacy drill-down lists coded lines before uncoded ones inside box 15,
    // so its ORDER moves when a code is filled in; the figures and the set of
    // transactions must not. Compare the set, sorted.
    const box = (b: VAT201Box) => ({
      box: b.box, label: b.label, amount: b.amount,
      transactions: (b.transactions ?? []).map((t) => JSON.stringify(t)).sort(),
    });
    const legacyFigures = {
      ...legacy, outputBoxes: legacy.outputBoxes.map(box), inputBoxes: legacy.inputBoxes.map(box),
    };
    return { ledger, report, legacy: legacyFigures, lock, members };
  });
}

async function vatLegCodes(journals: string[]): Promise<(string | null)[]> {
  const rows = (await sql`
    SELECT jl.vat_type FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype = 'vat_input'
      AND jl.journal_entry_id = ANY(${journals}::UUID[]) ORDER BY jl.journal_entry_id`) as Row[];
  return rows.map((r) => (r.vat_type == null ? null : String(r.vat_type)));
}

async function runMigration(): Promise<number> {
  const c = await fx.pool.connect();
  try {
    await c.query('BEGIN');
    const res = await c.query(MIGRATION);
    await c.query('COMMIT');
    return res.rowCount ?? 0;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

let before: { p: Awaited<ReturnType<typeof figures>>; next: Awaited<ReturnType<typeof figures>> };

describeIfDb('migration 702: expense-claim VAT legs coded standard, figure-neutral', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals, locks a VAT period and runs a migration.');
    fx = await seedLateFixture('ECB', DATABASE_URL!);
    employee = randomUUID();
    await sql`INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date, medical_aid_main_member)
      VALUES (${employee}::UUID, ${fx.companyId}::UUID, ${`E-${fx.tag}`.slice(0, 20)}, 'Claim', 'Backfill', '2026-01-01', true)`;
    reimburse = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '2300', ${`Reimbursements ${fx.tag}`}, 'liability', 'other_current_liability', 'credit', true)
      RETURNING id`) as Row[])[0]!.id);
    await lockPeriod(fx, P.start, P.end);

    const onTime = await claim('2026-07-10');
    const late = await claim('2026-06-15', true);
    const reversed = await claim('2026-07-12');
    const rev = await inTx(fx, () => reverseJournalEntry(fx.companyId, reversed, fx.userId));
    const [comp] = (await sql`SELECT id FROM gl_journal_entries
      WHERE company_id = ${fx.companyId}::UUID AND late_claim_of_id = ${late}::UUID`) as Row[];
    claimJournals = [onTime, String(comp!.id), reversed, String((rev as unknown as { id: string }).id)];
    // A journal no claim posted, with an uncoded VAT leg: NOT the migration's.
    manualJe = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-07-20', description: 'manual', source: 'manual', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0, description: 'x' },
        { glAccountId: fx.vatInputId, debit: 15, credit: 0, description: 'VAT' },
        { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'bank' },
      ] }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
    // Legacy state: claims posted before 2026-09-25 carried an uncoded VAT leg.
    await sql`UPDATE gl_journal_lines jl SET vat_type = NULL FROM gl_accounts ga
      WHERE ga.id = jl.gl_account_id AND ga.account_subtype = 'vat_input'
        AND jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${claimJournals}::UUID[])`;
    before = { p: await figures(P), next: await figures(NEXT) };
    await runMigration();
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('the fixture exercises every shape: 4 claim-descended VAT legs were uncoded and in the exceptions', () => {
    expect(claimJournals).toHaveLength(4);
    expect(before.next.members).toEqual(expect.arrayContaining(claimJournals));
    expect(before.next.ledger.field10_totalInputVAT).toBe(30 + 30 + 15); // on-time + companion + manual; reversed nets 0
  });

  it('every VAT201 field, box, rate check, lock figure, legacy return and membership is identical', async () => {
    expect(await figures(P)).toEqual(before.p);
    expect(await figures(NEXT)).toEqual(before.next);
  });

  it('codes exactly the claim-descended VAT legs; the manual journal\'s stays uncoded', async () => {
    expect(await vatLegCodes(claimJournals)).toEqual(['standard', 'standard', 'standard', 'standard']);
    expect(await vatLegCodes([manualJe])).toEqual([null]);
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
    expect(r.uncodedGlLines.map((l) => l.journalEntryId)).toEqual([manualJe]);
  });

  it('is re-runnable: a second run changes nothing', async () => {
    expect(await runMigration()).toBe(0);
  });
});
