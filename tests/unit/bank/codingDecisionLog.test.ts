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
  postingRefOf, recordAllocationDecision, recordAutoPosted, recordAutoPostUndone, recordExcluded, recordHandCorrected,
  recordMatchDecision, recordSuggestionsShown,
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
  const JE = '00000000-0000-4000-8000-0000000000e1';
  const pendingFor = (gl: string) => sqlMock.mockResolvedValueOnce([{ id: 'd1', suggested_gl_account_id: gl, suggested_contact_id: null }]);

  it('the open suggestion named the posted target: it becomes the auto-posted decision, suggestion untouched', async () => {
    pendingFor(GL);
    await recordAutoPosted(CO, { txId: TX, source: 'pattern', glAccountId: GL, journalEntryId: JE, target: 'suggestion', triggeredBy: USER });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(text(1)).toMatch(/was_auto_posted = true, auto_posted_at = now\(\), posted_journal_entry_id = /);
    expect(text(1)).toMatch(/decided_by = NULL/);
    // Never rewrites the suggestion it is accepting.
    expect(text(1)).not.toMatch(/suggestion_source =|suggested_gl_account_id =/);
    expect(values(1)).toEqual(expect.arrayContaining([JE, GL, 'd1', CO]));
  });

  it('gate sweep, the columns held a person\'s pick: the suggestion is recoded by that person, no auto-post row', async () => {
    pendingFor(OTHER);
    await recordAutoPosted(CO, { txId: TX, source: 'pattern', glAccountId: GL, journalEntryId: JE, target: 'suggestion', triggeredBy: USER });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(text(1)).toMatch(/UPDATE categorization_decisions/);
    expect(values(1)).toEqual(['recoded', GL, null, USER, 'd1', CO]);
    expect(sqlMock.mock.calls.map((_, i) => text(i)).join(' ')).not.toMatch(/INSERT/);
  });

  it('gate sweep with no open suggestion (a person already decided it): nothing is claimed for ISAFlow', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await recordAutoPosted(CO, { txId: TX, source: 'pattern', glAccountId: GL, journalEntryId: JE, target: 'suggestion', triggeredBy: USER });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('ISAFlow\'s own target over a different suggestion: that suggestion is superseded (decided_by NULL), the auto-post gets its own row', async () => {
    pendingFor(OTHER);
    await recordAutoPosted(CO, { txId: TX, source: 'rule', glAccountId: GL, journalEntryId: JE, target: 'own', category: 'Pay J Smith' });
    expect(sqlMock).toHaveBeenCalledTimes(3);
    expect(values(1)).toEqual(['recoded', GL, null, null, 'd1', CO]);
    expect(text(2)).toMatch(/INSERT INTO categorization_decisions/);
    expect(values(2)).toEqual(expect.arrayContaining([CO, TX, 'rule', GL, JE]));
    // A rule's free-text name is never stored.
    expect(values(2)).not.toContain('Pay J Smith');
  });

  it('no open suggestion and ISAFlow\'s own target: one inserted auto-post row', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await recordAutoPosted(CO, { txId: TX, source: 'historical', glAccountId: GL, journalEntryId: JE, target: 'own', category: 'Fuel' });
    expect(sqlMock).toHaveBeenCalledTimes(2);
    expect(text(1)).toMatch(/INSERT INTO categorization_decisions/);
    expect(values(1)).toContain('Fuel');
  });
});

describe('recordMatchDecision', () => {
  const JL = '00000000-0000-4000-8000-0000000000a1';
  it('the matched journal posts the suggested account: accepted, final = that account', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'd1', suggested_gl_account_id: GL, suggested_contact_id: null }]);
    sqlMock.mockResolvedValueOnce([{ gl_ids: [OTHER, GL], contact_ids: [] }]);
    await recordMatchDecision(CO, TX, USER, JL);
    expect(text(1)).toMatch(/FROM gl_journal_lines/);
    expect(text(1)).toMatch(/supplier_payments/);
    expect(text(1)).toMatch(/customer_payments/);
    expect(values(1)).toEqual(expect.arrayContaining([JL, CO]));
    expect(values(2)).toEqual(['accepted', GL, null, USER, 'd1', CO]);
  });
  it('it posts elsewhere: recoded, final = its one account', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'd1', suggested_gl_account_id: GL, suggested_contact_id: null }]);
    sqlMock.mockResolvedValueOnce([{ gl_ids: [OTHER], contact_ids: [] }]);
    await recordMatchDecision(CO, TX, USER, JL);
    expect(values(2)).toEqual(['recoded', OTHER, null, USER, 'd1', CO]);
  });
  it('no open suggestion: only the pending read', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await recordMatchDecision(CO, TX, USER, JL);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('recordSuggestionsShown never stores a rule name', () => {
  it('rule and supplier_rule categories are dropped; a pattern category is kept', async () => {
    await recordSuggestionsShown(CO, [
      { txId: TX, source: 'rule', glAccountId: GL, category: 'J Smith rent' },
      { txId: OTHER, source: 'pattern', glAccountId: GL, category: 'Fuel' },
    ]);
    expect(values(0)).toContainEqual([null, 'Fuel']);
  });
});

describe('recordAutoPostUndone / recordHandCorrected', () => {
  const JE = '00000000-0000-4000-8000-0000000000e1';
  const JL = '00000000-0000-4000-8000-0000000000a1';
  it('undo: only the auto-posted decision whose journal was the line\'s posting before the write', async () => {
    await recordAutoPostUndone(CO, TX, USER, postingRefOf({ matched_journal_line_id: JL, provisional_je_id: null }));
    expect(text(0)).toMatch(/was_auto_posted AND outcome = 'accepted'/);
    expect(text(0)).toMatch(/posted_journal_entry_id IN \(/);
    expect(text(0)).not.toMatch(/ORDER BY auto_posted_at DESC/);
    expect(values(0)).toEqual(['undone', USER, CO, TX, null, null, JL, CO]);
  });
  it('a line with no posting before the write: no SQL at all', async () => {
    await recordAutoPostUndone(CO, TX, USER, postingRefOf({}));
    expect(sqlMock).not.toHaveBeenCalled();
  });
  it('hand correction: recoded, keyed on the posting journal', async () => {
    await recordHandCorrected(CO, TX, USER, { journalEntryId: JE });
    expect(values(0)).toEqual(['recoded', USER, CO, TX, JE, null, null, CO]);
  });
});
