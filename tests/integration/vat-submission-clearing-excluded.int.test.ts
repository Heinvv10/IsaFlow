/**
 * V-05, the ledger copies (Hein, 2026-09-25). vatSubmissionService posts a
 * clearing journal (source 'auto_vat_submission') on day 1 of the FOLLOWING
 * period: DR VAT Output / CR VAT Input / the net to accrued. It is a
 * settlement of the previous return, not a supply, and it must not reach the
 * next period's return. The ledger VAT201 read it — so that period FILED
 * fields 5 and 10 reduced by the previous period's tax, and its lock snapshot
 * and export recorded the reduced figures. It also made a locked period's
 * reclassification check refuse a change to the accrued account, which only
 * the clearing journal touches.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { findLockedReclassification } from '@/modules/accounting/services/gl/vatLockLineClassification';
import { getLedgerVAT201 } from '@/modules/accounting/services/reports/vat201LedgerFields';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import type { GLEntrySource, JournalLineInput } from '@/modules/accounting/types/gl.types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: Fixture;
const id: Record<string, string> = {};
const B = { start: '2026-03-01', end: '2026-04-30' };

async function post(date: string, source: GLEntrySource, lines: JournalLineInput[]): Promise<void> {
  await inTx(fx, async () => {
    const je = await createJournalEntry(fx.companyId, { entryDate: date, description: source, source, lines }, fx.userId);
    await postJournalEntry(fx.companyId, je.id, fx.userId);
  });
}
const l = (acct: string, debit: number, credit: number, vatType?: JournalLineInput['vatType']): JournalLineInput =>
  ({ glAccountId: id[acct]!, debit, credit, description: acct, ...(vatType ? { vatType } : {}) });

describeIfDb('the VAT submission clearing journal is not in the next period\'s return', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts journals and locks a VAT period.');
    fx = await seedFixture('VSC', DATABASE_URL!);
    for (const [k, sub] of [['exp', 'default_expense'], ['vin', 'vat_input'], ['vout', 'vat_output']] as const) {
      id[k] = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub} LIMIT 1`) as Row[])[0]!.id);
    }
    id.bank = fx.bankAccountId;
    for (const [k, code, type, sub, normal] of [
      ['sales', '4000', 'revenue', 'sales', 'credit'],
      ['accrued', '2130', 'liability', 'other_current_liability', 'credit'],
    ] as const) {
      id[k] = String(((await sql`
        INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
        VALUES (${fx.companyId}::UUID, ${code}, ${`${k} ${fx.tag}`}, ${type}, ${sub}, ${normal}, true) RETURNING id`) as Row[])[0]!.id);
    }
    // The previous period (Jan–Feb): output 1500, input 300 — then its clearing journal on 1 March.
    await post('2026-03-01', 'auto_vat_submission', [l('vout', 1500, 0), l('vin', 0, 300), l('accrued', 0, 1200)]);
    // Period B's own trade: a sale (output 150) and a purchase (input 45).
    await post('2026-03-10', 'manual', [l('bank', 1150, 0), l('sales', 0, 1000, 'standard'), l('vout', 0, 150, 'standard')]);
    await post('2026-03-12', 'manual', [l('exp', 300, 0), l('vin', 45, 0, 'standard'), l('bank', 0, 345)]);
  }, 180000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('fields 5, 10 and 11 of the next period are its own trade, not reduced by the clearing journal', async () => {
    const v = await inTx(fx, () => getLedgerVAT201(fx.companyId, B.start, B.end));
    expect(v.field5_outputVAT).toBe(150);
    expect(v.field10_totalInputVAT).toBe(45);
    expect(v.field11_vatPayableOrRefundable).toBe(105);
    expect(v.rateCheck.entriesWithoutBaseTotal).toBe(0);
  });

  it('the lock snapshot records the same figures as the ledger VAT201', async () => {
    const { figures } = await inTx(fx, () => computeVatLockFigures(fx.companyId, B.start, B.end));
    expect({ outputTax: figures.outputTax, inputTax: figures.inputTax, netVat: figures.netVat })
      .toEqual({ outputTax: 150, inputTax: 45, netVat: 105 });
  });

  it('a locked period\'s reclassification check ignores the clearing journal', async () => {
    await sql`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fx.companyId}::UUID, ${B.start}::DATE, ${B.end}::DATE, 150, 45, 105, NOW(), ${fx.userId})`;
    const refusal = await inTx(fx, () => findLockedReclassification(fx.companyId, [{
      accountId: id.accrued!, accountCode: '2130',
      from: { accountType: 'liability', accountSubtype: 'other_current_liability' },
      to: { accountType: 'expense', accountSubtype: 'operating_expense' },
    }]));
    expect(refusal).toBeNull();
  });
});
