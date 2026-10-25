/**
 * The pre-filing gate (getVatExceptions → evaluateEfilingGate) reads a late
 * claim exactly as it reads the same posting made on time in the claim period:
 * for a bank allocation, an expense claim and a manual journal, the late
 * posting moves the claim period's exception count, its input recon variance
 * and the gate's verdict by exactly what the on-time twin moves them.
 *
 * Parity, not "allowed": the exceptions recon compares the GL's input VAT with
 * generateVAT201's DOCUMENT population (bills only), so ANY input VAT without a
 * bill — on time or late — is a recon variance today. That is the gate's
 * existing behaviour, not the late claim's; a bill's late claim is proven
 * "allowed" in vat-late-claim-filing.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { createClaim, submitClaim, approveClaim, postClaimToGl } from '@/modules/accounting/services/expense/expenseClaimService';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { evaluateEfilingGate } from '@/modules/accounting/services/reports/sarsEfilingSubmissionService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import { NEXT, P, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture } from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
let reimbursementId = '';
const employeeId = randomUUID();
const late = { allowLateInputClaim: true };

async function gate() {
  const r = await inTx(fx, () => getVatExceptions(fx.companyId, NEXT.start, NEXT.end));
  return {
    // Every exception category but the recon, which is a yes/no and so cannot be compared as a delta.
    listed: r.uncodedGlLineCount + r.invoiceTaxCodeIssueCount + r.invoiceGlMismatchCount
      + r.vatOnBalanceSheetCount + r.vatNonSupplyCount,
    variance: r.controlRecon.inputVariance,
    allowed: evaluateEfilingGate(r).allowed,
  };
}

/** Post `make(date)` late (in P) then on time (in NEXT); the gate must move identically. */
async function expectParity(make: (date: string, lateClaim: boolean) => Promise<unknown>, lateDate: string, onTimeDate: string) {
  const g0 = await gate();
  await make(lateDate, true);
  const g1 = await gate();
  await make(onTimeDate, false);
  const g2 = await gate();
  expect(g1.listed - g0.listed).toBe(g2.listed - g1.listed);
  expect(g1.variance - g0.variance).toBeCloseTo(g2.variance - g1.variance, 2);
  return { g0, g1, g2 };
}

describeIfDb('late input VAT claim: the filing gate reads it as the on-time posting', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLG', DATABASE_URL!);
    reimbursementId = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, level)
      VALUES (${fx.companyId}::UUID, '2300', ${`Employee reimbursements ${fx.tag}`}, 'liability',
              'other_current_liability', 'credit', true, 3)
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, employment_type, start_date, status, medical_aid_main_member)
      VALUES (${employeeId}::UUID, ${fx.companyId}::UUID, ${`VLG-${Date.now() % 1e9}`}, 'Gee', 'Late', 'permanent', CURRENT_DATE, 'active', true)`;
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM expense_claim_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE id = ${employeeId}::UUID`;
    await dropLateFixture(fx);
  }, 120000);

  it('a user bank allocation', async () => {
    await expectParity(async (date, lateClaim) => {
      const tx = await seedBankTx(fx, { date, amount: -115, description: 'Gate spend' });
      return inTx(fx, () => allocateTransaction(fx.companyId, tx, fx.expenseId, fx.userId, undefined, 'account',
        undefined, 'standard', undefined, undefined, undefined, undefined, lateClaim ? late : undefined));
    }, '2026-06-15', '2026-07-15');
  });

  it('an expense claim', async () => {
    await expectParity(async (date, lateClaim) => {
      const claim = await inTx(fx, () => createClaim({
        companyId: fx.companyId, employeeId, claimDate: date, title: 'Gate claim', createdBy: fx.userId,
        lines: [{ lineDate: date, description: 'Stationery', merchant: 'Waltons', amount: 115, vatAmount: 15,
          vatCode: 'standard', glAccountId: fx.expenseId, costCentreId: null, projectId: null, sourceDocumentId: null,
          kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null }],
      }));
      await inTx(fx, () => submitClaim(claim.id, fx.companyId));
      await inTx(fx, () => approveClaim(claim.id, fx.companyId, fx.userId));
      return inTx(fx, () => postClaimToGl(claim.id, fx.companyId, {
        userId: fx.userId, reimbursementAccountId: reimbursementId, vatInputAccountId: fx.vatInputId, allowLateInputClaim: lateClaim,
      }));
    }, '2026-06-16', '2026-07-16');
  });

  it('a manual journal', async () => {
    await expectParity(async (date, lateClaim) => inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: date, description: 'Gate manual', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0, vatType: 'standard' as const },
        { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' as const },
        { glAccountId: fx.apId, debit: 0, credit: 115 },
      ] }, fx.userId, undefined, lateClaim ? late : undefined);
      return postJournalEntry(fx.companyId, je.id, fx.userId, lateClaim ? late : undefined);
    }), '2026-06-17', '2026-07-17');
  });
});
