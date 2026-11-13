/**
 * run_recurring_journals (MCP brief step 7): the tool's half — the period argument, the scope decision it hands the
 * service (write:post per template, agent stamping, no approval raised), the answer's shape, and wroteNothing on a
 * dry run or a run that generated nothing. The generating, the once-only claim and every skip are proven against a
 * real database in tests/integration/mcp-recurring-journals.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/recurringJournalPeriodRun', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/recurringJournalPeriodRun')>()),
  runRecurringJournalsForPeriod: vi.fn(),
}));

import { periodBounds, runRecurringJournalsForPeriod } from '@/modules/accounting/services/gl/recurringJournalPeriodRun';
import { runRecurringJournalsTool } from '@/lib/mcp/tools/writeRunRecurringJournals';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const ctx = (scopes = ['write:journals']) =>
  ({ companyId: 'cccccccc-0000-4000-8000-cccccccccccc', userId: 'u-1', tokenJti: 'jti-9', scopes }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;
const body = (r: McpToolResult) => JSON.parse(text(r)) as Record<string, unknown>;
const RUN = { period: '2026-10', periodStart: '2026-10-01', periodEnd: '2026-10-31' };
const GEN = { templateId: 't-1', templateName: 'Rent', runDate: '2026-10-31', journalId: 'j-1', posted: true };
const SKIP = { templateId: 't-2', templateName: 'Fees', runDate: '2026-10-15', reason: 'refused', message: 'closed' };

beforeEach(() => { vi.clearAllMocks(); });

describe('periodBounds', () => {
  it('gives a month\'s first and last day, leap years included', () => {
    expect(periodBounds('2028-02')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodBounds('2026-12')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
  it.each(['2026-13', '2026-1', '2026-10-01', 'October'])('refuses %s', (p) => {
    expect(periodBounds(p)).toBeNull();
  });
});

describe('run_recurring_journals', () => {
  it('is a write:journals tool; write:post is decided per template, not by the registry', () => {
    expect(runRecurringJournalsTool.scope).toBe('write:journals');
    expect(runRecurringJournalsTool.write).toBe(true);
    expect(runRecurringJournalsTool.requiresPost).toBeUndefined();
  });

  it.each([undefined, '2026-13', '2026/10'])('refuses period %s before running anything', async (period) => {
    const r = await runRecurringJournalsTool.handler({ period, idempotency_key: 'k' }, ctx());
    expect(text(r)).toBe('period is required, as YYYY-MM');
    expect(runRecurringJournalsForPeriod).not.toHaveBeenCalled();
  });

  it('runs as an agent: stamped, raising no approval, posting only with write:post', async () => {
    vi.mocked(runRecurringJournalsForPeriod).mockResolvedValue({ ...RUN, generated: [], skipped: [] });
    await runRecurringJournalsTool.handler({ period: '2026-10', idempotency_key: 'k' }, ctx());
    await runRecurringJournalsTool.handler({ period: '2026-10', idempotency_key: 'k' }, ctx(['write:journals', 'write:post']));
    const [first, second] = vi.mocked(runRecurringJournalsForPeriod).mock.calls;
    expect(first!.slice(0, 3)).toEqual(['cccccccc-0000-4000-8000-cccccccccccc', 'u-1', '2026-10']);
    expect(first![3]).toEqual({
      canPost: false, dryRun: false,
      run: { agent: true, meta: { postingAgent: 'mcp:run_recurring_journals:v1', actorType: 'agent', actorTokenJti: 'jti-9' } },
    });
    expect(second![3].canPost).toBe(true);
  });

  it('live: returns each run\'s journal id and status, and the skips; the key is kept', async () => {
    vi.mocked(runRecurringJournalsForPeriod).mockResolvedValue({
      ...RUN, generated: [GEN, { ...GEN, templateId: 't-3', journalId: 'j-2', posted: false }], skipped: [SKIP as never],
    });
    const r = await runRecurringJournalsTool.handler({ period: '2026-10', idempotency_key: 'k' }, ctx());
    expect(r.wroteNothing).toBeUndefined();
    expect(body(r)).toEqual({
      period: '2026-10', period_start: '2026-10-01', period_end: '2026-10-31',
      generated: [
        { recurring_journal_id: 't-1', template_name: 'Rent', run_date: '2026-10-31', journal_id: 'j-1', status: 'posted' },
        { recurring_journal_id: 't-3', template_name: 'Rent', run_date: '2026-10-31', journal_id: 'j-2', status: 'draft' },
      ],
      journal_ids: ['j-1', 'j-2'],
      skipped: [{ recurring_journal_id: 't-2', template_name: 'Fees', run_date: '2026-10-15', reason: 'refused', message: 'closed' }],
    });
  });

  it('a live run that generated nothing frees the key, so the same call works once the cause is fixed', async () => {
    vi.mocked(runRecurringJournalsForPeriod).mockResolvedValue({ ...RUN, generated: [], skipped: [SKIP as never] });
    const r = await runRecurringJournalsTool.handler({ period: '2026-10', idempotency_key: 'k' }, ctx());
    expect(r.wroteNothing).toBe(true);
  });

  it('dry run: lists what would be generated, with no journal ids, and frees the key', async () => {
    vi.mocked(runRecurringJournalsForPeriod).mockResolvedValue({ ...RUN, generated: [{ ...GEN, journalId: null }], skipped: [] });
    const r = await runRecurringJournalsTool.handler({ period: '2026-10', dry_run: true, idempotency_key: 'k' }, ctx());
    expect(vi.mocked(runRecurringJournalsForPeriod).mock.calls[0]![3].dryRun).toBe(true);
    expect(r.wroteNothing).toBe(true);
    expect(body(r)).toMatchObject({
      dry_run: true,
      would_generate: [{ recurring_journal_id: 't-1', run_date: '2026-10-31', status: 'posted' }],
    });
    expect((body(r).would_generate as Record<string, unknown>[])[0]).not.toHaveProperty('journal_id');
    expect(body(r)).not.toHaveProperty('journal_ids');
  });
});
