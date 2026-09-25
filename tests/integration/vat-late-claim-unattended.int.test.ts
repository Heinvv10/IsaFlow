/**
 * Unattended posters never claim input VAT late (Hein's scope decision): with
 * nobody there to be told the VAT moved periods, a posting dated in a filed
 * VAT period keeps today's plain refusal — here the recurring-journal run and
 * the provisional capture poster, even though the company has the late-claim
 * account and the journal would qualify. (Bank-rule auto-post:
 * vat-late-claim-bank.int.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createRecurringJournal, generateJournalFromRecurring } from '@/modules/accounting/services/gl/recurringJournalService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { P, countRows, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;

function expectPlainRefusal(err: unknown) {
  expect(err).toBeInstanceOf(VatPeriodLockedError);
  expect((err as Error).name).toBe('VatPeriodLockedError'); // not a late-claim refusal: never offered
}

describeIfDb('late input VAT claim: unattended posters keep the refusal', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLU', DATABASE_URL!);
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM recurring_journals WHERE company_id = ${fx.companyId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('a recurring journal due inside the lock is refused, and its run is not claimed', async () => {
    const rj = await inTx(fx, () => createRecurringJournal(fx.companyId, {
      templateName: `VLU ${fx.tag}`, frequency: 'monthly', nextRunDate: '2026-06-15', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0 },
        { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
        { glAccountId: fx.apId, debit: 0, credit: 115 },
      ] }, fx.userId));
    const before = await countRows(fx);
    const err = await inTx(fx, () => generateJournalFromRecurring(fx.companyId, rj.id, fx.userId))
      .then(() => null, (e: unknown) => e);
    expectPlainRefusal(err);
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT next_run_date::TEXT AS d, run_count FROM recurring_journals WHERE id = ${rj.id}::UUID`) as Row[];
    expect(row).toMatchObject({ d: '2026-06-15', run_count: 0 });
  });

  it('the provisional capture poster refuses a VAT spend dated inside the lock', async () => {
    // seedBankTx appends the fixture tag, which is also the fixture supplier's name: that is the match.
    const supplier = fx.supplierId;
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, posted_by)
        VALUES (${fx.companyId}::UUID, ${supplier}::UUID, ${fx.expenseId}::UUID, 'standard', ${fx.userId})`;
    }
    const tx = await seedBankTx(fx, { date: '2026-06-18', amount: -115, description: 'WALTONS STATIONERY' });
    const before = await countRows(fx);
    const err = await inTx(fx, () => postProvisional(fx.companyId, tx, fx.userId))
      .then((r) => r, (e: unknown) => e);
    expectPlainRefusal(err);
    expect(await countRows(fx)).toEqual(before);
  });
});
