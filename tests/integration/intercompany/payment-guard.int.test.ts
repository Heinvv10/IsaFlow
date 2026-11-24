/**
 * Intercompany F: the guard's H2 rules that RLS or another rule would otherwise hide, and the service's own flag check. As the table
 * owner (migration_admin: no RLS, the guard still runs its person branch) a forged receipt of ANOTHER company naming the receiver's customer
 * on one of the receiver's journals is refused (company_id = the receiver), and so is a cancelled receipt whose journal was left standing
 * (the existing branch takes confirmed / reconciled only). The service refuses `not_enabled` itself, not only through its route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { acceptPaymentMessage } from '../../../src/modules/accounting/services/intercompany/paymentAcceptService';
import { asAppUser, asOwner, outcome } from './intercompany.helpers';
import { asService, mirrorCleanup, wipeConnections } from './mirror.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearPayments } from './allocation.helpers';
import { cashConnect, clearReceipts, co, party, paymentSetup, plantReceipt, rows, sentPayment, U } from './payment.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => paymentSetup(pool), 60000);
afterAll(async () => { await clearReceipts(pool); await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearReceipts(pool);
  await clearPayments(pool);
  await wipeConnections(pool);
  await setLoanClearing(pool, [co.A, co.B, co.C], true);
  conn = await cashConnect(pool);
});

const ACCEPT = "UPDATE intercompany_messages SET status = 'accepted', target_doc_type = 'customer_payment', target_doc_id = $2 WHERE id = $1";
const asTableOwner = (m: string, target: string) => asOwner(pool, U.a, co.A, (q) => outcome(q, ACCEPT, [m, target]));

describe('H2 beyond RLS', () => {
  it('control: as the table owner a real candidate receipt is accepted', async () => {
    const s = await sentPayment(pool, conn);
    expect(await asTableOwner(s.message, await plantReceipt(pool))).toBe('ok');
  });

  it("a receipt of ANOTHER company naming the receiver's customer, on the receiver's own journal, is refused", async () => {
    const s = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool);
    await pool.query('UPDATE customer_payments SET company_id = $2 WHERE id = $1', [receipt, co.C]);
    expect(await asTableOwner(s.message, receipt)).toMatch(/^23514: a payment message is accepted with a receipt/);
    expect((await rows.message(pool, s.message)).status).toBe('pending');
  });

  it('a CANCELLED receipt whose journal was left standing is refused (confirmed / reconciled only)', async () => {
    const s = await sentPayment(pool, conn);
    const receipt = await plantReceipt(pool);
    await pool.query("UPDATE customer_payments SET status = 'cancelled' WHERE id = $1", [receipt]);
    expect(await asTableOwner(s.message, receipt)).toMatch(/^23514: a payment message is accepted with a receipt/);
  });
});

describe('consumption in the guard (a direct app_user UPDATE)', () => {
  it('a receipt absorbs accepted payment messages up to its total: the second R600 onto a R1 150 receipt that already took R600 is refused', async () => {
    const one = await sentPayment(pool, conn, { amount: 600 });
    const two = await sentPayment(pool, conn, { amount: 600 });
    const receipt = await plantReceipt(pool, { amount: 1150 });
    const direct = (m: string) => asAppUser(pool, U.a, co.A, (q) => outcome(q, ACCEPT, [m, receipt]), true);
    expect(await direct(one.message)).toBe('ok');
    expect(await direct(two.message)).toMatch(/^23514: a (receipt absorbs accepted payment messages up to its total|payment message is accepted with a receipt)/);
    expect((await rows.message(pool, two.message)).status).toBe('pending');
  });
});

describe('the service itself', () => {
  it("refuses not_enabled when the receiver's flag is off, before anything (not only through its route)", async () => {
    const s = await sentPayment(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    const err = await asService(pool, U.a, co.A, () => acceptPaymentMessage({
      companyId: co.A, messageId: s.message, userId: U.a,
      input: { outcome: 'existing', receiptId: crypto.randomUUID(), expected: { amount: 1150, state: 'open' } },
    })).then(() => null, (e: unknown) => e as { code?: string });
    expect(err?.code).toBe('not_enabled');
    expect(party.aCustomer).toBeTruthy();
  });
});
