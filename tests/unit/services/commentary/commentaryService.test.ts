/**
 * Persistence and approval for commentary, with the database mocked.
 *
 * The properties pinned here are the ones that would still pass a happy-path
 * test while being wrong in production: that every statement carries
 * company_id, that an approval writes approved_text, approved_by and
 * approved_at in ONE statement (the 611 CHECK can never see a partial row),
 * that the approver is the id the caller was given rather than anything read
 * back from the row, and that an empty draft is refused before any write.
 *
 * Mutation check: drop `AND company_id = ...` from either UPDATE and the
 * cross-company tests go red; split the approval into two UPDATEs and the
 * single-statement test goes red; approve an empty draft and the guard test
 * goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const infoMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: (...a: unknown[]) => infoMock(...a), warn: vi.fn(), error: vi.fn() },
}));

import {
  approveCommentary, rejectCommentary, listCommentary, generateDrafts,
} from '@/modules/accounting/services/commentary/commentaryService';
import { canonicalParamsHash, type SharePackParams } from '@/modules/accounting/services/share/shareParams';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';
const PARAMS: SharePackParams = { type: 'board', from: '2026-01-01', to: '2026-03-31' };

const DATA: ManagementPackData = {
  companyName: 'Britech',
  period: '2026-01-01 to 2026-03-31',
  incomeStatement: { revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, netProfit: 150_000 },
  balanceSheet: { totalAssets: 2_000_000, totalLiabilities: 800_000, equity: 1_200_000, currentRatio: 0.9, debtEquityRatio: 0.67 },
  priorPeriod: { revenue: 800_000, costOfSales: 500_000, grossProfit: 300_000, operatingExpenses: 220_000, netProfit: 80_000 },
  ratios: { grossMargin: 40, netMargin: 15, currentRatio: 0.9, quickRatio: 0.7 },
};

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  company_id: COMPANY,
  report_kind: 'pack',
  params_hash: canonicalParamsHash(PARAMS),
  section_ref: 'income_statement',
  row_ref: 'revenue',
  draft_text: 'Revenue increased by 25.0%.',
  approved_text: null,
  status: 'draft',
  generated_by: 'user-1',
  approved_by: null,
  approved_at: null,
  withdrawn_by: null,
  withdrawn_at: null,
  ...over,
});

/** The interpolated values of the Nth `sql` call. */
const values = (call = 0): unknown[] => sqlMock.mock.calls[call]!.slice(1);
const text = (call = 0): string => (sqlMock.mock.calls[call]![0] as string[]).join(' ? ');

beforeEach(() => { sqlMock.mockReset(); infoMock.mockReset(); });

describe('listCommentary', () => {
  it('scopes to the company and the canonical params hash', async () => {
    sqlMock.mockResolvedValue([dbRow()]);
    const rows = await listCommentary(COMPANY, PARAMS);

    expect(text()).toContain('company_id');
    expect(values()).toContain(COMPANY);
    expect(values()).toContain(canonicalParamsHash(PARAMS));
    expect(rows[0]).toMatchObject({ id: ID, sectionRef: 'income_statement', rowRef: 'revenue', status: 'draft', approvedText: null });
  });
});

