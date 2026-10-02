/**
 * P3.5 (A–Z Phase 3): dismissing a provisional bank-posted JE must actually
 * REVERSE it — the June audit found the "Dismiss" button showed a toast
 * ("Automatic reversal is not yet implemented") and changed nothing, leaving
 * the provisional journal posted forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));
vi.mock('@/lib/neon', () => ({ sql: sqlMock, withTransaction: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const reverseJournalEntry = vi.fn();
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: (...a: unknown[]) => reverseJournalEntry(...a),
}));

// D8: the entry reversed is the journal's chain head (real-ledger proof:
// tests/integration/d8-r4-matrix, M-DISMISS); here the journal itself stands.
const lockStandingChainHead = vi.fn();
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({
  lockStandingChainHead: (...a: unknown[]) => lockStandingChainHead(...a),
}));

import { dismissProvisionalEntry } from '@/modules/accounting/services/bank/provisionalDismissService';

function routeSql(handlers: Array<{ match: RegExp; rows: unknown[] }>) {
  sqlMock.mockImplementation((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    const h = handlers.find((x) => x.match.test(text));
    return Promise.resolve(h ? h.rows : []);
  });
}

describe('dismissProvisionalEntry', () => {
  beforeEach(() => {
    sqlMock.mockReset();
    reverseJournalEntry.mockReset();
    lockStandingChainHead.mockReset();
    lockStandingChainHead.mockImplementation(async (_companyId: string, id: string) => id);
  });

  it('throws when the JE does not belong to the company', async () => {
    routeSql([{ match: /FROM gl_journal_entries/, rows: [] }]);
    await expect(dismissProvisionalEntry('co-1', 'je-x', 'u-1')).rejects.toThrow(/not found/i);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('refuses a JE that is not provisional (needs_evidence=false)', async () => {
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: false, status: 'posted' }] },
    ]);
    await expect(dismissProvisionalEntry('co-1', 'je-1', 'u-1')).rejects.toThrow(/not provisional/i);
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('reverses the JE and resets the linked bank transaction to imported', async () => {
    reverseJournalEntry.mockResolvedValue({ id: 'je-contra' });
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: true, status: 'posted' }] },
      { match: /UPDATE bank_transactions/, rows: [{ id: 'tx-1' }] },
    ]);

    const r = await dismissProvisionalEntry('co-1', 'je-1', 'u-1');

    expect(reverseJournalEntry).toHaveBeenCalledWith('co-1', 'je-1', 'u-1');
    expect(r.reversalJournalEntryId).toBe('je-contra');
    expect(r.bankTransactionsReset).toBe(1);
    // The bank-txn reset must be company-scoped.
    const updateCall = sqlMock.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).join('?').includes('UPDATE bank_transactions'),
    );
    expect((updateCall![0] as TemplateStringsArray).join('?')).toContain('company_id');
  });

  it('still succeeds when no bank transaction links to the JE (evidence-only provisional)', async () => {
    reverseJournalEntry.mockResolvedValue({ id: 'je-contra' });
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: true, status: 'posted' }] },
      { match: /UPDATE bank_transactions/, rows: [] },
    ]);

    const r = await dismissProvisionalEntry('co-1', 'je-1', 'u-1');
    expect(r.bankTransactionsReset).toBe(0);
    expect(r.reversalJournalEntryId).toBe('je-contra');
  });

  it('reverses nothing when the chain is already out, and still frees the bank line (D8)', async () => {
    lockStandingChainHead.mockResolvedValue(null);
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: true, status: 'posted' }] },
      { match: /UPDATE bank_transactions/, rows: [{ id: 'tx-1' }] },
    ]);

    const r = await dismissProvisionalEntry('co-1', 'je-1', 'u-1');
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(r).toEqual({ reversalJournalEntryId: null, bankTransactionsReset: 1 });
  });
});
