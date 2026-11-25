/**
 * Intercompany P4-E, fix round 1: the preview and what the person approves. E: the preview judges only what does not depend on the date (a
 * closed period today does not disable the dialog; the POST and the date field judge the date), and "partner ready" is the preflight's word
 * alone. H: the preview needs the intercompany write role (a viewer gets 403 and sees no action) and takes no row lock. J: the AP control
 * account is part of what is approved (`expected.payableAccountId`). I: the clearing journal is recorded as a person's (actor_type human).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { plantRule } from '../r035-approval.helpers';
import { acct, co, U, wipeConnections } from './intercompany.helpers';
import { dataOf, mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { setLoanClearing } from './loan-clearing.helpers';
import {
  clearBill, clearBody, clearConnect, clearedOf, errorText, payable, payerSetup, plantBill, previewAs, refusedUntouched,
} from './payer-clear.helpers';
import type { LoanClearingPreview } from '../../../src/modules/accounting/services/intercompany/payerLoanClearTypes';

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

const preview = async (bill: string, user = U.b) => {
  const res = await previewAs(user, co.B, bill);
  expect(res.state.statusCode, errorText(res)).toBe(200);
  return dataOf<LoanClearingPreview & { payableAccountId: string | null }>(res);
};

describe('E: the preview judges no date', () => {
  it("every period closed today: the preview is not blocked and the partner reads ready; the POST still refuses the date", async () => {
    const b = await plantBill(pool, conn);
    await pool.query("UPDATE fiscal_periods SET status = 'closed' WHERE company_id = $1", [co.B]);
    try {
      expect(await preview(b.bill)).toMatchObject({ blocked: null, receiverReady: true, linked: true });
      await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b)), 400, /period/i);
    } finally {
      await pool.query("UPDATE fiscal_periods SET status = 'open' WHERE company_id = $1", [co.B]);
    }
  });

  it('blocked by an approval rule: the sentence says so, and the partner still reads ready (the preflight alone)', async () => {
    const b = await plantBill(pool, conn);
    await plantRule(pool, co.B, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: 100 });
    await pool.query("INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES ($1, 'supplier_payment', $2) ON CONFLICT DO NOTHING", [co.B, U.b]);
    try {
      const p = await preview(b.bill);
      expect(p.blocked).toMatch(/approval rule applies/);
      expect(p.receiverReady).toBe(true);
    } finally {
      await pool.query("DELETE FROM approval_enforcement WHERE company_id = $1 AND document_type = 'supplier_payment'", [co.B]);
      await pool.query("DELETE FROM approval_rules WHERE company_id = $1 AND document_type = 'supplier_payment'", [co.B]);
    }
  });

  it('the partner without the flag: not ready, and blocked with the generic partner sentence', async () => {
    const b = await plantBill(pool, conn);
    await setLoanClearing(pool, [co.A], false);
    try {
      const p = await preview(b.bill);
      expect(p.receiverReady).toBe(false);
      expect(p.blocked).toMatch(/partner company cannot clear this/);
    } finally {
      await setLoanClearing(pool, [co.A], true);
    }
  });
});

describe('H: who sees the preview, and what it holds', () => {
  it('a viewer of the payer (no intercompany write role): 403, as with the flag off (the bill page shows nothing)', async () => {
    const b = await plantBill(pool, conn);
    expect((await previewAs(U.avb, co.B, b.bill)).state.statusCode).toBe(403);
    expect((await previewAs(U.b, co.B, b.bill)).state.statusCode).toBe(200);
  });

  it('takes no row lock: a writer holding the connection, the side and the loan account does not delay it', async () => {
    const b = await plantBill(pool, conn);
    const held = await pool.connect();
    try {
      await held.query('BEGIN');
      await held.query('SELECT 1 FROM intercompany_connections WHERE id = $1 FOR UPDATE', [conn]);
      await held.query('SELECT 1 FROM intercompany_connection_sides WHERE connection_id = $1 FOR UPDATE', [conn]);
      await held.query('SELECT 1 FROM gl_accounts WHERE id = $1 FOR UPDATE', [acct.bLoan]);
      const answer = await Promise.race([
        previewAs(U.b, co.B, b.bill).then((r) => r.state.statusCode),
        new Promise<string>((resolve) => { setTimeout(() => resolve('waited'), 3000); }),
      ]);
      expect(answer).toBe(200);
    } finally {
      await held.query('ROLLBACK');
      held.release();
    }
  }, 20000);
});

describe('J and I: the AP control is approved; the journal is a person\'s', () => {
  it('the preview names the AP control by id; another id, or none, is refused before any write', async () => {
    const b = await plantBill(pool, conn);
    expect((await preview(b.bill)).payableAccountId).toBe(payable.b);
    await refusedUntouched(pool, b.bill, () => clearBill(clearBody(b, { payable: acct.bLoan })), 409, /changed since the preview/);
    const body = clearBody(b) as { expected: Record<string, unknown> };
    delete body.expected.payableAccountId;
    await refusedUntouched(pool, b.bill, () => clearBill(body), 400, /payableAccountId/);
  });

  it('the clearing journal: actor_type human, author label system:ic_loan_clear', async () => {
    const b = await plantBill(pool, conn);
    const res = await clearBill(clearBody(b));
    expect(res.state.statusCode, errorText(res)).toBe(200);
    const je = (await pool.query('SELECT actor_type, posting_agent FROM gl_journal_entries WHERE id = $1', [clearedOf(res).journalEntryId])).rows[0];
    expect(je).toEqual({ actor_type: 'human', posting_agent: 'system:ic_loan_clear' });
  });
});
