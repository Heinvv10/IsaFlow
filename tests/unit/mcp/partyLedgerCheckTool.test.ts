/**
 * The `party_ledger_check` MCP tool: argument refusals, tenant scoping, detail
 * levels and paging. The comparison itself is pinned in
 * tests/unit/services/reconciliation/partyLedgerClassify.test.ts and, against
 * real SQL, tests/integration/party-ledger-check.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
// Every fixture document is an invoice, so the kind alone is a faithful sort component.
vi.mock('@/modules/accounting/services/reconciliation/partyLedgerCheckService', () => ({
  partyLedgerCheck: vi.fn(),
  documentSortKey: (d: { date: string; kind: string; id: string }) => [d.date, d.kind, d.id],
}));

import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import { partyLedgerCheckTool } from '@/lib/mcp/tools/partyLedgerCheck';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import type { McpToolContext } from '@/lib/mcp/types';
import type { PartyDocument, PartyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111', scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;
const PARTY = '22222222-2222-4222-8222-222222222222';

function doc(i: number, flagged: boolean): PartyDocument {
  return {
    kind: 'invoice', id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, number: `INV${i}`,
    date: `2026-03-${String(i).padStart(2, '0')}`, status: 'approved',
    statement: { effect: 100, onStatement: true, excludedReason: null },
    subledger: { total: 100, settled: 0, outstanding: 100, allocated: 0, unapplied: null },
    gl: { journalId: 'j', journalStatus: 'posted', controlNet: flagged ? 0 : 100, reversalsInForce: 0 },
    difference: flagged ? 100 : 0,
    flags: flagged ? [{ class: 'journal_amount_differs', bridge: 'statement_vs_gl', amount: 100, detail: 'x' }] : [],
  };
}

function check(over: Partial<PartyLedgerCheck> = {}): PartyLedgerCheck {
  const documents = [doc(1, false), doc(2, true), doc(3, true), doc(4, false), doc(5, true)];
  return {
    partyType: 'supplier', party: { id: PARTY, name: 'Acme' }, as_at: '2026-06-30',
    controlAccounts: [{ accountId: 'a', accountCode: '2110', accountName: 'Creditors', balance: 200 }],
    totals: {
      statementBalance: 500, agedNet: 500, glControlNet: 200, statementMinusGl: 300, classifiedDifference: 300,
      unexplainedResidual: 0, agedMinusStatement: 0,
      agedBridge: { unappliedCash: 0, unappliedCredit: 0, writeOffs: 0, amountPaidWithoutAllocation: 0, unexplained: 0 },
      documents: { total: 5, flagged: 3 }, byClass: [{ class: 'journal_amount_differs', count: 3, amount: 300 }],
    },
    documents, invariants: [], unattributed: { scope: 'company', count: 0, net: 0 },
    postedThrough: '2026-06-01T00:00:00.000Z', ...over,
  };
}
const body = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0]!.text) as Record<string, any>;
const run = (args: Record<string, unknown>) => partyLedgerCheckTool.handler({ party_type: 'supplier', party_id: PARTY, ...args }, CTX);

beforeEach(() => {
  vi.mocked(partyLedgerCheck).mockReset().mockResolvedValue(check());
});

describe('party_ledger_check tool', () => {
  it('is a free read on read:reports, registered everywhere', () => {
    expect(partyLedgerCheckTool).toMatchObject({ name: 'party_ledger_check', scope: 'read:reports', write: false });
    expect(partyLedgerCheckTool.inputSchema).toMatchObject({ additionalProperties: false, required: ['party_type', 'party_id'] });
    expect(MCP_TOOLS.map((t) => t.name)).toContain('party_ledger_check');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('party_ledger_check');
    expect(flowOperationFor('party_ledger_check', {})).toBeNull();
  });

  it.each([
    [{ party_type: 'vendor' }, /invalid party_type/],
    [{ party_id: 'nope' }, /invalid party_id/],
    [{ as_at: '2026-02-31' }, /invalid as_at/],
    [{ cursor: '!!' }, /invalid cursor/],
  ])('refuses %j before touching the ledger', async (args, message) => {
    const res = await run(args);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(message);
    expect(partyLedgerCheck).not.toHaveBeenCalled();
  });

  it('scopes by the token company and the party, never an argument', async () => {
    await run({ as_at: '2026-06-30' });
    expect(partyLedgerCheck).toHaveBeenCalledWith(CTX.companyId, 'supplier', PARTY, '2026-06-30');
  });

  it('a party the company does not own reads exactly like a miss', async () => {
    vi.mocked(partyLedgerCheck).mockResolvedValue(null);
    const res = await run({});
    expect(res).toMatchObject({ isError: true, content: [{ text: 'Not found' }] });
  });

  it('summary serves totals and no rows', async () => {
    const out = body(await run({ detail: 'summary' }));
    expect(out.rows).toEqual([]);
    expect(out.rowsTotal).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.totals.statementBalance).toBe(500);
    expect(out.figureBasis).toBe('ap.subledger.v1');
    assertEnvelopeSound(out as never);
  });

  it('standard (the default) serves only flagged documents; full serves all', async () => {
    const standard = body(await run({}));
    expect(standard.detail).toBe('standard');
    expect(standard.rows.map((r: PartyDocument) => r.number)).toEqual(['INV2', 'INV3', 'INV5']);
    const full = body(await run({ detail: 'full' }));
    expect(full.rowsTotal).toBe(5);
    expect(full.rows).toHaveLength(5);
  });

  it('pages by cursor without gaps or repeats, and a customer uses the AR figure basis', async () => {
    vi.mocked(partyLedgerCheck).mockResolvedValue(check({ partyType: 'customer' }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const out = body(await run({ party_type: 'customer', detail: 'full', limit: 2, ...(cursor ? { cursor } : {}) }));
      expect(out.figureBasis).toBe('ar.subledger.v1');
      seen.push(...out.rows.map((r: PartyDocument) => r.number));
      if (!out.next_cursor) break;
      cursor = out.next_cursor;
    }
    expect(seen).toEqual(['INV1', 'INV2', 'INV3', 'INV4', 'INV5']);
  });

  it('names a missing control account instead of implying the books agree', async () => {
    vi.mocked(partyLedgerCheck).mockResolvedValue(check({ controlAccounts: [] }));
    const out = body(await run({ detail: 'summary' }));
    expect(out.excludedRows).toEqual([expect.objectContaining({ reason: 'no_control_account' })]);
  });
});
