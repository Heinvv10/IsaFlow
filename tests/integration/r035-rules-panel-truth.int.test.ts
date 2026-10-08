/**
 * R-035 follow-up PR A, review round 1 (adversarial REPRO 4, blind MEDIUM):
 * the Enforce panel's no-active-rule notes for the COUPLED payment switches
 * must be true of the real gate. Each case checks the claim the panel makes
 * (ApprovalEnforcementPanel.noRuleNote) against evaluateApprovalGate and the
 * batch bank-file gate, with enforcement switched on as the switch does (both
 * types, D1).
 *  - only a payment_batch rule: a single payment is not held → the payment row
 *    "gates only payment batches" is true;
 *  - only a supplier_payment rule: a BATCH is held by its members' rule
 *    (strictestBatchRule) → the batch row must not say "gates nothing";
 *  - neither: nothing is held for approval, but a batch that is not approved
 *    cannot send its bank file → the note says exactly that.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { evaluateApprovalGate } from '../../src/modules/accounting/services/gl/approvalGate';
import { assertBatchMayBeSent, BatchNotSendableError } from '../../src/modules/accounting/services/ap/batchBankFileGate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { cleanupPr5, enforcePay, inRequest, payCompany, plantBatch, plantPayment } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', clerk: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const LARGE = { operator: 'greater_than', value: 100000, name: 'Large payments' };

async function enforcedCompany() {
  const { company, bank } = await payCompany(pool, [[u.owner, 'owner'], [u.clerk, 'bookkeeper']], companies);
  await enforcePay(pool, company, 'payment_batch', u.owner);
  return { c: company, bank };
}

it('only a payment_batch rule: a single payment is not held (the payment row "gates only payment batches")', async () => {
  const { c, bank } = await enforcedCompany();
  await plantRule(pool, c, 'admin', { ...LARGE, documentType: 'payment_batch' });
  const payment = await plantPayment(pool, c, u.clerk, bank, { amount: 150000 });
  const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
  expect(await inRequest(pool, u.clerk, c, () => evaluateApprovalGate(c, 'supplier_payment', payment.id))).toBeNull();
  expect(await inRequest(pool, u.clerk, c, () => evaluateApprovalGate(c, 'payment_batch', batch.id))).not.toBeNull();
});

it('only a supplier_payment rule: a batch IS held by its members\' rule (so the batch row says no "gates nothing")', async () => {
  const { c, bank } = await enforcedCompany();
  await plantRule(pool, c, 'admin', { ...LARGE, documentType: 'supplier_payment' });
  const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
  const refusal = await inRequest(pool, u.clerk, c, () => evaluateApprovalGate(c, 'payment_batch', batch.id));
  expect(refusal).toMatchObject({ reason: 'APPROVAL_REQUIRED' });
});

it('neither: no payment or batch is held for approval, but an unapproved batch cannot send its bank file', async () => {
  const { c, bank } = await enforcedCompany();
  const payment = await plantPayment(pool, c, u.clerk, bank, { amount: 150000 });
  const batch = await plantBatch(pool, c, u.clerk, bank, [150000]);
  expect(await inRequest(pool, u.clerk, c, () => evaluateApprovalGate(c, 'supplier_payment', payment.id))).toBeNull();
  expect(await inRequest(pool, u.clerk, c, () => evaluateApprovalGate(c, 'payment_batch', batch.id))).toBeNull();
  await expect(inRequest(pool, u.clerk, c, () => assertBatchMayBeSent(c, batch.id, 'draft')))
    .rejects.toBeInstanceOf(BatchNotSendableError);
  await expect(inRequest(pool, u.clerk, c, () => assertBatchMayBeSent(c, batch.id, 'approved'))).resolves.toBeUndefined();
});
