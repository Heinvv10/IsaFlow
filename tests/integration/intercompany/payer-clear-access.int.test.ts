/**
 * Intercompany P4-E: who may clear a bill against the intercompany loan, and the dark flag. With `intercompany_loan_clearing` off for the payer
 * the route (POST and the preview) and the service refuse 403 before anything is read or written. A viewer, a manager without Approve on
 * Suppliers & AP, a Login-as session and a session without a session id are refused 403 BEFORE posting (the allocation message is silently
 * skipped for a user without the write role, so a clearing must not post then). An approval rule on supplier payments refuses with a plain
 * sentence, nothing posted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { impersonationToken } from '../r035-pr2.helpers';
import { plantRule } from '../r035-approval.helpers';
import { co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { sessionlessToken } from './allocation-clear-round1.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import { clearBillAgainstLoan } from '../../../src/modules/accounting/services/intercompany/payerLoanClearService';
import {
  asPerson, clearAs, clearBill, clearBody, clearConnect, errorText, payer, payerSetup, plantBill, previewAs, refusedUntouched,
} from './payer-clear.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => payerSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await clearConnect(pool);
});

/** The service itself, as `user`'s own session of B. */
const serviceAs = (user: string, b: { bill: string; link: string | null }) => {
  const body = clearBody(b);
  return asPerson(pool, user, co.B, () => clearBillAgainstLoan({
    companyId: co.B, billId: b.bill, amount: body.amount, postingDate: body.postingDate, expected: body.expected, actor: { userId: user },
  }));
};
const statusOf = async (p: Promise<unknown>) => {
  try { await p; return 200; } catch (err) { return (err as { status?: number }).status ?? 500; }
};

describe('the dark flag', () => {
  it('off for the payer: POST and preview 403, the service 403, nothing written', async () => {
    const b = await plantBill(pool, conn);
    await setLoanClearing(pool, [co.B], false);
    try {
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 403, /not enabled/i);
      expect((await previewAs(U.b, co.B, b.bill)).state.statusCode).toBe(403);
      const before = await payer.journals(pool);
      expect(await statusOf(serviceAs(U.b, b))).toBe(403);
      expect(await payer.journals(pool)).toBe(before);
      // no override at all (the flag's default): the same
      await setLoanClearing(pool, [co.B], null);
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 403, /not enabled/i);
    } finally {
      await setLoanClearing(pool, [co.B], true);
    }
    expect((await clearBill(clearBody(b))).state.statusCode).toBe(200);
  });
});

describe('who may clear', () => {
  it('a viewer, a manager without Approve on Suppliers & AP: 403 before posting', async () => {
    const b = await plantBill(pool, conn);
    await refusedUntouched(pool, b.bill, () => clearAs(U.avb, co.B, clearBody(b)), 403);
    await refusedUntouched(pool, b.bill, () => clearAs(U.mab, co.B, clearBody(b)), 403, /approve/i);
  });

  it('a Login-as session and a session without a session id: 403', async () => {
    const b = await plantBill(pool, conn);
    const res = await refusedUntouched(pool, b.bill, async () => clearAs(U.b, co.B, clearBody(b), await impersonationToken(pool, U.b, U.ab)), 403);
    expect(errorText(res)).toMatch(/IMPERSONATION_FORBIDDEN/);
    await refusedUntouched(pool, b.bill, async () => clearAs(U.b, co.B, clearBody(b), await sessionlessToken(U.b)), 403);
  });

  it('the service on its own: a viewer (no intercompany write role) and a manager without Approve are refused before posting', async () => {
    const b = await plantBill(pool, conn);
    const before = [await payer.journals(pool), await payer.payments(pool)];
    expect(await statusOf(serviceAs(U.avb, b))).toBe(403);
    expect(await statusOf(serviceAs(U.mab, b))).toBe(403);
    expect([await payer.journals(pool), await payer.payments(pool)]).toEqual(before);
    expect(await statusOf(serviceAs(U.b, b))).toBe(200);
  });

  it('the actor must be the session user of this company (a programming error otherwise, nothing written)', async () => {
    const b = await plantBill(pool, conn);
    const body = clearBody(b);
    await expect(asPerson(pool, U.b, co.B, () => clearBillAgainstLoan({
      companyId: co.B, billId: b.bill, amount: body.amount, postingDate: body.postingDate, expected: body.expected, actor: { userId: U.ab },
    }))).rejects.toThrow(/session user/);
    expect(await payer.payments(pool)).toBe(0);
  });
});

describe('R-035', () => {
  it('an enforced approval rule on supplier payments refuses with a plain sentence, nothing posted', async () => {
    const b = await plantBill(pool, conn);
    await plantRule(pool, co.B, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: 100 });
    await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES ($1, 'supplier_payment', $2) ON CONFLICT DO NOTHING", [co.B, U.b]);
    try {
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 409, /approval rule applies to payments of this size: use the normal payment route/);
    } finally {
      await pool.query("DELETE FROM approval_enforcement WHERE company_id = $1 AND document_type = 'supplier_payment'", [co.B]);
      await pool.query("DELETE FROM approval_rules WHERE company_id = $1 AND document_type = 'supplier_payment'", [co.B]);
    }
  });
});
