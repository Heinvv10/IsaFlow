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
// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/impersonationGuard.test.ts and the r-032 integration suites.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
// The pack lock is a transaction advisory lock, which only means something
// inside a request transaction; the real race is proved in
// tests/integration/commentary-budget-race.int.test.ts.
const txStore = vi.hoisted(() => ({ current: { client: {} } as { client: object } | undefined }));
vi.mock('@/lib/als', () => ({ als: { getStore: () => txStore.current } }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({
  log: { info: (...a: unknown[]) => infoMock(...a), warn: vi.fn(), error: vi.fn() },
}));

import {
  approveCommentary, rejectCommentary, listCommentary, generateDrafts,
} from '@/modules/accounting/services/commentary/commentaryService';
import {
  MAX_APPROVED_PACK_EMS, MAX_UNBUDGETED_CHARS, approxCharsLeft, commentaryCost,
} from '@/modules/accounting/services/commentary/commentaryLimits';
import { canonicalParamsHash, type SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';
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

/** What `currentRow` reads: the row plus the pack key the budget is scoped by. */
const ROW_READ = { status: 'draft', draft_text: 'Revenue increased by 25.0%.', report_kind: 'pack', params_hash: 'hash-1' };

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

beforeEach(() => { sqlMock.mockReset(); infoMock.mockReset(); txStore.current = { client: {} }; });

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
      .mockResolvedValueOnce([ROW_READ])
      .mockResolvedValueOnce([]) // pack lock
      .mockResolvedValueOnce([{ id: ID, approved_text: null }]) // no other approved rows
      .mockResolvedValueOnce([dbRow({ status: 'approved', approved_text: 'Revenue increased by 25.0%.', approved_by: 'approver-9', approved_at: new Date('2026-04-01T10:00:00Z') })]);

    const result = await approveCommentary(COMPANY, ID, 'approver-9');
    expect(result.ok).toBe(true);

    // The read, the pack lock, the budget read, then ONE write.
    expect(sqlMock).toHaveBeenCalledTimes(4);
    const update = text(3);
    expect(update).toContain('approved_text');
    expect(update).toContain('approved_by');
    expect(update).toContain('approved_at');
    expect(update).toContain('NOW()');
    expect(values(3)).toContain('approver-9');
    expect(values(3)).toContain(COMPANY);
    expect(values(3)).toContain(ID);
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
      .mockResolvedValueOnce([ROW_READ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ID, approved_text: null }]) // no other approved rows
      .mockResolvedValueOnce([]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_state');
  });
});

