/**
 * BREAKER #684 — REPRO 1. Decision 4 gates REVERSING a posted bank allocation
 * under enforcement: the allocator may not (403 ALLOCATOR_MAY_NOT_REVERSE),
 * agents may not. The gate sits only in reverseReconciledTransaction. The
 * allocation's journal itself is reversible through the generic GL reversal —
 * journal-entries-action `reverse` (UI) and MCP `reverse_journal_entry` —
 * neither of which asks bankReversalGate. The money comes back out of the
 * ledger, by the allocator / by an agent, with no audit row and no second
 * person.
 *
 * FIXED (slice a): under enforcement of the allocation's arm the GL reversal of
 * a journal whose chain books a statement line's cash is refused for EVERYONE,
 * 409 REVERSE_FROM_BANK_LINE, before any write — it is reversed from the bank
 * line, where the allocator/agent checks and the audit sit and the line is
 * reset. Enforcement off: the GL reversal works as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';
import { reverseJournalEntryTool } from '../../src/lib/mcp/tools/writeJournalReverse';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { callRoute, createUser } from './r035-approval.helpers';
import {
  actionRoute, asToken, bankCompany, cleanupBankControlsA, enforce, plantBatch, plantLine, refusalOf, type BankCompany, type McpReply,
} from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';
let b = '';
let act: ReturnType<typeof actionRoute>;
const registry = new McpRegistry();
registry.register(reverseJournalEntryTool);
/** The token holds write:journals — the tool's own scope (a token an accountant's agent would carry). */
const mcp = (user: string, c: string, name: string, args: Record<string, unknown>) => asToken(pool, user, c, async () =>
  (await registry.call(name, args, { userId: user, companyId: c, scopes: ['write:journals', 'write:bank-tx', 'write:post'], tokenJti: 'brk684',
    oauthAppId: null })) as McpReply);

beforeAll(async () => { a = await createUser(pool, tokens); b = await createUser(pool, tokens); act = actionRoute(tokens); });
afterAll(() => cleanupBankControlsA(pool, companies, [a, b]));

/** A statement line imported by b, allocated to expA by a, then manual_journal enforced. */
async function allocatedByA(): Promise<BankCompany & { line: string; je: string }> {
  const f = await bankCompany(pool, [[a, 'admin'], [b, 'admin']], companies);
  const line = await plantLine(pool, f, await plantBatch(pool, f, b));
  const res = await act(a, f.c, { action: 'allocate', bankTransactionId: line, allocationType: 'account', contraAccountId: f.expA });
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  await enforce(pool, f.c, a, ['manual_journal']);
  const je = (await pool.query(
    `SELECT jl.journal_entry_id AS je FROM bank_transactions bt JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
     WHERE bt.id = $1`, [line])).rows[0].je as string;
  return { ...f, line, je };
}
const contras = async (c: string) =>
  (await pool.query('SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1 AND reversal_of_id IS NOT NULL', [c]))
    .rows[0].n as number;

describe('the allocation journal is reversible around the reversal gate', () => {
  it('sanity: the bank reverse refuses the allocator (the gate exists)', async () => {
    const f = await allocatedByA();
    expect(refusalOf(await act(a, f.c, { action: 'reverse', bankTransactionId: f.line })))
      .toMatchObject({ status: 403, reason: 'ALLOCATOR_MAY_NOT_REVERSE' });
    expect(await contras(f.c)).toBe(0);
  });

  it('the ALLOCATOR reverses the same allocation through journal-entries-action reverse', async () => {
    const f = await allocatedByA();
    const res = await callRoute(journalEntriesAction as never, tokens[a]!, f.c, 'POST', { id: f.je, action: 'reverse' },
      '/api/accounting/journal-entries-action');
    // REQUIRED (decision 4): refused, nothing written — 409 REVERSE_FROM_BANK_LINE (the bank line is the gated path).
    expect({ status: res.state.statusCode, contras: await contras(f.c) }).toEqual({ status: 409, contras: 0 });
    expect(refusalOf(res)).toMatchObject({ reason: 'REVERSE_FROM_BANK_LINE',
      message: expect.stringMatching(/^This journal is a bank allocation, and while manual-journal approval is on it is reversed from its bank line/) });
  });

  it('another member is sent to the bank line too, where they reverse it (audited); enforcement off, the GL reversal works', async () => {
    const f = await allocatedByA();
    const viaGl = (user: string, c: string, je: string) => callRoute(journalEntriesAction as never, tokens[user]!, c, 'POST',
      { id: je, action: 'reverse' }, '/api/accounting/journal-entries-action');
    expect(refusalOf(await viaGl(b, f.c, f.je))).toMatchObject({ status: 409, reason: 'REVERSE_FROM_BANK_LINE' });
    expect((await act(b, f.c, { action: 'reverse', bankTransactionId: f.line })).state.statusCode).toBe(200);
    expect((await pool.query("SELECT count(*)::INT AS n FROM audit_log WHERE company_id = $1 AND action = 'reverse'", [f.c])).rows[0].n).toBe(1);
    const off = await allocatedByA();
    await pool.query('DELETE FROM approval_enforcement WHERE company_id = $1', [off.c]);
    expect((await viaGl(a, off.c, off.je)).state.statusCode).toBe(200);
    expect(await contras(off.c)).toBe(1);
  });

  it('an AGENT reverses the allocation journal through MCP reverse_journal_entry', async () => {
    const f = await allocatedByA();
    const out = await mcp(b, f.c, 'reverse_journal_entry', { journal_entry_id: f.je, idempotency_key: crypto.randomUUID() });
    // REQUIRED (decision 4): an agent's reversal is refused under enforcement.
    expect({ isError: out.isError === true, contras: await contras(f.c) }).toEqual({ isError: true, contras: 0 });
  });
});
