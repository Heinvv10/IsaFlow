/**
 * Bank controls step 2 (Hein, decision 2): every importer check judges the
 * SAME arm (bankLineImporterGate.importerArmOf) and the SAME importer for the
 * same line, whichever path reaches it. One importer-owned line per path —
 * the screen (account, transfer, split, supplier, customer REFUND), MCP
 * (allocate, bulk, split, apply), the rule sweep (a customer rule on an
 * outflow, an account rule to a bank account), the provisional poster and the
 * categorisation sweep — each refused or skipped; and the edges every path
 * shares: the importer's id in another letter case is still the importer; a
 * batch id with no batch row names nobody; a sweep run for nobody (the zero
 * uuid) cannot show it was not run for the importer, so it holds the line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import provisionalOutstanding from '../../pages/api/accounting/provisional/outstanding';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { splitAllocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankSplit';
import { sweep } from '../../src/modules/accounting/services/bank/autoPostGateService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import { inRequest } from './r035-pr5.helpers';
import {
  actionRoute, bankCompany, cleanupBankControlsA, enforce, lineStatus, mcpCaller, PAY_TYPES, plantBatch, plantLine, refusalOf,
  type BankCompany,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
const mcp = mcpCaller(pool, [allocateBankTransactionTool, bulkAllocateBankTransactionsTool, splitAllocateBankTransactionTool]);
const HELD = /You imported this bank statement, so while manual-journal approval is on you cannot allocate its lines yourself/;
let seq = 0;
const key = () => `bc-a-par-${Date.now()}-${seq++}`;

beforeAll(async () => {
  a = await createUser(pool, tokens);
  b = await createUser(pool, tokens);
  act = actionRoute(tokens);
});
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

async function fixture(): Promise<BankCompany & { batch: string }> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await enforce(pool, f.c, a, ['manual_journal', ...PAY_TYPES]);
  return { ...f, batch: await plantBatch(pool, f, a) };
}
const desc = (line: string, d: string) => pool.query('UPDATE bank_transactions SET description = $2 WHERE id = $1', [line, d]);

describe('the screen: every journal arm, and a customer refund (money OUT), refuses the importer alike', () => {
  it('account, transfer, split and a customer refund are 403 IMPORTER_MAY_NOT_ALLOCATE; another member allocates them', async () => {
    const f = await fixture();
    const receipt = await plantLine(pool, f, f.batch, 1000); // b receipts R1 000 so the customer has credit to refund
    expect((await act(b, f.c, { action: 'allocate', bankTransactionId: receipt, allocationType: 'customer', entityId: f.customer }))
      .state.statusCode).toBe(200);
    const bodies = [
      { allocationType: 'account', contraAccountId: f.expA },
      { allocationType: 'transfer', contraAccountId: f.bank2 },
      { allocationType: 'customer', entityId: f.customer },
    ];
    for (const body of bodies) {
      const line = await plantLine(pool, f, f.batch, -500);
      const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, ...body });
      expect(refusalOf(res), `${body.allocationType}: ${JSON.stringify(res.state.body)}`).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
      expect((await act(b, f.c, { action: 'allocate', bankTransactionId: line, ...body })).state.statusCode).toBe(200);
    }
    const split = await plantLine(pool, f, f.batch, -500);
    const res = await act(a, f.c, { action: 'split_allocate', bankTransactionId: split,
      lines: [{ contraAccountId: f.expA, amount: 200 }, { contraAccountId: f.expB, amount: 300 }] });
    expect(refusalOf(res)).toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
  });
});

describe('the same line through every other path', () => {
  it('MCP allocate, bulk (dry run and live) and split all hold it', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch);
    const one = await mcp(a, f.c, 'allocate_bank_transaction', { transaction_id: line, alloc_type: 'account', contra_account_id: f.expA, idempotency_key: key() });
    expect(one.content[0]!.text).toMatch(HELD);
    for (const dry of [true, false]) {
      const bulk = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { dry_run: dry, idempotency_key: key(),
        allocations: [{ transaction_id: line, alloc_type: 'account', contra_account_id: f.expA }] });
      expect(bulk.content[0]!.text).toMatch(HELD);
    }
    const split = await mcp(a, f.c, 'split_allocate_bank_transaction', { transaction_id: line, dry_run: true, idempotency_key: key(),
      lines: [{ contra_account_id: f.expA, amount: 1000 }, { contra_account_id: f.expB, amount: 500 }] });
    expect(split.content[0]!.text).toMatch(HELD);
    expect(await lineStatus(pool, line)).toBe('imported');
  });

  it('the rule sweep holds a customer rule on an outflow and an account rule to a bank account; another member posts both', async () => {
    const f = await fixture();
    const refund = await plantLine(pool, f, f.batch, -250);
    const xfer = await plantLine(pool, f, f.batch, -260);
    await desc(refund, 'PAR CUSTOUT');
    await desc(xfer, 'PAR XFER');
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_pattern, client_id, gl_account_id, auto_create_entry, created_by)
       VALUES($1,'PAR customer','CUSTOUT',$2,NULL,true,$4),($1,'PAR transfer','XFER',NULL,$3,true,$4)`, [f.c, f.customer, f.bank2, a]);
    const apply = async (user: string) => dataOf<{ applied: number; autoPostSkippedApprovalRequired: number }>(await callRoute(
      bankRulesAction as never, tokens[user]!, f.c, 'POST', { action: 'apply', bankAccountId: f.bank }, '/api/accounting/bank-rules-action'));
    expect(await apply(a)).toMatchObject({ applied: 0, autoPostSkippedApprovalRequired: 2 });
    expect(await apply(b)).toMatchObject({ applied: 2, autoPostSkippedApprovalRequired: 0 });
  });

  it('the provisional poster (route) and the categorisation sweep hold it for the importer', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch, -300);
    const prov = await callRoute(provisionalOutstanding as never, tokens[a]!, f.c, 'POST', { bankTxIds: [line] },
      '/api/accounting/provisional/outstanding');
    expect(dataOf<{ results: { skipped?: string }[] }>(prov).results[0]).toMatchObject({ skipped: 'approval_required' });
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    await pool.query('UPDATE bank_transactions SET suggested_gl_account_id = $2, suggested_confidence = 0.95 WHERE id = $1', [line, f.expA]);
    const res = await inRequest(pool, a, f.c, () => sweep(f.c, [line], 'categorization', a, a));
    expect(res.skipped).toEqual([{ txId: line, reason: expect.stringMatching(/^approval_required: You imported/) }]);
    expect(await lineStatus(pool, line)).toBe('imported');
  });
});

describe('the edges every path shares', () => {
  it("the importer's id in another letter case is still the importer", async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, await plantBatch(pool, f, a.toUpperCase()));
    expect(refusalOf(await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA })))
      .toMatchObject({ status: 403, reason: 'IMPORTER_MAY_NOT_ALLOCATE' });
    const bulk = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { dry_run: true, idempotency_key: key(),
      allocations: [{ transaction_id: line, alloc_type: 'account', contra_account_id: f.expA }] });
    expect(bulk.content[0]!.text).toMatch(HELD);
  });

  it('a batch id with no batch row names nobody: the screen and MCP bulk both allocate it', async () => {
    const f = await fixture();
    const [screen, agent] = [await plantLine(pool, f, crypto.randomUUID()), await plantLine(pool, f, crypto.randomUUID())];
    expect((await act(a, f.c, { action: 'allocate', bankTransactionId: screen, allocationType: 'account', contraAccountId: f.expA }))
      .state.statusCode).toBe(200);
    const bulk = await mcp(a, f.c, 'bulk_allocate_bank_transactions', { idempotency_key: key(),
      allocations: [{ transaction_id: agent, alloc_type: 'account', contra_account_id: f.expA }] });
    expect(bulk.isError, bulk.content[0]!.text).toBeFalsy();
    expect(await lineStatus(pool, agent)).toBe('allocated');
  });

  it('a sweep run for nobody (the zero uuid) holds a person\'s import, failing closed', async () => {
    const f = await fixture();
    const line = await plantLine(pool, f, f.batch, -300);
    await pool.query(`INSERT INTO bank_auto_post_settings(company_id, enabled, min_confidence, amount_cap, llm_enabled,
      llm_min_confidence, llm_amount_cap, updated_at) VALUES ($1, true, 0.50, 0, false, 0.95, 2000, NOW())`, [f.c]);
    const nobody = '00000000-0000-0000-0000-000000000000';
    const res = await inRequest(pool, b, f.c, () => sweep(f.c, [line], 'import', nobody, nobody));
    expect(res.skipped).toEqual([{ txId: line, reason: 'approval_required' }]);
  });
});
