/**
 * R-032 L5: every other approve / post / process / sign-off / decide route
 * refuses a "Login as" session, and refuses it FIRST.
 *
 * Each call names a document that does not exist. The guard runs before the
 * approving service reads anything, so a Login-as session gets 403
 * IMPERSONATION_FORBIDDEN where an ordinary session gets the route's own answer
 * for a missing document (404, 400, 409 — anything but the impersonation
 * refusal). The document types with a real draft behind them are in
 * r-032-l5-document-approvals.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import supplierCreditNotes from '../../pages/api/accounting/supplier-credit-notes';
import batchPaymentsAction from '../../pages/api/accounting/batch-payments-action';
import netcashSubmit from '../../pages/api/accounting/netcash/submit';
import closeRunDecide from '../../pages/api/accounting/close-run/decide';
import payrollRunApprove from '../../pages/api/payroll/runs/[id]/approve';
import payrollBatchPost from '../../pages/api/payroll/batches/[id]/post';
import expenseClaimApprove from '../../pages/api/accounting/expense-claims/[id]/approve';
import expenseClaimPost from '../../pages/api/accounting/expense-claims/[id]/post';
import writeOffsAction from '../../pages/api/accounting/write-offs-action';
import adjustmentsAction from '../../pages/api/accounting/adjustments-action';
import vatAdjustmentsAction from '../../pages/api/accounting/vat-adjustments-action';
import timeEntriesAction from '../../pages/api/accounting/time-entries-action';
import practiceTimeApprove from '../../pages/api/accounting/practice/time-entries/approve';
import commentaryApprove from '../../pages/api/accounting/commentary/[id]/approve';
import commentaryReject from '../../pages/api/accounting/commentary/[id]/reject';
import afsSignOff from '../../pages/api/accounting/afs/[documentId]/sign-off';
import afsSectionSignOff from '../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/sign-off';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Call, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 L5 routes');
const missing = crypto.randomUUID();
const other = crypto.randomUUID();
const reimbursementAccount = crypto.randomUUID();

beforeAll(async () => {
  await fx.setUp();
  // Netcash submit validates the company's switch before it reaches the bank call.
  await pool.query(`UPDATE companies SET netcash_enabled=true, netcash_service_key='r032', netcash_payouts_key='r032'
    WHERE id=$1`, [fx.company]);
  // Expense-claim post validates its reimbursement account before the claim.
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
    VALUES($1,$2,'8899','R032 reimbursements','liability','credit')`, [reimbursementAccount, fx.company]);
});
afterAll(async () => {
  try { await fx.tearDown(); } finally { await pool.end(); }
});

type Case = { name: string; handler: NextApiHandler; call: Call };
const CASES: Case[] = [
  { name: 'supplier credit note post', handler: supplierCreditNotes,
    call: { method: 'PATCH', body: { id: missing, action: 'post' } } },
  { name: 'batch payment approve', handler: batchPaymentsAction, call: { body: { action: 'approve', id: missing } } },
  { name: 'batch payment process', handler: batchPaymentsAction, call: { body: { action: 'process', id: missing } } },
  { name: 'Netcash EFT submit', handler: netcashSubmit, call: { body: { payments: [
    { accountHolder: 'R032', bankCode: '250655', accountNumber: '62000000000', amount: 100, reference: 'r032' }] } } },
  { name: 'close-run proposal approve', handler: closeRunDecide,
    call: { body: { runId: missing, proposalId: other, decision: 'approve' } } },
  { name: 'close-run proposal reject', handler: closeRunDecide,
    call: { body: { runId: missing, proposalId: other, decision: 'reject' } } },
  { name: 'pay run approve', handler: payrollRunApprove, call: { query: { id: missing } } },
  { name: 'payroll batch post', handler: payrollBatchPost, call: { query: { id: missing } } },
  { name: 'expense claim approve', handler: expenseClaimApprove, call: { query: { id: missing }, body: { decision: 'approve' } } },
  { name: 'expense claim reject', handler: expenseClaimApprove, call: { query: { id: missing }, body: { decision: 'reject' } } },
  { name: 'expense claim post', handler: expenseClaimPost, call: { query: { id: missing }, body: { reimbursementAccountId: reimbursementAccount } } },
  { name: 'write-off approve', handler: writeOffsAction, call: { body: { action: 'approve', id: missing } } },
  { name: 'stock adjustment approve', handler: adjustmentsAction, call: { body: { action: 'approve', id: missing } } },
  { name: 'VAT adjustment approve', handler: vatAdjustmentsAction, call: { body: { action: 'approve', id: missing } } },
  { name: 'time entries approve', handler: timeEntriesAction, call: { body: { action: 'approve', ids: [missing] } } },
  { name: 'practice time entries approve', handler: practiceTimeApprove, call: { body: { ids: [missing] } } },
  { name: 'report commentary approve', handler: commentaryApprove, call: { query: { id: missing } } },
  { name: 'report commentary reject', handler: commentaryReject, call: { query: { id: missing } } },
  { name: 'AFS document sign-off', handler: afsSignOff, call: { query: { documentId: missing } } },
  { name: 'AFS section sign-off', handler: afsSectionSignOff, call: { query: { documentId: missing, sectionId: other } } },
];

const ledgerAndAudit = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM gl_journal_entries WHERE company_id=$1) AS journals,
    (SELECT count(*) FROM audit_log WHERE company_id=$1) AS audits,
    (SELECT count(*) FROM netcash_submissions WHERE company_id=$1) AS netcash`, [fx.company])).rows[0];

describe('R-032 L5 — Login-as is refused on every approving route, before the document is read', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403 IMPERSONATION_FORBIDDEN', async ({ handler, call }) => {
    const before = await ledgerAndAudit();
    const result = await fx.call(handler, loginAs, call);
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await ledgerAndAudit()).toEqual(before);
  });

  it.each(CASES)('does not refuse $name on the target\'s own session', async ({ handler, call }) => {
    const result = await fx.call(handler, await fx.ownSession(), call);
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
  });
});
