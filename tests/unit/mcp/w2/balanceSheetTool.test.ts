/**
 * `balance_sheet` v2 (W2) — a WRAP of `getBalanceSheet`, with the second equity
 * figure the first one hides.
 *
 * THE POINT OF THIS TOOL. A balance sheet always balances: equity is whatever
 * makes it. So a report that states "Assets = Liabilities + Equity" and stops
 * has asserted an identity of its own construction and proved nothing. There
 * are two equity figures and they answer different questions:
 *
 *   equityResidual    assets − liabilities. Balances by construction.
 *   equityFromLedger  the sum of the POSTED equity accounts. Nothing derived.
 *
 * The second one is NOT `report.totalEquity`, and getting that wrong is the
 * trap this suite exists to hold shut. `getBalanceSheet` computes retained
 * earnings as revenue less expenses and injects it into the equity section, so
 * `totalEquity` equals the residual by construction. The first version of this
 * tool reported it as the second opinion; the two then agreed to the cent on
 * all three production companies and read as a clean set of books.
 *
 * The equity ACCOUNTS say otherwise: Brightsphere and Velocity Fibre each carry
 * R0.00 of posted equity, so every cent of Brightsphere's R8,394,848.60 and of
 * Velocity's −R34,816,224.89 is a derived plug — profit no year-end close has
 * posted to an equity account.
 *
 * `compareDate` and `costCentreId` already existed on the service and were
 * simply not wired to MCP. Wiring them is the rest of the job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({
  getBalanceSheet: vi.fn(),
  getEquityBases: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-08-31T22:15:00.000Z'),
}));

import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { balanceSheetTool } from '@/lib/mcp/tools/reportsBalanceSheet';
import { assertEnvelopeSound, getFigureDefinition } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

/** Assets 1,000; liabilities 400; equity accounts summing to 600 — they agree. */
const AGREES = {
  asAtDate: '2026-08-31',
  assets: [{ accountCode: '1101', accountName: 'Trade Debtors', balance: 1000 }],
  liabilities: [{ accountCode: '2110', accountName: 'Trade Creditors', balance: 400 }],
  equity: [{ accountCode: '3200', accountName: 'Retained Earnings', balance: 600 }],
  totalAssets: 1000, totalLiabilities: 400, totalEquity: 600,
};

beforeEach(() => {
  vi.mocked(getBalanceSheet).mockReset().mockResolvedValue(AGREES as never);
  // Equity accounts hold the whole 600; nothing is derived. The books agree.
  vi.mocked(getEquityBases).mockReset().mockResolvedValue({ posted: 600, derivedRetainedEarnings: 0 });
});

