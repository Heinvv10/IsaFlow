/**
 * What s16(3) does NOT allow: even with the opt-in, a locked-period posting is
 * refused — before anything is written — when it carries output VAT, reduces
 * input VAT, claims on a non-supply account, would be claimed more than five
 * years late, or would be claimed in a closed fiscal period. The refusal IS-A
 * VatPeriodLockedError (same code), so every existing 4xx mapping holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { VatLateClaimRefusal } from '@/modules/accounting/services/gl/vatLateClaimPlan';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { countRows, dropLateFixture, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
type L = { glAccountId: string; debit: number; credit: number; vatType?: string };
let fx: LateFixture;
const acc: Record<string, string> = {};

async function addAccount(code: string, name: string, type: string, subtype: string | null, denied = false) {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, is_system_account, vat_input_denied)
    VALUES (${fx.companyId}::UUID, ${code}, ${name}, ${type}, ${subtype},
            ${type === 'expense' || type === 'asset' ? 'debit' : 'credit'}, true, false, ${denied})
    RETURNING id`) as Row[])[0]!.id);
}
async function lock(start: string, end: string) {
  await sql`
    INSERT INTO vat_period_locks
      (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
    VALUES (${fx.companyId}::UUID, ${start}::DATE, ${end}::DATE, 0, 0, 0, NOW(), ${fx.userId})`;
}
const create = (date: string, lines: L[]) => inTx(fx, () => createJournalEntry(fx.companyId,
  { entryDate: date, description: 'LC refusal', lines: lines.map((l) => ({ ...l, vatType: l.vatType as never })) },
  fx.userId, undefined, { allowLateInputClaim: true }));

/** Refused at create (opt-in), nothing written; the reason is named. */
async function expectRefused(date: string, lines: L[], reason: string | null) {
  const before = await countRows(fx);
  const err = await create(date, lines).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(VatPeriodLockedError);
  if (reason === null) expect(err).not.toBeInstanceOf(VatLateClaimRefusal);
  else expect((err as VatLateClaimRefusal).reason).toBe(reason);
  expect((err as { code: string }).code).toBe('VAT_PERIOD_LOCKED');
  expect(await countRows(fx)).toEqual(before);
}

describeIfDb('late input VAT claim: what s16(3) refuses', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into locked VAT periods.');
    fx = await seedLateFixture('VLR', DATABASE_URL!);
    acc.revenue = await addAccount('4000', `Sales ${fx.tag}`, 'revenue', 'default_revenue');
    acc.donations = await addAccount('6900', `Donations ${fx.tag}`, 'expense', 'operating_expense');
    acc.entertain = await addAccount('6910', `Staff functions ${fx.tag}`, 'expense', 'operating_expense', true);
    acc.vatOut = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID
      AND account_subtype = 'vat_output'`) as Row[])[0]!.id);
    await lock('2026-05-01', '2026-06-30');
    // Back to back with the one above, so anything dated from March 2021 is
    // claimed on 2026-07-01 — over five years on for March 2021.
    await lock('2021-03-01', '2026-04-30');
  }, 120000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 120000);

  it('output VAT (a DRC journal) refuses output_vat', async () => {
    await expectRefused('2026-06-10', [
      { glAccountId: fx.expenseId, debit: 1000, credit: 0, vatType: 'reverse_charge' },
      { glAccountId: fx.vatInputId, debit: 150, credit: 0, vatType: 'reverse_charge' },
      { glAccountId: acc.vatOut!, debit: 0, credit: 150, vatType: 'reverse_charge' },
      { glAccountId: fx.apId, debit: 0, credit: 1000 },
    ], 'output_vat');
  });

  it('a VAT tag on a revenue line refuses output_vat', async () => {
    await expectRefused('2026-06-10', [
      { glAccountId: fx.bankAccountId, debit: 100, credit: 0 },
      { glAccountId: acc.revenue!, debit: 0, credit: 100, vatType: 'zero_rated' },
    ], 'output_vat');
  });

  it('a supplier credit note (input VAT credited) refuses input_reduction', async () => {
    await expectRefused('2026-06-10', [
      { glAccountId: fx.apId, debit: 115, credit: 0 },
      { glAccountId: fx.expenseId, debit: 0, credit: 100, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 0, credit: 15, vatType: 'standard' },
    ], 'input_reduction');
  });

  it('VAT claimed on a non-supply account refuses non_supply', async () => {
    await expectRefused('2026-06-10', [
      { glAccountId: acc.donations!, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 115 },
    ], 'non_supply');
  });

  it('VAT claimed on a vat_input_denied account refuses non_supply', async () => {
    await expectRefused('2026-06-10', [
      { glAccountId: acc.entertain!, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 115 },
    ], 'non_supply');
  });

  it('a claim more than five years after the document refuses expired_5y', async () => {
    await expectRefused('2021-03-15', [
      { glAccountId: fx.expenseId, debit: 100, credit: 0 },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 115 },
    ], 'expired_5y');
  });

  it('a claim date in a closed fiscal period refuses claim_period_closed', async () => {
    // Claimed on 2026-07-01, inside the fixture's one 2026 period: close it for this case.
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${fx.companyId}::UUID AND fiscal_year = 2026`;
    try {
      await expectRefused('2025-11-15', [
        { glAccountId: fx.expenseId, debit: 100, credit: 0 },
        { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
        { glAccountId: fx.apId, debit: 0, credit: 115 },
      ], 'claim_period_closed');
    } finally {
      await sql`UPDATE fiscal_periods SET status = 'open' WHERE company_id = ${fx.companyId}::UUID AND fiscal_year = 2026`;
    }
  });

  it('VAT on a no-treatment balance-sheet account is today\'s plain refusal', async () => {
    const loan = await addAccount('2400', `Director loan ${fx.tag}`, 'liability', null);
    await expectRefused('2026-06-10', [
      { glAccountId: loan, debit: 100, credit: 0, vatType: 'standard' },
      { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
      { glAccountId: fx.apId, debit: 0, credit: 115 },
    ], null);
  });

  it('at POST time too: a draft re-dated into the lock is refused and left exactly as it was', async () => {
    const je = await inTx(fx, () => createJournalEntry(fx.companyId, {
      entryDate: '2026-07-10', description: 'LC redate', lines: [
        { glAccountId: fx.apId, debit: 115, credit: 0 },
        { glAccountId: fx.expenseId, debit: 0, credit: 100, vatType: 'standard' },
        { glAccountId: fx.vatInputId, debit: 0, credit: 15, vatType: 'standard' },
      ] }, fx.userId));
    await sql`UPDATE gl_journal_entries SET entry_date = '2026-06-10' WHERE id = ${je.id}::UUID`;
    const snap = async () => sql`
      SELECT gl_account_id, vat_type, debit, credit FROM gl_journal_lines
      WHERE journal_entry_id = ${je.id}::UUID ORDER BY id`;
    const before = await snap();
    const count = await countRows(fx);
    const err = await inTx(fx, () => postJournalEntry(fx.companyId, je.id, fx.userId, { allowLateInputClaim: true }))
      .then(() => null, (e: unknown) => e);
    expect((err as VatLateClaimRefusal).reason).toBe('input_reduction');
    expect(await snap()).toEqual(before);
    expect(await countRows(fx)).toEqual(count);
    const [h] = (await sql`SELECT status FROM gl_journal_entries WHERE id = ${je.id}::UUID`) as Row[];
    expect(h!.status).toBe('draft');
  });
});
