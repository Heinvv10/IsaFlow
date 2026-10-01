/**
 * Credit notes, as expense claims (Hein, 2026-09-25): approveCreditNote posts
 * its VAT leg coded 'standard' — what the VAT201 already assumed for an
 * uncoded leg on either side (`vatType ?? 'standard'`, reports/vatBoxBasis;
 * the legacy getVATReturn puts an uncoded output leg in box 1 and an uncoded
 * input leg in box 15, the 'standard' boxes) — and migration 703 backfills
 * the legs already posted.
 *
 * FIGURE-NEUTRAL: for a company holding supplier and customer credit notes
 * (one of them reversed), every VAT201 field, box and rate check, the lock
 * snapshot, the legacy return and journal membership are identical before
 * and after; only the uncoded-line exception changes. A non-credit-note
 * journal's uncoded leg is left alone, and a re-run changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '@/lib/neon';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
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
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const MIGRATION = readFileSync(join(__dirname, '../../scripts/migrations/sql/703_credit_note_vat_line_code_backfill.sql'), 'utf8');
const PERIOD = { start: '2026-07-01', end: '2026-08-31' };
type Row = Record<string, unknown>;
let fx: Fixture;
let manualJe = '';
let cnJournals: string[] = [];
let codedAtApproval: (string | null)[] = [];

async function approvedCreditNote(type: 'supplier' | 'customer', date: string, subtotal: number): Promise<string> {
  return inTx(fx, async () => {
    const cn = await createCreditNote(fx.companyId, type === 'supplier'
      ? { type, supplierId: fx.supplierId, creditDate: date, subtotal, taxRate: 15 }
      : { type, clientId: fx.customerId, creditDate: date, subtotal, taxRate: 15 }, fx.userId);
    return (await approveCreditNote(fx.companyId, cn.id, fx.userId)).glJournalEntryId!;
  });
}

async function figures() {
  return inTx(fx, async () => {
    const { outputInvoices: _o, inputInvoices: _i, ...ledger } = await getLedgerVAT201(fx.companyId, PERIOD.start, PERIOD.end);
    const { rows: _r, ...report } = await getVat201Report(fx.companyId, PERIOD.start, PERIOD.end, { detail: 'summary' });
    const legacy = await getVATReturn(fx.companyId, PERIOD.start, PERIOD.end);
    const box = (b: VAT201Box) => ({ box: b.box, label: b.label, amount: b.amount,
      transactions: (b.transactions ?? []).map((t) => JSON.stringify(t)).sort() });
    const lock = (await computeVatLockFigures(fx.companyId, PERIOD.start, PERIOD.end)).figures;
    const members = [...new Set((await getVatPeriodLines(fx.companyId, PERIOD.start, PERIOD.end)).lines.map((l) => l.journalEntryId))].sort();
    return { ledger, report, legacy: { ...legacy, outputBoxes: legacy.outputBoxes.map(box), inputBoxes: legacy.inputBoxes.map(box) }, lock, members };
  });
}

async function vatLegCodes(journals: string[]): Promise<(string | null)[]> {
  const rows = (await sql`
    SELECT jl.vat_type FROM gl_journal_lines jl JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype IN ('vat_input', 'vat_output')
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

let before: Awaited<ReturnType<typeof figures>>;

describeIfDb('credit-note VAT legs coded standard (approve + migration 703), figure-neutral', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and runs a migration.');
    fx = await seedFixture('CNB', DATABASE_URL!);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
    const scn = await approvedCreditNote('supplier', '2026-07-10', 100);
    const ccn = await approvedCreditNote('customer', '2026-07-11', 200);
    const reversed = await approvedCreditNote('customer', '2026-07-12', 300);
    const rev = await inTx(fx, () => reverseJournalEntry(fx.companyId, reversed, fx.userId));
    cnJournals = [scn, ccn, reversed, (rev as unknown as { id: string }).id];
    codedAtApproval = await vatLegCodes([scn, ccn]);
    const vin = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
    const exp = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'default_expense'`) as Row[])[0]!.id);
    manualJe = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-07-20', description: 'manual', source: 'manual', lines: [
        { glAccountId: exp, debit: 100, credit: 0, description: 'x' },
        { glAccountId: vin, debit: 15, credit: 0, description: 'VAT' },
        { glAccountId: fx.bankAccountId, debit: 0, credit: 115, description: 'bank' },
      ] }, fx.userId);
      await postJournalEntry(fx.companyId, je.id, fx.userId);
      return je.id;
    });
    // Legacy state: credit notes approved before 2026-09-25 left the VAT leg uncoded.
    await sql`UPDATE gl_journal_lines jl SET vat_type = NULL FROM gl_accounts ga
      WHERE ga.id = jl.gl_account_id AND ga.account_subtype IN ('vat_input', 'vat_output')
        AND jl.company_id = ${fx.companyId}::UUID AND jl.journal_entry_id = ANY(${cnJournals}::UUID[])`;
    before = await figures();
    await runMigration();
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('approveCreditNote codes the VAT leg standard on both sides, going forward', () => {
    expect(codedAtApproval).toEqual(['standard', 'standard']);
  });

  it('the fixture holds both sides: output and input credit-note VAT in the return', () => {
    expect(before.ledger.field5_outputVAT).toBe(-30); // customer CNs: -30, and -45 + 45 reversed
    expect(before.ledger.field10_totalInputVAT).toBe(-15 + 15); // supplier CN -15 + the manual 15
    expect(before.members).toEqual(expect.arrayContaining(cnJournals));
  });

  it('every VAT201 field, box, rate check, lock figure, legacy return and membership is identical', async () => {
    expect(await figures()).toEqual(before);
  });

  it('codes exactly the credit-note VAT legs; the manual journal\'s stays uncoded', async () => {
    expect(await vatLegCodes(cnJournals)).toEqual(['standard', 'standard', 'standard', 'standard']);
    expect(await vatLegCodes([manualJe])).toEqual([null]);
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    expect(r.uncodedGlLines.map((l) => l.journalEntryId)).toEqual([manualJe]);
  });

  it('is re-runnable: a second run changes nothing', async () => {
    expect(await runMigration()).toBe(0);
  });
});