describe('balance_sheet', () => {
  it('reports BOTH equity figures, and says they agree when they do', async () => {
    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    assertEnvelopeSound(body as never);

    expect(body.equityResidual).toBe(600);
    expect(body.equityFromLedger).toBe(600);
    expect(body.equityDifference).toBe(0);
    expect(body.equityReconciles).toBe(true);
    // Three sections, flattened into rows so the envelope can count them.
    expect(body.rowsTotal).toBe(3);
    expect(body.totalAssets).toBe(1000);
    expect(body.totalLiabilities).toBe(400);
  });

  it('EXPOSES a plug: R0.00 posted against a residual of 600', async () => {
    // The Brightsphere and Velocity shape exactly — equity accounts carrying
    // nothing at all, with the entire equity figure derived. `totalEquity`
    // still reads 600 and still balances, which is why it cannot be the second
    // opinion about itself.
    vi.mocked(getEquityBases).mockResolvedValue({ posted: 0, derivedRetainedEarnings: 600 });

    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    expect(body.totalEquity).toBe(600);
    expect(body.equityResidual).toBe(600);
    expect(body.equityFromLedger).toBe(0);
    expect(body.equityDifference).toBe(600);
    expect(body.retainedEarningsDerived).toBe(600);
    expect(body.equityReconciles).toBe(false);
  });

  it('does NOT take totalEquity as the ledger figure, however plausible it looks', async () => {
    // The mutation this holds shut. `totalEquity` is plug-inclusive: if the
    // tool read it, equityFromLedger would be 600 here and the report would
    // claim the books reconcile while the equity accounts hold 250.
    vi.mocked(getEquityBases).mockResolvedValue({ posted: 250, derivedRetainedEarnings: 350 });
    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    expect(body.equityFromLedger).toBe(250);
    expect(body.equityFromLedger).not.toBe(body.totalEquity);
    expect(body.equityDifference).toBe(350);
    expect(body.equityReconciles).toBe(false);
  });

  it('names both figure bases, so neither can be mistaken for the other', async () => {
    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    // The wire format is the figure ID, as everywhere else in this server —
    // the registry entry itself is documentation and does not belong inline in
    // every response.
    const bases = body.equityFigureBasis as Record<string, string>;
    expect(bases.residual).toBe('equity.residual.v1');
    expect(bases.ledger).toBe('equity.ledger.v1');
    // W2 settles equity.ledger.v1 — it was held unowned for the workstream that
    // first needed both figures side by side, and this is it. `figureBasis`
    // throws on an unknown id, so a typo here cannot reach a response.
    // getEquityBases, NOT getBalanceSheet: that service's totalEquity is the
    // residual wearing the ledger's name.
    expect(getFigureDefinition('equity.ledger.v1')!.owner)
      .toBe('reports/balanceSheetService#getEquityBases');
    // ...and its `contested` list is empty: openingBalanceEquityService was
    // listed as a rival basis and is not one — it resolves a single clearing
    // account and computes no total.
    expect(getFigureDefinition('equity.ledger.v1')!.contested ?? []).toEqual([]);
  });

  it('wires compare_date and cost_centre_id through to the service', async () => {
    vi.mocked(getBalanceSheet).mockResolvedValue({
      ...AGREES,
      compareDate: '2025-08-31',
      priorTotalAssets: 800, priorTotalLiabilities: 300, priorTotalEquity: 500,
    } as never);

    const body = payload(await balanceSheetTool.handler(
      {
        as_at: '2026-08-31',
        compare_date: '2025-08-31',
        cost_centre_id: '33333333-3333-4333-8333-333333333333',
      },
      CTX,
    ));

    const call = vi.mocked(getBalanceSheet).mock.calls[0]!;
    expect(call[0]).toBe(CTX.companyId); // from ctx ONLY
    expect(call[1]).toBe('2026-08-31');
    expect(call[2]).toBe('33333333-3333-4333-8333-333333333333');
    expect(call[3]).toBe('2025-08-31');

    // The equity bases are read at BOTH dates, and the cost centre applies to
    // both — a comparative computed company-wide beside a cost-centre column
    // produces a variance between two different questions.
    expect(vi.mocked(getEquityBases).mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [CTX.companyId, '2026-08-31', '33333333-3333-4333-8333-333333333333'],
      [CTX.companyId, '2025-08-31', '33333333-3333-4333-8333-333333333333'],
    ]);

    expect(body.compare_date).toBe('2025-08-31');
    expect(body.priorTotalAssets).toBe(800);
    // The prior date's two equity figures too — a comparative that reports only
    // one of them reintroduces the defect on the column nobody checks.
    expect(body.priorEquityResidual).toBe(500);
    expect(body.priorEquityFromLedger).toBe(600);
    expect(body.priorRetainedEarningsDerived).toBe(0);
  });

  it('refuses a date or cost centre Postgres could not cast, BEFORE querying', async () => {
    for (const args of [
      { as_at: '2026-02-31' },
      { as_at: '2026-08-31', compare_date: 'lol' },
      { as_at: '2026-08-31', cost_centre_id: 'not-a-uuid' },
    ]) {
      const res = await balanceSheetTool.handler(args, CTX);
      expect((res as { isError?: boolean }).isError).toBe(true);
    }
    // A read tool runs with no savepoint, so a cast error raised after the
    // query aborts the whole request transaction.
    expect(vi.mocked(getBalanceSheet)).not.toHaveBeenCalled();
    expect(vi.mocked(getEquityBases)).not.toHaveBeenCalled();
  });

  it('detail "summary" serves the totals and NO rows', async () => {
    const body = payload(await balanceSheetTool.handler(
      { as_at: '2026-08-31', detail: 'summary' }, CTX,
    ));
    assertEnvelopeSound(body as never);
    expect(body.rows).toEqual([]);
    expect(body.rowsTotal).toBe(3);
    expect(body.equityFromLedger).toBe(600);
  });

  it('labels every row with the section it came from', async () => {
    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    const rows = body.rows as Array<{ section: string; accountCode: string }>;
    // Flattening three arrays into one loses which is which unless it is said.
    expect(rows.map((r) => r.section)).toEqual(['asset', 'liability', 'equity']);
    expect(rows.map((r) => r.accountCode)).toEqual(['1101', '2110', '3200']);
  });

  it('reports posted_through from the ledger, never now()', async () => {
    const body = payload(await balanceSheetTool.handler({ as_at: '2026-08-31' }, CTX));
    expect(body.posted_through).toBe('2026-08-31T22:15:00.000Z');
  });

  it('warns IN THE DESCRIPTION that equityReconciles is necessary, not sufficient', () => {
    // The first version of this tool compared the residual against itself and
    // returned true on all three production companies. A reader who never sees
    // the source has only the description to learn why the check means
    // something now and did not before.
    const d = balanceSheetTool.description;
    expect(d).toContain('necessary and not sufficient');
    expect(d).toContain('tautology');
    expect(d).toContain('queried from the equity accounts rather than injected');
  });
});
