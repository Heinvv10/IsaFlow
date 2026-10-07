/**
 * R-035 PR6 round 3 (Hein, 2026-10-07, blind HIGH 1 and HIGH 2): journals a
 * person composes through the bank screens are manual journals.
 *
 *  - H1: a bank-reconciliation ADJUSTMENT posts a journal to any contra account
 *    a person names. Under manual-journal enforcement, with a rule matching its
 *    amount, it is refused 409 with the reason BEFORE the journal is created —
 *    nothing written — and the message says to post it as a journal through
 *    approval.
 *  - H2: Spend / Receive Money to a GL ACCOUNT on a HAND-KEYED line — keyed
 *    with it (bank-transactions-manual), or an existing hand-keyed line
 *    allocated or split to accounts (bank-transactions-action, MCP allocate and
 *    bulk allocate) — is refused the same way. A line from a live feed or an
 *    imported statement is bank evidence (PR5's D2) and allocates as before; so
 *    does everything below the rule or with enforcement off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '../../src/lib/als';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { allocateBankTransactionTool } from '../../src/lib/mcp/tools/writeBankAllocate';
import { bulkAllocateBankTransactionsTool } from '../../src/lib/mcp/tools/writeBankBulkAllocate';
import bankTransactionsManual from '../../pages/api/accounting/bank-transactions-manual';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { cleanupPr6, enforceJournals, journalCompany, journalRule, type JournalCompany } from './r035-pr6.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(async () => {
  await pool.query('DELETE FROM bank_reconciliations WHERE company_id = ANY($1)', [companies]);
  await cleanupPr6(pool, companies, [a]);
});

async function fixture(opts: { enforced?: boolean } = {}): Promise<JournalCompany> {
  const f = await journalCompany(pool, [[a, 'admin']], companies);
  await journalRule(plantRule, pool, f.c);
  if (opts.enforced !== false) await enforceJournals(pool, f.c, a);
  return f;
}

async function plantLine(f: JournalCompany, provenance: 'manual' | 'import', amount = -1500): Promise<string> {
  return (await pool.query(
    `INSERT INTO bank_transactions(company_id, bank_account_id, transaction_date, amount, description, status, import_batch_id)
     VALUES($1,$2,DATE '2026-09-01',$3,'R035 line','imported',$4) RETURNING id`,
    [f.c, f.bank, amount, provenance === 'import' ? crypto.randomUUID() : null])).rows[0].id;
}
const counts = async (c: string) => (await pool.query(
  `SELECT (SELECT count(*)::INT FROM bank_transactions WHERE company_id = $1) AS lines,
          (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = $1) AS journals`, [c])).rows[0] as { lines: number; journals: number };
const call = (handler: unknown, c: string, body: unknown, url: string) => callRoute(handler as never, tokens[a]!, c, 'POST', body, url);
const expectRefused = (res: { state: { statusCode: number; body: unknown } }, what: RegExp) => {
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
  expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
  expect(messageOf(res)).toMatch(what);
};

describe('H1: the bank-reconciliation adjustment', () => {
  const adjust = async (f: JournalCompany, amount: number) => {
    const { rows: [rec] } = await pool.query(
      `INSERT INTO bank_reconciliations(company_id, bank_account_id, statement_date, started_by) VALUES($1,$2,DATE '2026-09-30',$3) RETURNING id`,
      [f.c, f.bank, a]);
    return call(bankReconciliationsAction, f.c, { action: 'adjustment', reconciliationId: rec.id, bankAccountId: f.bank,
      contraAccountId: f.expA, amount, description: 'R035 adjustment' }, '/api/accounting/bank-reconciliations-action');
  };

  it('is refused 409 with the reason before the journal is created, and says to post it as a journal', async () => {
    const f = await fixture();
    expectRefused(await adjust(f, 1500), /needs owner approval .*\(rule: Journals sign\)\. Post it as a journal/);
    expect((await counts(f.c)).journals).toBe(0);
  });

  it('posts as before below the rule, or with enforcement off', async () => {
    const f = await fixture();
    expect((await adjust(f, 500)).state.statusCode).toBe(200);
    const off = await fixture({ enforced: false });
    expect((await adjust(off, 1500)).state.statusCode).toBe(200);
  });
});

describe('H2: a hand-keyed bank line to a GL account', () => {
  const manual = (f: JournalCompany, type: 'spend' | 'receive' = 'spend') => call(bankTransactionsManual, f.c, {
    type, bankAccountId: f.bank, date: '2026-09-01', amount: 1500, description: 'keyed by hand',
    allocationType: 'account', contraAccountId: f.expA,
  }, '/api/accounting/bank-transactions-manual');

  it('Spend and Receive Money to an account are refused 409 before the line is inserted', async () => {
    const f = await fixture();
    expectRefused(await manual(f), /keyed by hand.*needs owner approval/);
    expectRefused(await manual(f, 'receive'), /keyed by hand/);
    expect(await counts(f.c)).toEqual({ lines: 0, journals: 0 });
  });

  it('an existing hand-keyed line allocated or split to accounts is refused; an imported one allocates', async () => {
    const f = await fixture();
    const line = await plantLine(f, 'manual');
    expectRefused(await call(bankTransactionsAction, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account',
      contraAccountId: f.expA }, '/api/accounting/bank-transactions-action'), /keyed by hand/);
    expectRefused(await call(bankTransactionsAction, f.c, { action: 'split_allocate', bankTransactionId: line,
      lines: [{ contraAccountId: f.expA, amount: 750 }, { contraAccountId: f.expB, amount: 750 }] },
    '/api/accounting/bank-transactions-action'), /keyed by hand/);
    expect((await counts(f.c)).journals).toBe(0);
    const imported = await plantLine(f, 'import');
    expect((await call(bankTransactionsAction, f.c, { action: 'allocate', bankTransactionId: imported, allocationType: 'account',
      contraAccountId: f.expA }, '/api/accounting/bank-transactions-action')).state.statusCode).toBe(200);
  });

  it('records and allocates as before below the rule, or with enforcement off', async () => {
    const off = await fixture({ enforced: false });
    expect((await manual(off)).state.statusCode).toBe(201);
    const f = await fixture();
    const small = await plantLine(f, 'manual', -500);
    expect((await call(bankTransactionsAction, f.c, { action: 'allocate', bankTransactionId: small, allocationType: 'account',
      contraAccountId: f.expA }, '/api/accounting/bank-transactions-action')).state.statusCode).toBe(200);
  });

  it('MCP: allocate refuses it with nothing written; the bulk dry run and live call skip it alike', async () => {
    const f = await fixture();
    const registry = new McpRegistry();
    registry.register(allocateBankTransactionTool);
    registry.register(bulkAllocateBankTransactionsTool);
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await als.run({ client, userId: a, companyId: f.c, claims: { sub: a } } as never, () => registry.call(name, args,
          { userId: a, companyId: f.c, scopes: ['write:bank-tx', 'write:post'], tokenJti: 'r035-pr6', oauthAppId: null }));
        await client.query('COMMIT');
        return out as { isError?: boolean; content: { text: string }[] };
      } finally { client.release(); }
    };
    const line = await plantLine(f, 'manual');
    const one = await mcp('allocate_bank_transaction', { transaction_id: line, alloc_type: 'account', contra_account_id: f.expA,
      idempotency_key: `r035-pr6-one-${line}` });
    expect(one.isError).toBe(true);
    expect(one.content[0]!.text).toMatch(/keyed by hand.*needs owner approval/);
    const imported = await plantLine(f, 'import');
    const lines = [{ transaction_id: line, alloc_type: 'account', contra_account_id: f.expA },
      { transaction_id: imported, alloc_type: 'account', contra_account_id: f.expA }];
    for (const dry of [true, false]) {
      const res = await mcp('bulk_allocate_bank_transactions', { allocations: lines, dry_run: dry, idempotency_key: `r035-pr6-bulk-${dry}-${line}` });
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      expect(res.content[0]!.text).toMatch(/approval_required: .*keyed by hand/);
    }
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [line])).rows[0].status).toBe('imported');
    expect((await pool.query('SELECT status FROM bank_transactions WHERE id = $1', [imported])).rows[0].status).toBe('allocated');
  });
});
