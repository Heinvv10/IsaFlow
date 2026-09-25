/**
 * ADVERSARIAL round 2 — attacks on the round-1 fixes. Each `it` asserts the
 * CORRECT behaviour; red is a finding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { approveSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { mergeAccounts } from '@/modules/accounting/services/gl/accountMergeService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, balanceOf, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
type L = { glAccountId: string; debit: number; credit: number; vatType?: string };
let fx: LateFixture;
const acc: Record<string, string> = {};
const say = (s: string) => process.stdout.write(`${s}\n`);

async function addAccount(code: string, name: string, type: string, subtype: string | null) {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, ${code}, ${name}, ${type}, ${subtype},
            ${type === 'expense' || type === 'asset' ? 'debit' : 'credit'}, true, false)
    RETURNING id`) as Row[])[0]!.id);
}
const post = (date: string, lines: L[], optIn = true) => inTx(fx, async () => {
  const je = await createJournalEntry(fx.companyId,
    { entryDate: date, description: 'BREAK2', lines: lines.map((l) => ({ ...l, vatType: l.vatType as never })) },
    fx.userId, undefined, optIn ? { allowLateInputClaim: true } : undefined);
  return postJournalEntry(fx.companyId, je.id, fx.userId, optIn ? { allowLateInputClaim: true } : undefined);
});
const report = () => inTx(fx, () => getVat201Report(fx.companyId, NEXT.start, NEXT.end, { detail: 'summary' }));
const settle = <T>(p: Promise<T>) => p.then((r) => r, (e: unknown) => e as Error);

describeIfDb('late input VAT claim: adversarial round 2', () => {
  beforeAll(async () => {
    assertNotProductionDb('adversarial late-claim repros round 2');
    fx = await seedLateFixture('VB2', DATABASE_URL!);
    acc.stationery = await addAccount('6100', `Stationery ${fx.tag}`, 'expense', 'operating_expense');
    acc.prepaid = await addAccount('1160', `Prepayments ${fx.tag}`, 'asset', 'other_current_asset');
    await lockPeriod(fx, P.start, P.end);
  }, 180000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 180000);

  it('C1: a R15 claim on a R0.01 base escapes the 15% check when late (on-time twin shows the variance)', async () => {
    const lines = (): L[] => [
      { glAccountId: acc.stationery!, debit: 0.01, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 15.01 },
    ];
    const r0 = await report();
    const late = await settle(post('2026-06-10', lines()));
    const r1 = await report();
    await post('2026-07-10', lines(), false);
    const r2 = await report();
    const lateVar = r1.rateCheck.inputVariance - r0.rateCheck.inputVariance;
    const onTimeVar = r2.rateCheck.inputVariance - r1.rateCheck.inputVariance;
    say(`C1 late=${late instanceof Error ? late.message.slice(0, 60) : 'SPLIT'} lateInputDelta=${r1.totals.inputTax - r0.totals.inputTax} lateVar=${lateVar} onTimeVar=${onTimeVar}`);
    expect(onTimeVar).toBeGreaterThan(14);
    if (!(late instanceof Error)) expect(lateVar).toBeCloseTo(onTimeVar, 2);
  });

  it('C2: an APPROVED bill with no journal, counted in the filed period, moves out when "Post to GL" claims it late', async () => {
    const b = await draftBill(fx, '2026-06-21', { vatClassification: 'services' });
    await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${b.id}::UUID`; // e.g. an imported approved bill
    const before = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    const out = await settle(inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, b.id, fx.userId, { allowLateInputClaim: true })));
    const after = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    say(`C2 post=${out instanceof Error ? out.message.slice(0, 80) : `lateClaim=${Boolean((out as { lateClaim?: unknown }).lateClaim)}`} P.field8 ${before.field8_services}->${after.field8_services} P.inputInvoices ${before.inputInvoices.length}->${after.inputInvoices.length}`);
    expect(after.field8_services).toBe(before.field8_services);
  });

  it('C3: a DISPUTED bill is counted in the filed period (status not in the new list)', async () => {
    const b = await draftBill(fx, '2026-06-22', { vatClassification: 'services' });
    const draftView = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    await sql`UPDATE supplier_invoices SET status = 'disputed' WHERE id = ${b.id}::UUID`;
    const disputedView = await inTx(fx, () => generateVAT201(fx.companyId, P.start, P.end));
    say(`C3 P.field8 draft=${draftView.field8_services} disputed=${disputedView.field8_services}`);
    expect(disputedView.field8_services).toBe(draftView.field8_services);
    await sql`UPDATE supplier_invoices SET status = 'draft' WHERE id = ${b.id}::UUID`;
  });

  it('C4: merging an ordinary asset INTO the clearing account is refused (only the split writes it)', async () => {
    await post('2026-07-15', [
      { glAccountId: acc.prepaid!, debit: 50, credit: 0 },
      { glAccountId: fx.bankAccountId, debit: 0, credit: 50 },
    ], false);
    const clearing0 = await balanceOf(fx, fx.clearingId);
    const res = await settle(inTx(fx, () => mergeAccounts(fx.companyId, acc.prepaid!, fx.clearingId, fx.userId)));
    const clearing1 = await balanceOf(fx, fx.clearingId);
    say(`C4 merge=${res instanceof Error ? res.message.slice(0, 100) : 'MERGED'} clearing ${clearing0}->${clearing1}`);
    expect(res).toBeInstanceOf(Error);
    expect(clearing1).toBe(clearing0);
  });

  it('C5: reversing the REVERSAL of a late original leaves the clearing account non-zero with no claim', async () => {
    const bill = await draftBill(fx, '2026-06-12');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));
    const [row] = (await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
    const originalId = String(row!.gl_journal_entry_id);
    const clearing0 = await balanceOf(fx, fx.clearingId);
    const rev = await inTx(fx, () => reverseJournalEntry(fx.companyId, originalId, fx.userId));
    const revrev = await settle(inTx(fx, () => reverseJournalEntry(fx.companyId, rev.id, fx.userId)));
    const clearing1 = await balanceOf(fx, fx.clearingId);
    say(`C5 revrev=${revrev instanceof Error ? revrev.message.slice(0, 100) : 'POSTED'} clearing ${clearing0}->${clearing1}`);
    expect(clearing1).toBe(clearing0);
  });
});
