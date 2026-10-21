/**
 * codingDecisionLog — each writer issues the write its path needs, and a failed write never reaches the
 * caller (logged, swallowed, inside its own savepoint). The SQL itself runs against a real schema in
 * tests/integration/coding-metrics-counts.int.test.ts and categorization-decisions-rls.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, savepointMock, logError } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  savepointMock: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  logError: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withSavepoint: savepointMock }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() } }));

import {
  recordAllocationDecision, recordAutoPosted, recordAutoPostUndone, recordExcluded, recordHandCorrected,
  recordSuggestionsShown,
} from '@/modules/accounting/services/bank/codingDecisionLog';

const CO = '00000000-0000-4000-8000-000000000001';
const TX = '00000000-0000-4000-8000-000000000002';
const GL = '00000000-0000-4000-8000-000000000003';
const OTHER = '00000000-0000-4000-8000-000000000004';
const USER = 'user-1';

const text = (i: number) => (sqlMock.mock.calls[i]![0] as TemplateStringsArray).join('?');
const values = (i: number) => sqlMock.mock.calls[i]!.slice(1) as unknown[];

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  savepointMock.mockClear();
  logError.mockClear();
});

describe('non-fatal', () => {
  it('a failing write resolves, is logged, and ran inside its own savepoint', async () => {
    sqlMock.mockRejectedValue(new Error('relation "categorization_decisions" does not exist'));
    await expect(recordExcluded(CO, TX, USER)).resolves.toBeUndefined();
    expect(savepointMock).toHaveBeenCalledWith('coding_decision_log', expect.any(Function));
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Coding decision log write failed'),
      expect.objectContaining({ op: 'excluded', companyId: CO, txId: TX }),
      'coding-decisions');
  });
});

describe('recordSuggestionsShown (pending)', () => {
  it('inserts pending rows for the given suggestions, company-scoped, refreshing an open one', async () => {
    await recordSuggestionsShown(CO, [{ txId: TX, source: 'pattern', glAccountId: GL, confidence: 1.7 }]);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(text(0)).toMatch(/INSERT INTO categorization_decisions/);
    expect(text(0)).toMatch(/ON CONFLICT \(company_id, bank_transaction_id\) WHERE outcome = 'pending'/);
    expect(text(0)).toMatch(/bt\.status = 'imported'/);
    expect(values(0)).toContain(CO);
    // Confidence clamped to the column's 0..1.
    expect(values(0)).toContainEqual([1]);
  });
  it('nothing to record: no SQL', async () => {
    await recordSuggestionsShown(CO, []);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('recordAllocationDecision (accept / recode)', () => {
  it('the suggested account: accepted, with the person and the final account', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'd1', suggested_gl_account_id: GL, suggested_contact_id: null }]);
    await recordAllocationDecision(CO, TX, USER, { glAccountId: GL, contactId: null });
    expect(text(1)).toMatch(/UPDATE categorization_decisions/);
    expect(text(1)).toMatch(/outcome = 'pending'/);
    expect(values(1)).toEqual(expect.arrayContaining(['accepted', GL, USER, 'd1', CO]));
  });
  it('another account: recoded', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'd1', suggested_gl_account_id: GL, suggested_contact_id: null }]);
    await recordAllocationDecision(CO, TX, USER, { glAccountId: OTHER, contactId: null });
    expect(values(1)).toContain('recoded');
    expect(values(1)).not.toContain('accepted');
  });
  it('no pending suggestion on the line: nothing is written', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await recordAllocationDecision(CO, TX, USER, { glAccountId: GL, contactId: null });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('recordExcluded (reject)', () => {
  it('closes only a pending row as rejected', async () => {
    await recordExcluded(CO, TX, USER);
    expect(text(0)).toMatch(/SET outcome = 'rejected'/);
    expect(text(0)).toMatch(/AND outcome = 'pending'/);
    expect(values(0)).toEqual([USER, CO, TX]);
  });
});

describe('recordAutoPosted', () => {
  it('turns the pending row into the auto-posted decision, or inserts one', async () => {
    await recordAutoPosted(CO, { txId: TX, source: 'rule', glAccountId: GL, category: 'Fuel' });
    expect(text(0)).toMatch(/WITH upd AS \(\s*UPDATE categorization_decisions/);
    expect(text(0)).toMatch(/was_auto_posted = true, auto_posted_at = now\(\), outcome = 'accepted'/);
    expect(text(0)).toMatch(/decided_by = NULL/);
    expect(text(0)).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM upd\)/);
    expect(values(0)).toEqual(expect.arrayContaining([CO, TX, 'rule', GL, 'Fuel']));
  });
});

describe('recordAutoPostUndone / recordHandCorrected', () => {
  it('undo: the latest standing auto-posted decision becomes undone', async () => {
    await recordAutoPostUndone(CO, TX, USER);
    expect(text(0)).toMatch(/was_auto_posted AND outcome = 'accepted'/);
    expect(text(0)).toMatch(/ORDER BY auto_posted_at DESC/);
    expect(values(0)).toEqual(['undone', USER, CO, TX, CO]);
  });
  it('hand correction: recoded', async () => {
    await recordHandCorrected(CO, TX, USER);
    expect(values(0)[0]).toBe('recoded');
  });
});
