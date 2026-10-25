/**
 * Who may claim input VAT late (Hein's scope decision, 2026-09-25): the
 * HUMAN-initiated callers opt in — bill approve and Post to GL (single and
 * bulk), manual journal create + post, expense-claim posting — each through its
 * real route, with `lateClaim` in the response. MCP tools claim late only when
 * the caller passes allow_late_input_claim; without it they are refused as
 * today. (Bank allocation: vat-late-claim-bank.int.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { createClaim, submitClaim, approveClaim } from '@/modules/accounting/services/expense/expenseClaimService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { createDraftJournalTool, postJournalTool } from '@/lib/mcp/tools/writeJournals';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  P, balanceOf, countRows, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture,
} from './helpers/vatLateClaimFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import supplierInvoicesAction from '../../pages/api/accounting/supplier-invoices-action';
import supplierInvoicesBulkAction from '../../pages/api/accounting/supplier-invoices-bulk-action';
import journalEntries from '../../pages/api/accounting/journal-entries';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import expenseClaimPost from '../../pages/api/accounting/expense-claims/[id]/post';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
type Late = { lateClaim?: { claimDate: string; inputTax: number } };
let fx: LateFixture;
let token = '';
let reimbursementId = '';
const employeeId = randomUUID();
let seq = 0;
const textOf = (out: unknown) => (out as { content: { text: string }[] }).content[0]!.text;
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, companyRole: 'owner', tokenJti: 'jti-vlc', scopes: [] }) as unknown as McpToolContext;

describeIfDb('late input VAT claim: the human-initiated callers opt in', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLK', DATABASE_URL!);
    token = await seedRouteUser(fx, 'vlk');
    reimbursementId = String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, level)
      VALUES (${fx.companyId}::UUID, '2300', ${`Employee reimbursements ${fx.tag}`}, 'liability',
              'other_current_liability', 'credit', true, 3)
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, employment_type, start_date, status, medical_aid_main_member)
      VALUES (${employeeId}::UUID, ${fx.companyId}::UUID, ${`VLK-${Date.now() % 1e9}`}, 'Kay', 'Late', 'permanent', CURRENT_DATE, 'active', true)`;
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM expense_claim_lines WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM expense_claims WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM payroll_employees WHERE id = ${employeeId}::UUID`;
    await dropRouteUser(fx);
    await dropLateFixture(fx);
  }, 120000);

  it('supplier-invoices-action approve: 200 with lateClaim', async () => {
    const bill = await draftBill(fx, '2026-06-12');
    const state = await callRoute(fx, token, supplierInvoicesAction, { action: 'approve', invoiceId: bill.id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(dataOf<Late>(state).lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 150 });
  });

  it('supplier-invoices-bulk-action approve: each result carries lateClaim', async () => {
    const a = await draftBill(fx, '2026-06-13');
    const approve = await callRoute(fx, token, supplierInvoicesBulkAction, { action: 'approve', invoiceIds: [a.id] });
    expect(approve.statusCode, JSON.stringify(approve.body)).toBe(200);
    expect(dataOf<{ results: Late[] }>(approve).results[0]!.lateClaim).toMatchObject({ claimDate: '2026-07-01' });
  });

  /** Post to GL only ever posts a bill that is ALREADY approved (a capture-created or imported bill): it
   *  was in the filed period's figures when that return was filed, so claiming its VAT later would move a
   *  filed figure. Only an approval made in the same act may claim late (review C2). */
  it('Post to GL of an already-approved bill dated in the lock is refused as today — service and bulk route', async () => {
    const b = await draftBill(fx, '2026-06-14');
    await sql`UPDATE supplier_invoices SET status = 'approved' WHERE id = ${b.id}::UUID`;
    const before = await countRows(fx);
    const err = await inTx(fx, () => postSupplierInvoiceToGL(fx.companyId, b.id, fx.userId))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect((err as Error).name).toBe('VatPeriodLockedError');
    const post = await callRoute(fx, token, supplierInvoicesBulkAction, { action: 'post_gl', invoiceIds: [b.id] });
    expect(post.statusCode, JSON.stringify(post.body)).toBe(200);
    const item = dataOf<{ results: (Late & { ok: boolean; error?: string })[] }>(post).results[0]!;
    expect(item).toMatchObject({ ok: false });
    expect(item.error).toMatch(/locked/);
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${b.id}::UUID`) as Row[];
    expect(row!.gl_journal_entry_id).toBeNull();
  });

  it('manual journal: POST journal-entries drafts it, journal-entries-action posts it with lateClaim', async () => {
    const created = await callRoute(fx, token, journalEntries, {
      entryDate: '2026-06-20', description: 'VLK manual', lines: [
        { glAccountId: fx.expenseId, debit: 100, credit: 0, vatType: 'standard' },
        { glAccountId: fx.vatInputId, debit: 15, credit: 0, vatType: 'standard' },
        { glAccountId: fx.apId, debit: 0, credit: 115 },
      ] });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const id = dataOf<{ id: string }>(created).id;
    const posted = await callRoute(fx, token, journalEntriesAction, { id, action: 'post' });
    expect(posted.statusCode, JSON.stringify(posted.body)).toBe(200);
    expect(dataOf<Late>(posted).lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 15 });
  });

  it('expense claim post route: the claim carries lateClaim', async () => {
    const claim = await inTx(fx, () => createClaim({
      companyId: fx.companyId, employeeId, claimDate: '2026-06-22', title: 'VLK claim', createdBy: fx.userId,
      lines: [{
        lineDate: '2026-06-22', description: 'Stationery', merchant: 'Waltons', amount: 115, vatAmount: 15,
        vatCode: 'standard', glAccountId: fx.expenseId, costCentreId: null, projectId: null, sourceDocumentId: null,
        kmTravelled: null, kmRate: null, mileageFrom: null, mileageTo: null,
      }],
    }));
    await inTx(fx, () => submitClaim(claim.id, fx.companyId));
    await inTx(fx, () => approveClaim(claim.id, fx.companyId, fx.userId));
    const state = await callRoute(fx, token, expenseClaimPost,
      { reimbursementAccountId: reimbursementId, vatInputAccountId: fx.vatInputId }, { id: claim.id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(dataOf<{ claim: Late }>(state).claim.lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 15 });
  });

  it('MCP approve_supplier_invoice: refused without the argument, claims late with it', async () => {
    const bill = await draftBill(fx, '2026-06-15');
    const before = await countRows(fx);
    const err = await inTx(fx, () => approveSupplierInvoiceTool.handler(
      { invoice_id: bill.id, idempotency_key: `k${++seq}` }, ctx())).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(await countRows(fx)).toEqual(before);
    const out = await inTx(fx, () => approveSupplierInvoiceTool.handler(
      { invoice_id: bill.id, idempotency_key: `k${++seq}`, allow_late_input_claim: true }, ctx()));
    expect(textOf(out)).toContain('"claim_date":"2026-07-01"');
  });

  it('MCP create_draft_journal + post_journal claim late only with the argument', async () => {
    const lines = [
      { account_id: fx.expenseId, debit: 200, credit: 0 },
      { account_id: fx.vatInputId, debit: 30, credit: 0 },
      { account_id: fx.apId, debit: 0, credit: 230 },
    ];
    const refused = await inTx(fx, () => createDraftJournalTool.handler(
      { date: '2026-06-25', lines, idempotency_key: `k${++seq}` }, ctx()));
    expect(JSON.stringify(refused)).toMatch(/locked/);
    const draft = await inTx(fx, () => createDraftJournalTool.handler(
      { date: '2026-06-25', lines, idempotency_key: `k${++seq}`, allow_late_input_claim: true }, ctx()));
    const id = (JSON.parse(textOf(draft)) as { id: string }).id;
    const noFlag = await inTx(fx, () => postJournalTool.handler({ journal_id: id, idempotency_key: `k${++seq}` }, ctx()))
      .then(() => null, (e: unknown) => e);
    expect(noFlag).toBeInstanceOf(VatPeriodLockedError);
    const posted = await inTx(fx, () => postJournalTool.handler(
      { journal_id: id, idempotency_key: `k${++seq}`, allow_late_input_claim: true }, ctx()));
    expect(textOf(posted)).toContain('"claimDate":"2026-07-01"');
    expect(await balanceOf(fx, fx.clearingId)).toBe(0);
  });
});
