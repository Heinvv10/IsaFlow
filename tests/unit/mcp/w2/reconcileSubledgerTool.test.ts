/**
 * The `reconcile_subledger` MCP tool (W2).
 *
 * Scope of this suite: the envelope contract, the detail levels, argument
 * refusals, and — the point of the tool — that a difference always arrives
 * WITH the items and document ids behind it. The arithmetic itself is proved
 * in subledgerReconciliation.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reconciliation/subledgerReconciliationService', () => ({
  reconcileSubledger: vi.fn(),
}));

import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { reconcileSubledgerTool } from '@/lib/mcp/tools/reconcileSubledger';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX: McpToolContext = {
  userId: 'u1',
  companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'],
  tokenJti: 'jti',
  oauthAppId: 'app',
} as McpToolContext;

function payload(res: { content: Array<{ text: string }> }) {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

const RECON = {
  subledger: 'ar' as const,
  as_at: '2026-09-03',
  agedTotal: 13214647.6,
  subledgerTotal: 14272647.6,
  subledgerUnavailable: null,
  controlAccounts: [
    { accountId: 'a1', accountCode: '1101', accountName: 'Trade Debtors Control',
      accountType: 'asset', accountSubtype: 'receivable', isActive: true,
      balance: 11591623.6, foundBy: 'subtype' as const },
    { accountId: 'a2', accountCode: '1120', accountName: 'Accounts Receivable',
      accountType: 'asset', accountSubtype: null, isActive: true,
      balance: -10000, foundBy: 'posting' as const },
  ],
  controlAccountBalance: 11581623.6,
  controlAccountAmbiguous: true,
  difference: 2691024,
  reconcilingItems: [
    { bridge: 'aged_to_subledger' as const, type: 'unageable_document',
      description: 'no due date', amount: 1058000,
      documentIds: ['inv-133'], documentNumbers: ['INV0000133'] },
    { bridge: 'subledger_to_control' as const, type: 'unapplied_receipt',
      description: 'unapplied', amount: 2681024,
      documentIds: ['p1', 'p2'], documentNumbers: ['CP-1', 'CP-2'] },
    { bridge: 'subledger_to_control' as const, type: 'posting_with_no_document',
      description: 'no payment doc', amount: 10000,
      documentIds: ['je-9'], documentNumbers: ['JE-2026-00009'] },
  ],
  unexplainedDifference: 0,
  excludedRows: [],
  postedThrough: '2026-08-31T22:15:00.000Z',
};

beforeEach(() => {
  vi.mocked(reconcileSubledger).mockReset().mockResolvedValue(RECON as never);
});

describe('reconcile_subledger', () => {
  it('is a free read tool with the reports scope', () => {
    expect(reconcileSubledgerTool.write).toBe(false);
    expect(reconcileSubledgerTool.scope).toBe('read:reports');
    expect(reconcileSubledgerTool.inputSchema.additionalProperties).toBe(false);
  });

  it('accepts no company argument — companyId comes from ctx only', async () => {
    const props = reconcileSubledgerTool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).not.toContain('company_id');
    await reconcileSubledgerTool.handler({ subledger: 'ar' }, CTX);
    expect(vi.mocked(reconcileSubledger).mock.calls[0]![0]).toBe(CTX.companyId);
  });

  it('returns a SOUND envelope whose rows are the reconciling items', async () => {
    const data = payload(await reconcileSubledgerTool.handler({ subledger: 'ar', as_at: '2026-09-03' }, CTX));
    assertEnvelopeSound(data as never);
    expect(data.rowsTotal).toBe(3);
    expect(data.rowsReturned).toBe(3);
    expect(data.truncated).toBe(false);
    expect(data.as_at).toBe('2026-09-03');
    expect(data.posted_through).toBe('2026-08-31T22:15:00.000Z');
    expect(data.detail).toBe('standard');
    expect(data.excludedRows).toEqual([]);
  });

  it('reports a difference that is ALWAYS accompanied by its items', async () => {
    const data = payload(await reconcileSubledgerTool.handler({ subledger: 'ar' }, CTX));
    expect(data.difference).toBe(2691024);
    const rows = data.rows as Array<Record<string, unknown>>;
    const bridge = rows.filter((r) => r.bridge === 'subledger_to_control');
    expect(bridge.reduce((s, r) => s + (r.amount as number), 0)).toBe(2691024);
    expect(bridge.every((r) => Array.isArray(r.documentIds))).toBe(true);
  });

  it('surfaces EVERY control account and the ambiguity, never a single number', async () => {
    const data = payload(await reconcileSubledgerTool.handler({ subledger: 'ar' }, CTX));
    expect((data.controlAccounts as unknown[]).length).toBe(2);
    expect(data.controlAccountAmbiguous).toBe(true);
  });

  it('serves no rows at detail summary but keeps the totals', async () => {
    const data = payload(
      await reconcileSubledgerTool.handler({ subledger: 'ar', detail: 'summary' }, CTX),
    );
    assertEnvelopeSound(data as never);
    expect(data.rows).toEqual([]);
    expect(data.rowsTotal).toBe(3);
    expect(data.difference).toBe(2691024);
    expect(data.truncated).toBe(false);
  });

  it('drills through to the documents at detail full, with a cursor', async () => {
    const data = payload(
      await reconcileSubledgerTool.handler({ subledger: 'ar', detail: 'full', limit: 2 }, CTX),
    );
    // 4 document ids across the three items.
    expect(data.rowsTotal).toBe(4);
    expect(data.rowsReturned).toBe(2);
    expect(data.truncated).toBe(true);
    expect(data.next_cursor).toBeTruthy();
    const first = (data.rows as Array<Record<string, unknown>>)[0]!;
    expect(first).toMatchObject({ documentId: 'inv-133', documentNumber: 'INV0000133' });

    const page2 = payload(
      await reconcileSubledgerTool.handler(
        { subledger: 'ar', detail: 'full', limit: 2, cursor: data.next_cursor },
        CTX,
      ),
    );
    expect(page2.rowsReturned).toBe(2);
    expect(page2.next_cursor).toBeNull();
    const seen = [...(data.rows as Array<Record<string, unknown>>), ...(page2.rows as Array<Record<string, unknown>>)];
    expect(new Set(seen.map((r) => r.documentId)).size).toBe(4);
  });

  it('refuses an unknown subledger by name rather than reconciling nothing', async () => {
    const res = await reconcileSubledgerTool.handler({ subledger: 'debtors' }, CTX);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('subledger');
    expect(reconcileSubledger).not.toHaveBeenCalled();
  });

  it('refuses an impossible calendar date before it reaches a cast', async () => {
    const res = await reconcileSubledgerTool.handler({ subledger: 'ar', as_at: '2026-02-31' }, CTX);
    expect(res.isError).toBe(true);
    expect(reconcileSubledger).not.toHaveBeenCalled();
  });

  it('refuses a malformed cursor instead of silently serving page one', async () => {
    const res = await reconcileSubledgerTool.handler(
      { subledger: 'ar', detail: 'full', cursor: 'not-a-cursor' }, CTX,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('cursor');
  });

  it('carries an unavailable subledger through as a stated reason, not a zero', async () => {
    vi.mocked(reconcileSubledger).mockResolvedValue({
      ...RECON, subledger: 'payroll', agedTotal: null, subledgerTotal: null,
      difference: null, unexplainedDifference: null, reconcilingItems: [],
      subledgerUnavailable: { reason: 'no_subledger_source', detail: 'nothing populated' },
      postedThrough: null,
    } as never);

    const data = payload(await reconcileSubledgerTool.handler({ subledger: 'payroll' }, CTX));
    expect(data.subledgerTotal).toBeNull();
    expect(data.difference).toBeNull();
    expect(data.subledgerUnavailable).toMatchObject({ reason: 'no_subledger_source' });
    // posted_through must still be a string, never now() — an empty read has
    // consumed no ledger row and says so with the epoch, not with the clock.
    expect(typeof data.posted_through).toBe('string');
  });

  it('names the figure definitions it used', async () => {
    const data = payload(await reconcileSubledgerTool.handler({ subledger: 'ar' }, CTX));
    expect(data.figureBasis).toBe('ar.subledger.v1');
    expect(data.controlFigureBasis).toBe('ar.control.v1');
  });

  it('warns IN THE DESCRIPTION that a zero residual is necessary, not sufficient', () => {
    // Not a style check. This endpoint reported unexplainedDifference 0.00 on
    // every production company while wrongly counting a VAT account as an AP
    // control account, because an item of the same amount across the same 356
    // documents cancelled it out. An identity that always closes cannot detect
    // its own defects, and a reader who never sees the source has only the
    // description to learn that from.
    const d = reconcileSubledgerTool.description;
    expect(d).toContain('NECESSARY AND NOT SUFFICIENT');
    expect(d).toContain('cancel');
    expect(d).toContain('INSPECT THE ITEMS');
  });

  it('says settlementFlagged attributes a difference rather than adding to one', () => {
    // R16,151,543.00 is not a number to make somebody hunt for, and a reader
    // scanning reconcilingItems for those 397 bills will not find them there.
    const d = reconcileSubledgerTool.description;
    expect(d).toContain('settlementFlagged');
    expect(d).toContain('ATTRIBUTION');
    expect(d).toContain('must not be added to them');
  });

  it('makes NO completeness claim it cannot fail', async () => {
    const body = payload(await reconcileSubledgerTool.handler({ subledger: 'ar' }, CTX));
    // universeTotal must be absent here. These rows are produced by the report,
    // not selected from a wider pool, so any universe would be synthesized from
    // the very numbers the envelope checks against it — an identity that cannot
    // fail whatever the code did. CONTRACTS.md §1 names that anti-pattern, and
    // an absent claim is honest where one that always passes reads as
    // verification.
    expect(body).not.toHaveProperty('universeTotal');
    expect(body).not.toHaveProperty('completenessFault');
  });
});
