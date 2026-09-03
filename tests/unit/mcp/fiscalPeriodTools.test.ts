/**
 * The five period-control MCP tools.
 *
 * Load-bearing here: `close_fiscal_period` REFUSES with itemised blockers
 * (a boolean is not a lock an agent can respect), a dry run runs every guard and
 * must NOT burn the idempotency key, and every refusal is raised BEFORE the
 * first write so returning it as a tool error cannot commit a partial close.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriods: vi.fn(),
  getFiscalPeriodById: vi.fn(),
  getJournalCountsByYear: vi.fn(),
  resolveFiscalYearStartMonth: vi.fn(),
  reopenPeriod: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/periodCloseReadinessService', () => ({
  getCloseReadiness: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodCloseService', async () => {
  class PeriodCloseBlockedError extends Error {
    blockers: unknown[] = [];
    checklist: unknown[] = [];
  }
  class PeriodNotCloseableError extends Error {}
  return {
    closePeriodWithReadiness: vi.fn(),
    PeriodCloseBlockedError,
    PeriodNotCloseableError,
  };
});
vi.mock('@/modules/accounting/services/gl/yearEndService', () => ({ closeFiscalYear: vi.fn() }));

import {
  getFiscalPeriods,
  getFiscalPeriodById,
  getJournalCountsByYear,
  resolveFiscalYearStartMonth,
  reopenPeriod,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import {
  closePeriodWithReadiness,
  PeriodCloseBlockedError,
  PeriodNotCloseableError,
} from '@/modules/accounting/services/gl/fiscalPeriodCloseService';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';
import {
  listFiscalPeriodsTool,
  getFiscalPeriodTool,
  periodCloseChecklistTool,
} from '@/lib/mcp/tools/fiscalPeriods';
import {
  closeFiscalPeriodTool,
  reopenFiscalPeriodTool,
  yearEndCloseTool,
} from '@/lib/mcp/tools/writeFiscalPeriods';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import { assertEnvelopeSound } from '@/lib/mcp/contracts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

const ctx: McpToolContext = {
  userId: 'u', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['read:reports', 'write:journals', 'write:post'], tokenJti: 'j', oauthAppId: null,
};
const PERIOD = '44444444-4444-4444-4444-444444444444';
const KEY = { idempotency_key: 'k-1' };

function body(res: McpToolResult): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

function period(o: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: PERIOD, periodName: 'March 2026', periodNumber: 1, fiscalYear: 2027,
    startDate: '2026-03-01', endDate: '2026-03-31', status: 'open',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveFiscalYearStartMonth).mockResolvedValue({
    declaredStartMonth: 3, observedStartMonth: 1, startMonth: 1, aligned: false,
  });
  vi.mocked(getFiscalPeriods).mockResolvedValue([period()]);
  vi.mocked(getFiscalPeriodById).mockResolvedValue(period());
  vi.mocked(getJournalCountsByYear).mockResolvedValue({ [PERIOD]: 42 });
});

describe('registration', () => {
  it('registers all five, on the right scopes, with write:post on the mutators', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const n of [
      'list_fiscal_periods', 'get_fiscal_period', 'period_close_checklist',
      'close_fiscal_period', 'reopen_fiscal_period', 'year_end_close',
    ]) {
      expect(names, n).toContain(n);
      expect(CLIENT_MCP_TOOL_NAMES, n).toContain(n);
    }
    expect(listFiscalPeriodsTool.write).toBe(false);
    expect(closeFiscalPeriodTool.requiresPost).toBe(true);
    expect(reopenFiscalPeriodTool.requiresPost).toBe(true);
    expect(yearEndCloseTool.requiresPost).toBe(true);
  });
});

describe('list_fiscal_periods', () => {
  it('returns a sound envelope and passes ctx.companyId only', async () => {
    const res = await listFiscalPeriodsTool.handler({}, ctx);
    expect(getFiscalPeriods).toHaveBeenCalledWith(ctx.companyId, undefined);
    const env = body(res);
    assertEnvelopeSound(env as never);
    expect(env.rowsTotal).toBe(1);
    expect(env.rowsReturned).toBe(1);
  });

  it('counts periods that have ENDED and are still open — the inverted control', async () => {
    vi.mocked(getFiscalPeriods).mockResolvedValue([
      period({ id: 'a', endDate: '2022-12-31', status: 'open' }),
      period({ id: 'b', endDate: '2023-12-31', status: 'open' }),
      period({ id: 'c', endDate: '2099-12-31', status: 'open' }),
      period({ id: 'd', endDate: '2024-12-31', status: 'closed' }),
    ]);
    const env = body(await listFiscalPeriodsTool.handler({}, ctx));
    expect(env.open_prior_periods).toBe(2);
    expect(env.closed_periods).toBe(1);
  });

  it('reports the alignment finding rather than hiding it', async () => {
    const env = body(await listFiscalPeriodsTool.handler({}, ctx));
    expect(env.alignment).toEqual({
      declared_start_month: 3, observed_start_month: 1, aligned: false,
    });
  });

  it('serves no rows and no truncation on detail summary', async () => {
    const env = body(await listFiscalPeriodsTool.handler({ detail: 'summary' }, ctx));
    expect(env.rows).toEqual([]);
    expect(env.truncated).toBe(false);
    expect(env.rowsTotal).toBe(1);
    assertEnvelopeSound(env as never);
  });

  it('pages by cursor and stops with a null cursor on the last page', async () => {
    vi.mocked(getFiscalPeriods).mockResolvedValue([
      period({ id: 'a', periodNumber: 1 }),
      period({ id: 'b', periodNumber: 2 }),
      period({ id: 'c', periodNumber: 3 }),
    ]);
    const first = body(await listFiscalPeriodsTool.handler({ limit: 2 }, ctx));
    expect(first.rowsReturned).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBeTruthy();

    const second = body(await listFiscalPeriodsTool.handler(
      { limit: 2, cursor: first.next_cursor as string }, ctx,
    ));
    expect(second.rowsReturned).toBe(1);
    expect(second.next_cursor).toBeNull();
  });

  it('refuses a malformed cursor rather than serving page one as if it were page two', async () => {
    const res = await listFiscalPeriodsTool.handler({ cursor: 'not-a-cursor' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/cursor/);
  });

  it('refuses an unknown status', async () => {
    const res = await listFiscalPeriodsTool.handler({ status: 'nearly' }, ctx);
    expect(res.isError).toBe(true);
  });
});

describe('get_fiscal_period', () => {
  it('answers a foreign period with the shared miss, not a distinct message', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(null);
    const res = await getFiscalPeriodTool.handler({ fiscal_period_id: PERIOD }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('Not found');
  });

  it('refuses a malformed id before the query, so no cast can abort the transaction', async () => {
    const res = await getFiscalPeriodTool.handler({ fiscal_period_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(getFiscalPeriodById).not.toHaveBeenCalled();
  });

  it('carries the journal count for the period', async () => {
    const b = body(await getFiscalPeriodTool.handler({ fiscal_period_id: PERIOD }, ctx));
    expect(b.journal_entry_count).toBe(42);
  });
});

describe('period_close_checklist', () => {
  it('returns every check with its reason and fix link', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue({
      periodId: PERIOD, periodLabel: 'March 2026', overallStatus: 'fail',
      items: [{ key: 'bank_reconciled', label: 'Bank', status: 'fail', reason: '412 unreconciled', fixHref: '/x' }],
    });
    const b = body(await periodCloseChecklistTool.handler({ fiscal_period_id: PERIOD }, ctx));
    expect(b.overall_status).toBe('fail');
    expect(b.items).toEqual([
      { key: 'bank_reconciled', label: 'Bank', status: 'fail', reason: '412 unreconciled', fix_href: '/x' },
    ]);
  });

  it('is the shared miss for a foreign period', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(null);
    const res = await periodCloseChecklistTool.handler({ fiscal_period_id: PERIOD }, ctx);
    expect(res.content[0]!.text).toBe('Not found');
  });
});

describe('close_fiscal_period', () => {
  beforeEach(() => {
    vi.mocked(closePeriodWithReadiness).mockResolvedValue({
      period: period({ status: 'closed' }), closed: true, dryRun: false,
      checklist: [{ key: 'tb_balanced', label: 'TB', status: 'pass', reason: 'ok', fixHref: '/x' }],
      warnings: [],
    });
  });

  it('closes and reports the checklist it passed', async () => {
    const res = await closeFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);
    expect(res.isError).toBeFalsy();
    expect(closePeriodWithReadiness)
      .toHaveBeenCalledWith(ctx.companyId, PERIOD, ctx.userId, { dryRun: false });
    expect(body(res).closed).toBe(true);
  });

  it('a dry run must NOT burn the idempotency key', async () => {
    vi.mocked(closePeriodWithReadiness).mockResolvedValue({
      period: period(), closed: false, dryRun: true, checklist: [], warnings: [],
    });
    const res = await closeFiscalPeriodTool.handler(
      { fiscal_period_id: PERIOD, dry_run: true, ...KEY }, ctx,
    );
    expect((res as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    expect(closePeriodWithReadiness)
      .toHaveBeenCalledWith(ctx.companyId, PERIOD, ctx.userId, { dryRun: true });
  });

  it('surfaces the itemised blockers, not "not ready"', async () => {
    const err = new PeriodCloseBlockedError(
      'March 2026 cannot be closed — 2 checks did not pass: '
      + 'bank_reconciled: 412 transactions are not reconciled; unposted_journals: 3 draft journals',
    );
    vi.mocked(closePeriodWithReadiness).mockRejectedValue(err);

    const res = await closeFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/412 transactions are not reconciled/);
    expect(res.content[0]!.text).toMatch(/3 draft journals/);
    expect(res.content[0]!.text).toMatch(/Nothing was closed/);
  });

  it('RETHROWS anything that is not a pre-write refusal', async () => {
    vi.mocked(closePeriodWithReadiness)
      .mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    await expect(closeFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx))
      .rejects.toThrow('deadlock');
  });

  it('answers a not-closeable period as a tool error, having written nothing', async () => {
    vi.mocked(closePeriodWithReadiness)
      .mockRejectedValue(new PeriodNotCloseableError('March 2026 is already closed'));
    const res = await closeFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/already closed/);
  });
});

describe('reopen_fiscal_period', () => {
  it('refuses a locked period without calling the service', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(period({ status: 'locked' }));
    const res = await reopenFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(reopenPeriod).not.toHaveBeenCalled();
  });

  it('refuses an already-open period rather than reporting a change that did not happen', async () => {
    const res = await reopenFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/already open/);
    expect(reopenPeriod).not.toHaveBeenCalled();
  });

  it('reopens a closed period and frees the key only on a dry run', async () => {
    vi.mocked(getFiscalPeriodById).mockResolvedValue(period({ status: 'closed' }));
    vi.mocked(reopenPeriod).mockResolvedValue(period({ status: 'open' }));

    const dry = await reopenFiscalPeriodTool.handler(
      { fiscal_period_id: PERIOD, dry_run: true, ...KEY }, ctx,
    );
    expect((dry as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    expect(reopenPeriod).not.toHaveBeenCalled();

    const live = await reopenFiscalPeriodTool.handler({ fiscal_period_id: PERIOD, ...KEY }, ctx);
    expect((live as { wroteNothing?: boolean }).wroteNothing).toBeUndefined();
    expect(body(live).reopened).toBe(true);
  });
});

describe('year_end_close', () => {
  it('returns the whole journal on a dry run and frees the key', async () => {
    vi.mocked(closeFiscalYear).mockResolvedValue({
      dryRun: true, netIncome: 600000,
      preview: {
        entryDate: '2027-02-28', entryNumber: 'YE-2027', description: 'Year-End Closing: 2027',
        totalDebit: 1000000, totalCredit: 1000000,
        lines: [
          { accountId: 'r', accountCode: '4000', accountName: 'Sales', debit: 1000000, credit: 0 },
          { accountId: 'e', accountCode: '5000', accountName: 'Wages', debit: 0, credit: 400000 },
          { accountId: 're', accountCode: '3200', accountName: 'RE', debit: 0, credit: 600000 },
        ],
      },
    });

    const res = await yearEndCloseTool.handler({ fiscal_year: 2027, dry_run: true, ...KEY }, ctx);

    expect((res as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    const b = body(res) as { would_post: { lines: unknown[]; total_debit: number } };
    expect(b.would_post.lines).toHaveLength(3);
    expect(b.would_post.total_debit).toBe(1000000);
  });

  it('NAMES the periods blocking the close', async () => {
    vi.mocked(closeFiscalYear).mockResolvedValue({
      error: 'open_periods', count: 2,
      openPeriods: [
        { id: 'a', periodName: 'March 2026', periodNumber: 1 },
        { id: 'b', periodName: 'April 2026', periodNumber: 2 },
      ],
    });
    const res = await yearEndCloseTool.handler({ fiscal_year: 2027, ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/March 2026, April 2026/);
    expect(res.content[0]!.text).toMatch(/Nothing was posted/);
  });

  it('names the fix when no retained-earnings account exists', async () => {
    vi.mocked(closeFiscalYear).mockResolvedValue({ error: 'no_retained_earnings', accountCode: '3200' });
    const res = await yearEndCloseTool.handler({ fiscal_year: 2027, ...KEY }, ctx);
    expect(res.content[0]!.text).toMatch(/create_gl_account/);
  });

  it('RETHROWS a failure from inside the write transaction', async () => {
    vi.mocked(closeFiscalYear).mockRejectedValue(Object.assign(new Error('boom'), { code: '23505' }));
    await expect(yearEndCloseTool.handler({ fiscal_year: 2027, ...KEY }, ctx))
      .rejects.toThrow('boom');
  });

  it('refuses a non-integer fiscal_year before any service call', async () => {
    const res = await yearEndCloseTool.handler({ fiscal_year: 'twenty-seven', ...KEY }, ctx);
    expect(res.isError).toBe(true);
    expect(closeFiscalYear).not.toHaveBeenCalled();
  });
});