describe('approveCommentary with edited text', () => {
  const EDITED = 'Revenue grew 25% on the Gauteng rollout; the CFO expects it to hold.';
  const approvedRow = (over: Record<string, unknown> = {}) => dbRow({
    status: 'approved', approved_text: EDITED, approved_by: 'approver-9',
    approved_at: new Date('2026-04-01T10:00:00Z'), ...over,
  });
  /** read, lock, budget read, write. */
  const queue = (draft = 'Revenue increased by 25.0%.', write: unknown[] = [approvedRow()]) => sqlMock
    .mockResolvedValueOnce([{ ...ROW_READ, draft_text: draft }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: ID, approved_text: null }])
    .mockResolvedValueOnce(write);

  it('writes the supplied text, trimmed, as approved_text in the one guarded UPDATE', async () => {
    queue();
    const result = await approveCommentary(COMPANY, ID, 'approver-9', `  ${EDITED}\n`);
    expect(result.ok).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(4);
    const update = text(3);
    expect(values(3)).toContain(EDITED);
    expect(values(3)).toContain('approver-9');
    expect(values(3)).toContain(COMPANY);
    expect(values(3)).toContain(ID);
    expect(update).toContain("status = 'draft'");
    expect(update).toContain('approved_by');
    expect(update).toContain('approved_at');
    // The WHERE repeats the emptiness guard on the SUPPLIED text.
    expect(update).toMatch(/btrim\(\s*\?\s*\)\s*<>/);
    if (result.ok) expect(result.row.approvedText).toBe(EDITED);
  });

  it('leaves draft_text untouched: the edited UPDATE never assigns it', async () => {
    queue();
    await approveCommentary(COMPANY, ID, 'approver-9', EDITED);
    const setClause = text(3).split('WHERE')[0]!;
    expect(setClause).not.toMatch(/draft_text\s*=/);
    expect(setClause).not.toContain('approved_text = draft_text');
  });

  it('approves an edit over a blank machine draft: the person wrote the sentence', async () => {
    queue('   ');
    expect((await approveCommentary(COMPANY, ID, 'approver-9', EDITED)).ok).toBe(true);
  });

  it('refuses text with nothing visible as empty_draft, before any statement', async () => {
    // whitespace, zero-width space, BOM, word joiner, soft hyphen, bidi marks
    for (const blank of ['', '   ', '\n\t ', '​', ' ​​ ', '﻿', '⁠­', '‎‏']) {
      sqlMock.mockReset();
      const result = await approveCommentary(COMPANY, ID, 'approver-9', blank);
      expect(result.ok, JSON.stringify(blank)).toBe(false);
      if (!result.ok) expect(result.code).toBe('empty_draft');
      expect(sqlMock).not.toHaveBeenCalled();
    }
  });

  it('refuses blank-printing characters (Hangul filler, braille blank) as empty_draft', async () => {
    for (const blank of ['\u3164', '\u2800', ' \u115f\u1160 ', '\uffa0']) {
      sqlMock.mockReset();
      const result = await approveCommentary(COMPANY, ID, 'approver-9', blank);
      expect(result.ok, JSON.stringify(blank)).toBe(false);
      if (!result.ok) expect(result.code).toBe('empty_draft');
      expect(sqlMock).not.toHaveBeenCalled();
    }
  });

  it('stores CRLF and lone CR as LF rather than refusing them', async () => {
    queue();
    const result = await approveCommentary(COMPANY, ID, 'approver-9', 'Line one.\r\nLine two.\rLine three.');
    expect(result.ok).toBe(true);
    expect(values(3)).toContain('Line one.\nLine two.\nLine three.');
  });

  it('refuses NUL, C0 controls and lone surrogates as invalid_text, before any statement', async () => {
    for (const bad of ['a\u0000b', 'a\u0001b', 'a\u0008b', 'a\u000bb', 'a\u000cb', 'a\u001bb', 'a\u007fb',
      'a\ud800b', 'a\udc00b', 'ab\ud83d', '\ude00ab']) {
      sqlMock.mockReset();
      const result = await approveCommentary(COMPANY, ID, 'approver-9', bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_text');
      expect(sqlMock).not.toHaveBeenCalled();
    }
  });

  it('accepts newlines, tabs and a well-formed surrogate pair', async () => {
    for (const good of ['line one\nline two', 'col\tcol', 'Sales up 😀']) {
      sqlMock.mockReset();
      queue();
      expect((await approveCommentary(COMPANY, ID, 'approver-9', good)).ok, JSON.stringify(good)).toBe(true);
    }
  });

  it('keeps not_found, invalid_state and a lost race distinct on the edited path', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const missing = await approveCommentary(OTHER_COMPANY, ID, 'approver-9', EDITED);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
    expect(sqlMock).toHaveBeenCalledTimes(1);

    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([{ ...ROW_READ, status: 'approved' }]);
    const done = await approveCommentary(COMPANY, ID, 'approver-9', EDITED);
    expect(done.ok).toBe(false);
    if (!done.ok) expect(done.code).toBe('invalid_state');
    expect(sqlMock).toHaveBeenCalledTimes(1);

    sqlMock.mockReset();
    queue('d', []);
    const raced = await approveCommentary(COMPANY, ID, 'approver-9', EDITED);
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.code).toBe('invalid_state');
  });
});

describe('approveCommentary plain path: the draft it costed is the draft it publishes', () => {
  const read = { ...ROW_READ, draft_text: 'Costed draft.' };
  const approved = dbRow({ status: 'approved', approved_text: 'Costed draft.' });

  it('copies draft_text, and only while draft_text is still the text it read', async () => {
    sqlMock.mockResolvedValueOnce([read]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: ID, approved_text: null }]).mockResolvedValueOnce([approved]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9')).ok).toBe(true);
    expect(text(3)).toContain('approved_text = draft_text');
    expect(text(3)).toMatch(/draft_text =\s+\?/);
    expect(values(3)).toContain('Costed draft.');
  });

  it('answers invalid_state, saying the draft changed, when a regenerate committed in between', async () => {
    sqlMock.mockResolvedValueOnce([read]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: ID, approved_text: null }]).mockResolvedValueOnce([]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid_state');
      expect(result.reason).toMatch(/draft text changed/i);
      expect(result.reason).toMatch(/reload/i);
    }
  });
});

