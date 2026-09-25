/**
 * Gap 2 against the real ledger: the VAT201's input variance is the
 * per-journal over-claim, measured on the coded base (reports/vatCodedBase,
 * reports/vatInputOverclaim). One company of its own; one month per case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
let expense = '';
let vatInput = '';

const JAN = { start: '2026-01-01', end: '2026-01-31' };
const FEB = { start: '2026-02-01', end: '2026-02-28' };
const MAR = { start: '2026-03-01', end: '2026-03-31' };

async function post(date: string, lines: JournalLineInput[]): Promise<string> {
  return inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, { entryDate: date, description: 'coded base', source: 'manual', lines }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
    return je.id;
  });
}
const exp = (debit: number, vatType?: JournalLineInput['vatType']): JournalLineInput =>
  ({ glAccountId: expense, debit, credit: 0, description: 'expense', ...(vatType ? { vatType } : {}) });
const vat = (debit: number): JournalLineInput => ({ glAccountId: vatInput, debit, credit: 0, description: 'VAT', vatType: 'standard' });
const bank = (credit: number): JournalLineInput => ({ glAccountId: fx.bankAccountId, debit: 0, credit, description: 'bank' });
const report = (p: { start: string; end: string }) => inTx(fx, () => getVat201Report(fx.companyId, p.start, p.end, { detail: 'summary' }));

describeIfDb('VAT201 coded base and per-journal over-claim', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals.');
    fx = await seedFixture('VCB', DATABASE_URL!);
    const acct = async (subtype: string) => String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);
    expense = await acct('default_expense');
    vatInput = await acct('vat_input');
    // JAN: R1 000 coded standard + R5 000 uncoded; VAT 150 is 15% of the coded line.
    await post('2026-01-15', [exp(1000, 'standard'), exp(5000), vat(150), bank(6150)]);
    // FEB: an under-claim (R100 on R1 000) and an over-claim (R200 on R1 000).
    await post('2026-02-10', [exp(1000), vat(100), bank(1100)]);
    await post('2026-02-11', [exp(1000), vat(200), bank(1200)]);
    // MAR: an over-claim and its reversal in the same (open) month.
    const over = await post('2026-03-10', [exp(1000), vat(200), bank(1200)]);
    await inTx(fx, () => reverseJournalEntry(fx.companyId, over, fx.userId));
  }, 180000);

  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('the mixed-coded journal ties on its coded base; box 15 base is the coded line', async () => {
    const r = await report(JAN);
    expect(r.rateCheck.inputVariance).toBe(0);
    expect(r.rateCheck.ties).toBe(true);
    expect(r.boxes.find((b) => b.box === '15')).toMatchObject({ base: 1000, tax: 150 });
  });

  it('an under-claim no longer hides an over-claim: variance = the over-claim, less the R0.01 rounding allowance', async () => {
    const r = await report(FEB);
    expect(r.rateCheck.inputVariance).toBe(49.99);
    expect(r.rateCheck.ties).toBe(false);
  });

  it('field 10 is the tax posted, unchanged by either rule', async () => {
    const jan = await inTx(fx, () => getLedgerVAT201(fx.companyId, JAN.start, JAN.end));
    const feb = await inTx(fx, () => getLedgerVAT201(fx.companyId, FEB.start, FEB.end));
    expect(jan.field10_totalInputVAT).toBe(150);
    expect(feb.field10_totalInputVAT).toBe(300);
    expect(feb.rateCheck.inputVariance).toBe(49.99);
  });

  it('an over-claim reversed in the same period nets to 0', async () => {
    const r = await report(MAR);
    expect(r.totals.inputTax).toBe(0);
    expect(r.rateCheck.inputVariance).toBe(0);
  });
});
