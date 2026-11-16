/**
 * Hein, 2026-11-15: a customer REFUND out of a bank line keyed by hand gets the same approval gate a manual journal
 * gets (bankLineRefundGate). Customer receipts (money in) stay ungated; so do bank-evidenced lines (a feed or an
 * imported statement is proof the money moved). Every door a refund can leave a hand-keyed line by is refused 409
 * before any write: the manual route, the allocate action, the MCP allocate and bulk tools, split, and the rule sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import bankTransactionsManual from '../../pages/api/accounting/bank-transactions-manual';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankRulesAction from '../../pages/api/accounting/bank-rules-action';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { cleanupPr6, enforceJournals, journalRoutes, journalRule, plantJournal } from './r035-pr6.helpers';
import { bankCompany, cleanupBankControlsA, enforce, mcpCaller, PAY_TYPES, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
const routes = journalRoutes(tokens);
const mcp = mcpCaller(pool, [allocateBankTransactionTool, bulkAllocateBankTransactionsTool]);

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_categorisation_rules WHERE company_id = ANY($1)', [companies]);
  await pool.query('DELETE FROM bank_transactions WHERE company_id = ANY($1)', [companies]);
  await cleanupBankControlsA(pool, companies, [a, b]); // runs PR6's teardown, which ends the pool
});

/** Two admins, a customer, an admin rule over R1 000 on manual journals; enforced unless told otherwise. */
async function fixture(enforced = true): Promise<BankCompany> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  await journalRule(plantRule, pool, f.c, { role: 'admin' });
  if (enforced) await enforceJournals(pool, f.c, a);
  return f;
}
async function plantLine(f: BankCompany, provenance: 'manual' | 'import', amount = -1500): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
     VALUES($1,$2,DATE '2026-09-01',$3,'REFUND line','imported',$4) RETURNING id`,
    [f.c, f.bank, amount, provenance === 'import' ? crypto.randomUUID() : null])).rows[0].id;
}
const counts = async (c: string) => (await pool.query(
  `SELECT (SELECT count(*)::INT FROM bank_transactions WHERE company_id = $1) AS lines,
          (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals`, [c])).rows[0] as { lines: number; journals: number };
const statusOf = async (id: string) => (await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [id])).rows[0].status as string;
const call = (handler: unknown, c: string, body: unknown, url: string, user = a) => callRoute(handler as never, tokens[user]!, c, 'POST', body, url);
const manual = (f: BankCompany, o: Record<string, unknown>) => call(bankTransactionsManual, f.c, {
  type: 'spend', bankAccountId: f.bank, date: '2026-09-01', amount: 1500, description: 'keyed by hand',
  allocationType: 'customer', entityId: f.customer, ...o }, '/api/accounting/bank-transactions-manual');
const act = (f: BankCompany, body: Record<string, unknown>) => call(bankTransactionsAction, f.c, body, '/api/accounting/bank-transactions-action');
const refused = (res: { state: { statusCode: number; body: unknown } }) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
  expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  expect(messageOf(res)).toMatch(/refunding a customer R1500\.00.*manual journal.*needs admin approval.*Journal Entries/s);
};
const notTheGate = (res: { state: { statusCode: number; body: unknown } }) => expect(reasonOf(res)).not.toBe('APPROVAL_REQUIRED');

describe('door 1: Spend Money to a customer on a hand-keyed line (the manual route)', () => {
  it('is refused 409 with nothing written; a receipt in, a refund below the rule, and enforcement off are not', async () => {
    const f = await fixture();
    const before = await counts(f.c);
    refused(await manual(f, {}));
    expect(await counts(f.c)).toEqual(before);
    notTheGate(await manual(f, { type: 'receive' }));              // money IN: a receipt
    notTheGate(await manual(f, { amount: 500 }));                  // below the rule
    const off = await fixture(false);
    notTheGate(await manual(off, {}));
    expect((await counts(f.c)).journals).toBeGreaterThan(before.journals);
  });

  it('a receipt posts at once (201)', async () => {
    const f = await fixture();
    const res = await manual(f, { type: 'receive' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(201);
  });

  it('the way out is the manual-journal flow: the creator cannot approve their own refund journal, another admin can, and it posts', async () => {
    const f = await fixture();
    const journal = await plantJournal(pool, f, a, { amount: 1500 }); // the refund recorded as a journal by `a`
    expect((await routes.post(a, f.c, journal)).state.statusCode).toBe(409); // not posted until approved
    const raised = await routes.raise(a, f.c, journal);
    expect(raised.state.statusCode, JSON.stringify(raised.state.body)).toBe(200);
    const requestId = dataOf<{ id: string }>(raised).id;
    const self = await routes.decide(pool, a, f.c, requestId);
    expect(self.state.statusCode, JSON.stringify(self.state.body)).toBeGreaterThanOrEqual(400); // segregation of duties
    const approved = await routes.decide(pool, b, f.c, requestId);
    expect(approved.state.statusCode, JSON.stringify(approved.state.body)).toBe(200);
    expect((await routes.post(b, f.c, journal)).state.statusCode).toBe(200);
  });
});

describe('door 2: allocating an existing negative line to a customer (the allocate action, reallocation, the auto-post gate)', () => {
  it('a hand-keyed line is refused 409 before any write; an imported line, a small refund and a receipt are not', async () => {
    const f = await fixture();
    const handKeyed = await plantLine(f, 'manual');
    const before = await counts(f.c);
    refused(await act(f, { action: 'allocate', bankTransactionId: handKeyed, allocationType: 'customer', entityId: f.customer }));
    expect(await counts(f.c)).toEqual(before);
    expect(await statusOf(handKeyed)).toBe('imported');
    notTheGate(await act(f, { action: 'allocate', bankTransactionId: await plantLine(f, 'import'), allocationType: 'customer', entityId: f.customer }));
    notTheGate(await act(f, { action: 'allocate', bankTransactionId: await plantLine(f, 'manual', -500), allocationType: 'customer', entityId: f.customer }));
    const receipt = await act(f, { action: 'allocate', bankTransactionId: await plantLine(f, 'manual', 1500), allocationType: 'customer', entityId: f.customer });
    expect(receipt.state.statusCode, JSON.stringify(receipt.state.body)).toBe(200);
  });
});

describe('door 3: split_allocate with a customer line on a negative hand-keyed line', () => {
  it('is refused 409 before any write; the same split on an imported line is not', async () => {
    const f = await fixture();
    const handKeyed = await plantLine(f, 'manual');
    const before = await counts(f.c);
    const lines = [{ contactType: 'customer', contactId: f.customer, amount: 1200 }, { contraAccountId: f.expB, amount: 300 }];
    const res = await act(f, { action: 'split_allocate', bankTransactionId: handKeyed, lines });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await counts(f.c)).toEqual(before);
    notTheGate(await act(f, { action: 'split_allocate', bankTransactionId: await plantLine(f, 'import'), lines }));
  });
});

describe('door 3b: a refund split across customers is judged at the whole line', () => {
  it('two customer parts each under the rule, together over it: 409, nothing written; one part under the rule is not held', async () => {
    const f = await fixture();
    const second = (await pool.query('INSERT INTO customers(company_id,name) VALUES($1,$2) RETURNING id', [f.c, 'BC second customer'])).rows[0].id;
    const handKeyed = await plantLine(f, 'manual', -1200);
    const before = await counts(f.c);
    const res = await act(f, { action: 'split_allocate', bankTransactionId: handKeyed, lines: [
      { contactType: 'customer', contactId: f.customer, amount: 600 }, { contactType: 'customer', contactId: second, amount: 600 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await counts(f.c)).toEqual(before);
    expect(await statusOf(handKeyed)).toBe('imported');
    const small = await plantLine(f, 'manual', -900); // the whole line under the R1 000 rule
    notTheGate(await act(f, { action: 'split_allocate', bankTransactionId: small, lines: [
      { contactType: 'customer', contactId: f.customer, amount: 450 }, { contactType: 'customer', contactId: second, amount: 450 }] }));
  });
});

describe('door 3c: a payment split across suppliers is judged at what the line pays, not per supplier', () => {
  it('two supplier parts each under the supplier_payment rule, together over it: 409, nothing written', async () => {
    const f = await fixture(false);
    await plantRule(pool, f.c, 'admin', { documentType: 'supplier_payment', operator: 'greater_than', value: 1000, name: 'Payments sign' });
    await enforce(pool, f.c, a, PAY_TYPES);
    const second = (await pool.query('INSERT INTO suppliers(company_id,name) VALUES($1,$2) RETURNING id', [f.c, 'BC second supplier'])).rows[0].id;
    const handKeyed = await plantLine(f, 'manual', -1200);
    const before = await counts(f.c);
    const res = await act(f, { action: 'split_allocate', bankTransactionId: handKeyed, lines: [
      { contactType: 'supplier', contactId: f.supplier, amount: 600 }, { contactType: 'supplier', contactId: second, amount: 600 }] });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(await counts(f.c)).toEqual(before);
    expect(await statusOf(handKeyed)).toBe('imported');
  });
});

describe('door 4: the MCP allocate and bulk tools', () => {
  it('allocate refuses with nothing written; the bulk dry run and live call skip it alike; an imported line is not held', async () => {
    const f = await fixture();
    const handKeyed = await plantLine(f, 'manual');
    const one = await mcp(a, f.c, 'allocate_bank_transaction', { transaction_id: handKeyed, alloc_type: 'customer', entity_id: f.customer,
      idempotency_key: `refund-one-${handKeyed}` });
    expect(one.isError).toBe(true);
    expect(one.content[0]!.text).toMatch(/refunding a customer.*needs admin approval/s);
    for (const dry of [true, false]) {
      const res = await mcp(a, f.c, 'bulk_allocate_bank_transactions', {
        allocations: [{ transaction_id: handKeyed, alloc_type: 'customer', entity_id: f.customer }], dry_run: dry,
        idempotency_key: `refund-bulk-${dry}-${handKeyed}` });
      // With every line skipped the call says so ("nothing to post") as an error; the reason is what is pinned.
      expect(res.content[0]!.text).toMatch(/approval_required: .*refunding a customer/s);
    }
    expect(await statusOf(handKeyed)).toBe('imported');
  });
});

describe('door 5: the bank-rule sweep and the auto-post gate', () => {
  const sweep = async (f: BankCompany) => {
    await pool.query(
      `INSERT INTO bank_categorisation_rules(company_id, rule_name, match_field, match_type, match_pattern, client_id, auto_create_entry, created_by)
       VALUES($1,'Refund sweep','description','contains','REFUND',$2,true,$3)`, [f.c, f.customer, a]);
    return call(bankRulesAction, f.c, { action: 'apply', bankAccountId: f.bank }, '/api/accounting/bank-rules-action');
  };

  it('skips a hand-keyed customer refund (counted approval_required); an imported line is not held by the gate', async () => {
    const f = await fixture();
    const handKeyed = await plantLine(f, 'manual');
    const imported = await plantLine(f, 'import');
    const res = await sweep(f);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf<{ autoPostSkippedApprovalRequired: number }>(res).autoPostSkippedApprovalRequired).toBe(1);
    expect(await statusOf(handKeyed)).toBe('imported');
    void imported;
  });
});
