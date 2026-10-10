/**
 * Bank controls step 2 (Hein, decision 2): importer ≠ allocator through MCP.
 * The actor is the token's user. Every tool refuses before any write, and
 * every tool with a dry run reports the same refusal as its live call: the
 * single allocate (a clean tool error), the split (dry run and live), the
 * supplier-payment apply from a bank line (dry run and live), and the bulk
 * allocate, whose dry run and live call skip the same importer-owned lines —
 * on the account AND supplier-outflow arms (MCP has no transfer alloc_type) —
 * as `approval_required`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { splitAllocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankSplit';
import { applyPaymentToSupplierInvoiceTool } from '../../src/lib/mcp/tools/writeApplySupplierPayment';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { plantBill } from './r035-pr5.helpers';
import {
  bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, PAY_TYPES, plantBatch, plantLine, type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const mcp = mcpCaller(pool, [allocateBankTransactionTool, bulkAllocateBankTransactionsTool, splitAllocateBankTransactionTool,
  applyPaymentToSupplierInvoiceTool]);
const JOURNAL = /You imported this bank statement, so while manual-journal approval is on you cannot allocate its lines yourself/;
const PAYMENT = /You imported this bank statement, so while supplier-payment approval is on you cannot allocate its lines yourself/;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
});
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

async function fixture(): Promise<BankCompany & { batch: string }> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await enforce(pool, f.c, a, ['manual_journal', ...PAY_TYPES]);
  return { ...f, batch: await plantBatch(pool, f, a) };
}
const journals = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n as number;
let seq = 0;
const key = () => `bc-a-mcp-${Date.now()}-${seq++}`;

describe('allocate_bank_transaction', () => {
  it('refuses the importer with a clean tool error and nothing written; another member allocates', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch);
    const args = { transaction_id: line, alloc_type: 'account', contra_account_id: f.expA };
    const refused = await mcp(a, f.c, 'allocate_bank_transaction', { ...args, idempotency_key: key() });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(JOURNAL);
    expect(await journals(f.c)).toBe(0);
    const ok = await mcp(b, f.c, 'allocate_bank_transaction', { ...args, idempotency_key: key() });
    expect(ok.isError, ok.content[0]!.text).toBeFalsy();
    expect(await lineStatus(pool, line)).toBe('allocated');
  });
});

describe('split_allocate_bank_transaction', () => {
  it('the dry run reports the same refusal as the live call; nothing is written', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch);
    const lines = [{ contra_account_id: f.expA, amount: 1000 }, { contra_account_id: f.expB, amount: 500 }];
    for (const dry of [true, false]) {
      const res = await mcp(a, f.c, 'split_allocate_bank_transaction', { transaction_id: line, lines, dry_run: dry, idempotency_key: key() });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(JOURNAL);
    }
    expect(await journals(f.c)).toBe(0);
    const ok = await mcp(b, f.c, 'split_allocate_bank_transaction', { transaction_id: line, lines, idempotency_key: key() });
    expect(ok.isError, ok.content[0]!.text).toBeFalsy();
  });
});

describe('apply_payment_to_supplier_invoice from a bank line', () => {
  it('the dry run reports the same refusal as the live call; nothing is written; another member applies it', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch);
    const bill = await plantBill(pool, f.c, f.supplier, b, 1500);
    const args = { bank_transaction_id: line, allocations: [{ invoice_id: bill, amount: 1500 }] };
    for (const dry of [true, false]) {
      const res = await mcp(a, f.c, 'apply_payment_to_supplier_invoice', { ...args, dry_run: dry, idempotency_key: key() });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toMatch(PAYMENT);
    }
    expect(await journals(f.c)).toBe(0);
    const ok = await mcp(b, f.c, 'apply_payment_to_supplier_invoice', { ...args, idempotency_key: key() });
    expect(ok.isError, ok.content[0]!.text).toBeFalsy();
  });
});

describe('bulk_allocate_bank_transactions', () => {
  it('the dry run and the live call skip the importer\'s lines alike on every gated arm, and post the rest', async () => {
    const f = await fixture();
    const account = await plantLine(pool, f, f.batch);
    const pay = await plantLine(pool, f, f.batch);
    const receipt = await plantLine(pool, f, f.batch, 700); // money in: ungated
    const others = await plantLine(pool, f, await plantBatch(pool, f, b));
    const allocations = [
      { transaction_id: account, alloc_type: 'account', contra_account_id: f.expA },
      { transaction_id: pay, alloc_type: 'supplier', entity_id: f.supplier },
      { transaction_id: receipt, alloc_type: 'customer', entity_id: f.customer },
      { transaction_id: others, alloc_type: 'account', contra_account_id: f.expA },
    ];
    const replies: string[] = [];
    for (const dry of [true, false]) {
      const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { allocations, dry_run: dry, idempotency_key: key() });
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      const body = JSON.parse(res.content[0]!.text) as { skipped: { transaction_id: string; reason: string }[] };
      const skipped = Object.fromEntries(body.skipped.map((s) => [s.transaction_id, s.reason]));
      expect(Object.keys(skipped).sort()).toEqual([account, pay].sort());
      expect(skipped[account]).toMatch(new RegExp(`^approval_required: ${JOURNAL.source}`));
      expect(skipped[pay]).toMatch(new RegExp(`^approval_required: ${PAYMENT.source}`));
      replies.push(JSON.stringify(body.skipped));
    }
    expect(replies[0]).toBe(replies[1]);
    expect(await Promise.all([account, pay, receipt, others].map((id) => lineStatus(pool, id))))
      .toEqual(['imported', 'imported', 'allocated', 'allocated']);
  });
});