describe('approveCommentary', () => {
  it('writes approved_text, approved_by and approved_at in one statement, under the caller-supplied user', async () => {
    sqlMock
      .mockResolvedValueOnce([{ status: 'draft', draft_text: 'Revenue increased by 25.0%.' }])
      .mockResolvedValueOnce([dbRow({ status: 'approved', approved_text: 'Revenue increased by 25.0%.', approved_by: 'approver-9', approved_at: new Date('2026-04-01T10:00:00Z') })]);

    const result = await approveCommentary(COMPANY, ID, 'approver-9');
    expect(result.ok).toBe(true);

    // Exactly two statements: the read, then ONE write.
    expect(sqlMock).toHaveBeenCalledTimes(2);
    const update = text(1);
    expect(update).toContain('approved_text');
    expect(update).toContain('approved_by');
    expect(update).toContain('approved_at');
    expect(update).toContain('NOW()');
    expect(values(1)).toContain('approver-9');
    expect(values(1)).toContain(COMPANY);
    expect(values(1)).toContain(ID);
    // Guarded at the write, not only in the branch above: two racing approvals
    // must not both write.
    expect(update).toContain("status = 'draft'");

    if (result.ok) {
      expect(result.row.approvedBy).toBe('approver-9');
      expect(result.row.approvedText).toBe('Revenue increased by 25.0%.');
      expect(result.row.approvedAt).toBe('2026-04-01T10:00:00.000Z');
    }
    expect(infoMock).toHaveBeenCalled();
  });

  it('refuses an empty or whitespace-only draft before any write', async () => {
    for (const draft of ['', '   ', '\n\t']) {
      sqlMock.mockReset();
      sqlMock.mockResolvedValueOnce([{ status: 'draft', draft_text: draft }]);
      const result = await approveCommentary(COMPANY, ID, 'approver-9');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('empty_draft');
      expect(sqlMock).toHaveBeenCalledTimes(1); // the read only
    }
  });

  it('reports not_found for an id belonging to another company, without writing', async () => {
    sqlMock.mockResolvedValueOnce([]); // the company_id predicate matched nothing
    const result = await approveCommentary(OTHER_COMPANY, ID, 'approver-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(values(0)).toContain(OTHER_COMPANY);
  });

  it('cannot approve the same row twice', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'approved', draft_text: 'Revenue increased by 25.0%.' }]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_state');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('reports invalid_state when the guarded UPDATE loses the race and matches no row', async () => {
    sqlMock
      .mockResolvedValueOnce([{ status: 'draft', draft_text: 'Revenue increased by 25.0%.' }])
      .mockResolvedValueOnce([]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_state');
  });
});