describe('approveCommentary against the pack budget', () => {
  const BOARD = {
    ...ROW_READ, params_hash: canonicalParamsHash(PARAMS), period_start: '2026-01-01', period_end: '2026-03-31',
  };
  const MANAGEMENT = {
    ...BOARD, params_hash: canonicalParamsHash({ ...PARAMS, type: 'management' }),
  };
  /** The pack read: the other approved rows in page order, and this row (no approved text yet) last. */
  const sum = (others: string[]) => [...others.map((t, i) => ({ id: `other-${i}`, approved_text: t })), { id: ID, approved_text: null }];
  const queue = (others: string[], read: Record<string, unknown> = BOARD, draft?: string) => sqlMock
    .mockResolvedValueOnce([draft === undefined ? read : { ...read, draft_text: draft }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(sum(others))
    .mockResolvedValueOnce([dbRow({ status: 'approved' })]);
  /** The longest run of `ch` that fits beside `others`, by the shared ruler. */
  const roomFor = (ch: string, others: string[]): number => {
    let n = 0;
    while (commentaryCost([...others, ch.repeat(n + 1)]) <= MAX_APPROVED_PACK_EMS) n += 1;
    return n;
  };

  it('takes the lock on the pack key BEFORE it reads the sum, in that order', async () => {
    queue([]);
    await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(10));
    expect(text(1)).toContain('pg_advisory_xact_lock');
    // One key for the whole pack: company, kind and params hash.
    expect(String(values(1)[0])).toContain(COMPANY);
    expect(String(values(1)[0])).toContain(BOARD.params_hash);
    expect(text(2)).toContain('SELECT id, approved_text');
  });

  it('reads only approved rows of THIS pack and company, plus the row itself, in page order, and costs them in TS', async () => {
    queue([]);
    await approveCommentary(COMPANY, ID, 'approver-9', 'x');
    const read = text(2);
    expect(read).toContain("status = 'approved'");
    expect(read).toContain('company_id');
    expect(read).toContain('params_hash');
    expect(read).toContain('report_kind');
    // The row being approved is read too, so it is costed at its place in the page's order.
    expect(read).toMatch(/OR id =/);
    expect(read).toMatch(/ORDER BY section_ref, row_ref/);
    expect(read).not.toMatch(/char_length|SUM\(|btrim/); // the ruler is the page's, not SQL's
    expect(values(2)).toEqual(expect.arrayContaining([COMPANY, 'pack', BOARD.params_hash, ID]));
  });

  it('accepts a row that lands exactly on the budget and refuses one more character', async () => {
    const others = ['Revenue grew on the Gauteng rollout.', 'Costs were held flat against the prior period.'];
    const fit = roomFor('x', others);
    expect(fit).toBeGreaterThan(50); // the premise: there is real room beside the others
    queue(others);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(fit))).ok).toBe(true);

    sqlMock.mockReset();
    queue(others);
    const over = await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(fit + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('commentary_budget_exceeded');
    expect(sqlMock).toHaveBeenCalledTimes(3); // read, lock, sum — no UPDATE
  });

  it('states the REAL remainder when other rows have already spent part of the budget', async () => {
    const others = ['y'.repeat(300)];
    queue(others);
    const result = await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(roomFor('x', others) + 10));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const left = approxCharsLeft(MAX_APPROVED_PACK_EMS - commentaryCost(others));
      expect(result.reason).toContain(`About ${left} characters`);
      expect(left).toBeLessThan(approxCharsLeft(MAX_APPROVED_PACK_EMS)); // not the empty-pack figure
    }
  });

  it('answers not_found, writing nothing, if the row is missing from the pack read (it vanished mid-request)', async () => {
    sqlMock.mockResolvedValueOnce([BOARD]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'o1', approved_text: 'Other.' }]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9', 'Some text.');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('costs the row at ITS place in the page order: the same text fits between two rows and not after them', async () => {
    // Pinned numbers: cost([a, x, b]) = 588 <= 600 < cost([a, b, x]) = 616, because where the
    // 20-char words fall against the line ends decides how many lines the paragraph takes.
    const a = 'a'.repeat(10);
    const b = 'b'.repeat(10);
    const x = Array.from({ length: 42 }, () => 'x'.repeat(20)).join(' ');
    expect(commentaryCost([a, x, b])).toBeLessThanOrEqual(MAX_APPROVED_PACK_EMS);
    expect(commentaryCost([a, b, x])).toBeGreaterThan(MAX_APPROVED_PACK_EMS);
    const read = (pack: Array<{ id: string; approved_text: string | null }>) => sqlMock
      .mockResolvedValueOnce([BOARD]).mockResolvedValueOnce([]).mockResolvedValueOnce(pack)
      .mockResolvedValueOnce([dbRow({ status: 'approved' })]);
    read([{ id: 'o1', approved_text: a }, { id: ID, approved_text: null }, { id: 'o2', approved_text: b }]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', x)).ok).toBe(true);

    sqlMock.mockReset();
    read([{ id: 'o1', approved_text: a }, { id: 'o2', approved_text: b }, { id: ID, approved_text: null }]);
    const after = await approveCommentary(COMPANY, ID, 'approver-9', x);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe('commentary_budget_exceeded');
  });

  it('costs by width: the same number of capitals does not fit where lowercase does', async () => {
    const n = roomFor('a', []) - 5;
    queue([]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', 'a'.repeat(n))).ok).toBe(true);
    sqlMock.mockReset();
    queue([]);
    const caps = await approveCommentary(COMPANY, ID, 'approver-9', 'W'.repeat(n));
    expect(caps.ok).toBe(false);
    if (!caps.ok) expect(caps.code).toBe('commentary_budget_exceeded');
  });

  it('counts the row being approved: a plain approval of a long draft is held to the same budget', async () => {
    queue(['y'.repeat(300)], BOARD, 'z'.repeat(roomFor('z', ['y'.repeat(300)]) + 5));
    const result = await approveCommentary(COMPANY, ID, 'approver-9');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('commentary_budget_exceeded');
  });

  it('refuses a single text wider than the whole budget without taking the lock', async () => {
    sqlMock.mockResolvedValueOnce([BOARD]);
    const result = await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(roomFor('x', []) + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('commentary_budget_exceeded');
    expect(sqlMock).toHaveBeenCalledTimes(1); // the read only
  });

  it('measures the supplied text trimmed, as it is stored', async () => {
    queue([]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', `  ${'x'.repeat(roomFor('x', []))}  `)).ok).toBe(true);
  });

  it('does not budget or lock a pack that prints on no fixed page (management)', async () => {
    sqlMock.mockResolvedValueOnce([MANAGEMENT]).mockResolvedValueOnce([dbRow({ status: 'approved' })]);
    const long = 'x'.repeat(roomFor('x', []) * 2);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', long)).ok).toBe(true);
    expect(sqlMock).toHaveBeenCalledTimes(2); // the read and the write: no lock, no sum
  });

  it('reads the period as an ISO date in SQL, so DateStyle cannot change which pack type it matches', async () => {
    queue([]);
    await approveCommentary(COMPANY, ID, 'approver-9', 'x');
    const read = text(0);
    expect(read).toContain("to_char(period_start, 'YYYY-MM-DD')");
    expect(read).toContain("to_char(period_end, 'YYYY-MM-DD')");
    expect(read).not.toMatch(/period_(start|end)::text/);
  });

  it('caps an edited row on a pack with no fixed page, with its own code', async () => {
    const atCap = 'x'.repeat(MAX_UNBUDGETED_CHARS);
    sqlMock.mockResolvedValueOnce([MANAGEMENT]).mockResolvedValueOnce([dbRow({ status: 'approved' })]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9', atCap)).ok).toBe(true);

    sqlMock.mockReset();
    sqlMock.mockResolvedValueOnce([MANAGEMENT]);
    const over = await approveCommentary(COMPANY, ID, 'approver-9', `${atCap}x`);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe('text_too_long');
    expect(sqlMock).toHaveBeenCalledTimes(1); // the read only
  });

  it('does not cap a plain approval of a management draft by the edited-text ceiling', async () => {
    sqlMock.mockResolvedValueOnce([{ ...MANAGEMENT, draft_text: 'd'.repeat(MAX_UNBUDGETED_CHARS + 10) }])
      .mockResolvedValueOnce([dbRow({ status: 'approved' })]);
    expect((await approveCommentary(COMPANY, ID, 'approver-9')).ok).toBe(true);
  });

  it('budgets a row whose pack type cannot be recovered: it fails closed', async () => {
    queue(['y'.repeat(300)], ROW_READ);
    const result = await approveCommentary(COMPANY, ID, 'approver-9', 'x'.repeat(roomFor('x', ['y'.repeat(300)]) + 5));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('commentary_budget_exceeded');
  });

  it('refuses to run outside a request transaction, writing nothing', async () => {
    // pg_advisory_xact_lock on a pooled connection releases at once: the guard
    // would be present in the source and absent at run time.
    txStore.current = undefined;
    sqlMock.mockResolvedValueOnce([BOARD]);
    await expect(approveCommentary(COMPANY, ID, 'approver-9', 'Some text.')).rejects.toThrow(/request transaction/);
    expect(sqlMock).toHaveBeenCalledTimes(1); // the read only: no lock, no UPDATE
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
