// tests/integration/party-join-scope-payouts.int.test.ts
//
// Money leaving: a batch member naming another company's supplier must not be
// paid to that supplier's bank account, and must not silently fall out of the
// file either (the batch's approved total would then be more than the file
// pays). The member stays, with no bank details, and the file is refused whole.
// Run as a member of both companies (who could read B's supplier and paid it)
// and of A alone (for whom RLS hid it, and the inner join shortened the file).
// The refusal says why: "Account number is required" sends the operator to edit
// bank details on a supplier that is not theirs, so it is answered first, ahead
// of the bank-verification gate too.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';

const sender = vi.hoisted(() => ({ submitEftBatch: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/netcashService', () => ({ submitEftBatch: sender.submitEftBatch }));

import eftGenerate from '../../pages/api/accounting/eft-generate';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr5, payCompany, plantApprovedBatch, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let outsider = '';

const FOREIGN_ACCOUNT = '99887766554';
const NOT_HERE = 'names a supplier that is not in this company';

/** The refusal names the payment and the cause, and nothing of the other company's. */
function explained(res: Awaited<ReturnType<typeof callRoute>>, foreign: string, paymentNumber: string) {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
  const body = JSON.stringify(res.state.body);
  expect(body).toContain(`Payment 2 (${paymentNumber}): ${NOT_HERE}`);
  expect(body).not.toContain(foreign);
  expect(body).not.toContain(`r035 ${foreign.slice(0, 6)}`);
  expect(body).not.toContain(FOREIGN_ACCOUNT);
  expect(body).not.toContain('content');
  expect(body).not.toContain('Account number');
}

beforeAll(async () => {
  user = await createUser(pool, tokens);
  outsider = await createUser(pool, tokens);
});
beforeEach(() => sender.submitEftBatch.mockReset());
afterAll(() => cleanupPr5(pool, companies, [user, outsider]));

/** An approved two-member batch of A whose second member names B's supplier, B's bank details being valid. */
async function poisonedBatch(memberOfBoth: boolean) {
  const { company: c, bank } = await payCompany(pool, [[user, 'admin']], companies);
  await pool.query("UPDATE gl_accounts SET bank_account_number = '40712345678', bank_branch_code = '198765' WHERE id = $1", [bank]);
  await pool.query("UPDATE companies SET netcash_enabled = true, netcash_service_key = 'k', netcash_payouts_key = 'k' WHERE id = $1", [c]);
  const { company: other } = await payCompany(pool, [[memberOfBoth ? user : outsider, 'admin']], companies);
  const foreign = await plantSupplier(pool, other);
  await pool.query('UPDATE suppliers SET bank_account_number = $2 WHERE id = $1', [foreign, FOREIGN_ACCOUNT]);
  const batch = await plantApprovedBatch(pool, c, user, bank);
  await pool.query('UPDATE supplier_payments SET supplier_id = $2 WHERE id = $1', [batch.members[1]!.id, foreign]);
  return { c, batch, foreign };
}

describe('a batch member naming another company\'s supplier', () => {
  const WHO = [['a member of both companies', true], ['a member of this company alone', false]] as const;

  it.each(WHO)('eft-generate refuses the file whole and never carries that supplier\'s account (%s)', async (_who, both) => {
    const { c, batch, foreign } = await poisonedBatch(both);
    const res = await callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId: batch.id, bank: 'fnb' }, '/api/accounting/eft-generate');
    explained(res, foreign, batch.members[1]!.number);
  });

  it.each(WHO)('netcash/submit refuses the batch whole and sends nothing (%s)', async (_who, both) => {
    const { c, batch, foreign } = await poisonedBatch(both);
    const res = await callRoute(netcashSubmit, tokens[user]!, c, 'POST', { batchPaymentId: batch.id }, '/api/accounting/netcash/submit');
    explained(res, foreign, batch.members[1]!.number);
    expect(sender.submitEftBatch).not.toHaveBeenCalled();
  });

  it.each([
    ['eft-generate', () => eftGenerate, (id: string) => ({ batchId: id, bank: 'fnb' }), '/api/accounting/eft-generate'],
    ['netcash/submit', () => netcashSubmit, (id: string) => ({ batchPaymentId: id }), '/api/accounting/netcash/submit'],
  ] as const)('%s answers the same under the bank-verification control, which would say to verify bank details', async (_n, route, body, url) => {
    const { c, batch, foreign } = await poisonedBatch(true);
    await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'supplier_bank_details',$2)", [c, user]);
    const res = await callRoute(route(), tokens[user]!, c, 'POST', body(batch.id), url);
    explained(res, foreign, batch.members[1]!.number);
    expect(JSON.stringify(res.state.body)).not.toContain('verif');
    expect(sender.submitEftBatch).not.toHaveBeenCalled();
  });

  it('a clean batch still goes through', async () => {
    const { c, batch, foreign } = await poisonedBatch(true);
    const own = batch.members[0]!.supplierId;
    await pool.query('UPDATE supplier_payments SET supplier_id = $2 WHERE id = $1 AND supplier_id = $3', [batch.members[1]!.id, own, foreign]);
    const res = await callRoute(eftGenerate, tokens[user]!, c, 'POST', { batchId: batch.id, bank: 'fnb' }, '/api/accounting/eft-generate');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  });
});