describe('rejectCommentary', () => {
  it('rejects a draft without touching the approval columns', async () => {
    sqlMock
      .mockResolvedValueOnce([{ status: 'draft', draft_text: 'Revenue increased by 25.0%.' }])
      .mockResolvedValueOnce([dbRow({ status: 'rejected' })]);

    const result = await rejectCommentary(COMPANY, ID, 'user-1');
    expect(result.ok).toBe(true);
    expect(text(1)).not.toContain('approved_text');
    expect(values(1)).toContain(COMPANY);
  });

  it('refuses to reject an already-rejected row', async () => {
    sqlMock.mockResolvedValueOnce([{ status: 'rejected', draft_text: 'x' }]);
    const result = await rejectCommentary(COMPANY, ID, 'user-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_state');
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('generateDrafts', () => {
  it('writes every sentence company-scoped and never sets approved_text', async () => {
    sqlMock.mockResolvedValueOnce([]); // listCommentary: nothing yet
    sqlMock.mockResolvedValue([{ id: ID }]);

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });

    expect(result.written).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
    for (let i = 1; i < sqlMock.mock.calls.length; i += 1) {
      expect(values(i)).toContain(COMPANY);
      expect(values(i)).toContain(canonicalParamsHash(PARAMS));
      expect(text(i)).toContain("'draft'");
    }
  });

  it('leaves an approved row alone and reports it as skipped', async () => {
    sqlMock.mockResolvedValueOnce([
      dbRow({ status: 'approved', approved_text: 'Signed off.', approved_by: 'approver-9', approved_at: new Date() }),
    ]);
    sqlMock.mockResolvedValue([{ id: ID }]);

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });

    expect(result.skipped).toContain('income_statement:revenue');
    const written = sqlMock.mock.calls.slice(1).map(c => (c.slice(1) as unknown[]));
    expect(written.some(v => v.includes('revenue'))).toBe(false);
  });

  it('stamps the withdrawal and PRESERVES the approver, only with replace', async () => {
    // The record of who approved a sentence must survive the sentence being
    // withdrawn — otherwise "who signed off on the March commentary, and who
    // took it back?" has no answer in the database. Migration 612 adds the two
    // withdrawal columns; the approval columns are left exactly as they are.
    sqlMock.mockResolvedValueOnce([
      dbRow({ status: 'approved', approved_text: 'Signed off.', approved_by: 'approver-9', approved_at: new Date() }),
    ]);
    sqlMock.mockResolvedValue([{ id: ID }]);

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA, replace: true });

    expect(result.skipped).toEqual([]);
    const revenueCall = sqlMock.mock.calls.findIndex((c, i) => i > 0 && (c.slice(1) as unknown[]).includes('revenue'));
    expect(revenueCall).toBeGreaterThan(0);
    const stmt = text(revenueCall);
    expect(stmt).toContain('withdrawn_by');
    expect(stmt).toContain('withdrawn_at');
    // Not touched at all — no assignment, so no way to lose them.
    expect(stmt).not.toContain('approved_text =');
    expect(stmt).not.toContain('approved_by =');
    expect(stmt).not.toContain('approved_at =');
    // The withdrawer is the authenticated caller, interpolated, not the
    // generated_by of some earlier run.
    expect(values(revenueCall)).toContain('user-1');
    expect(values(revenueCall)).toContain(true); // replace
    expect(infoMock).toHaveBeenCalledWith(
      'Commentary approval withdrawn by regeneration', expect.anything(), 'commentary',
    );
  });

  it('reads the withdrawal columns back onto the row', async () => {
    const withdrawnAt = new Date('2026-09-06T08:30:00.000Z');
    sqlMock.mockResolvedValueOnce([dbRow({
      approved_text: 'Signed off.', approved_by: 'approver-9', approved_at: new Date('2026-09-01T00:00:00.000Z'),
      withdrawn_by: 'user-1', withdrawn_at: withdrawnAt,
    })]);
    const [row] = await listCommentary(COMPANY, PARAMS);
    // A withdrawn row: still a draft, still naming the person who approved it.
    expect(row!.status).toBe('draft');
    expect(row!.approvedBy).toBe('approver-9');
    expect(row!.withdrawnBy).toBe('user-1');
    expect(row!.withdrawnAt).toBe(withdrawnAt.toISOString());
  });

  it('leaves the withdrawal columns alone when the row was not approved', async () => {
    sqlMock.mockResolvedValueOnce([dbRow({ status: 'draft', withdrawn_by: 'someone-earlier' })]);
    sqlMock.mockResolvedValue([{ id: ID }]);
    await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });

    // The CASE is on the row's state at WRITE time, so re-drafting an ordinary
    // draft cannot rewrite the record of a withdrawal that happened earlier.
    const stmt = text(1);
    expect(stmt).toContain("CASE WHEN report_commentary.status = 'approved' THEN");
    expect(stmt).toContain('ELSE report_commentary.withdrawn_by END');
    expect(stmt).toContain('ELSE report_commentary.withdrawn_at END');
  });

  it('does not revive a rejected sentence on a plain generate', async () => {
    sqlMock.mockResolvedValueOnce([dbRow({ status: 'rejected' })]);
    sqlMock.mockResolvedValue([{ id: ID }]);

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });

    expect(result.skipped).toContain('income_statement:revenue');
    const written = sqlMock.mock.calls.slice(1).map(c => (c.slice(1) as unknown[]));
    expect(written.some(v => v.includes('revenue'))).toBe(false);
  });

  it('revives a rejected sentence only when replace was asked for', async () => {
    sqlMock.mockResolvedValueOnce([dbRow({ status: 'rejected' })]);
    sqlMock.mockResolvedValue([{ id: ID }]);

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA, replace: true });

    expect(result.skipped).toEqual([]);
    const written = sqlMock.mock.calls.slice(1).map(c => (c.slice(1) as unknown[]));
    expect(written.some(v => v.includes('revenue'))).toBe(true);
  });

  it('guards the write on the row being a draft, not merely on it not being approved', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValue([{ id: ID }]);
    await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });

    const stmt = text(1);
    expect(stmt).toContain("report_commentary.status = 'draft'");
    expect(stmt).not.toContain("report_commentary.status <> 'approved'");
    // Withdrawal is stamped on the row's state at write time, so a row approved
    // inside the read-to-write window is recorded as withdrawn by whoever's
    // regeneration actually did it.
    expect(stmt).toContain("withdrawn_at = CASE WHEN report_commentary.status = 'approved' THEN NOW()");
  });

  it('counts a row the ON CONFLICT guard refused as skipped, not written', async () => {
    sqlMock.mockResolvedValueOnce([]); // nothing when we read
    sqlMock.mockResolvedValue([]);     // every write matched no row (raced to approved)

    const result = await generateDrafts({ companyId: COMPANY, userId: 'user-1', params: PARAMS, data: DATA });
    expect(result.written).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});
