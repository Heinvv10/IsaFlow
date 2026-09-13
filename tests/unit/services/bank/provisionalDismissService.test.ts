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

// Dismiss reverses through the CONTROLLED reversal of the owning bank allocation, not with a direct
// reverseJournalEntry — the kernel refuses that for a generated journal, and the refusal poisoned the request.
const reverseProvisionalEntry = vi.fn();
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  reverseProvisionalEntry: (...a: unknown[]) => reverseProvisionalEntry(...a),
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
    reverseProvisionalEntry.mockReset();
  });

  it('throws when the JE does not belong to the company', async () => {
    routeSql([{ match: /FROM gl_journal_entries/, rows: [] }]);
    await expect(dismissProvisionalEntry('co-1', 'je-x', 'u-1')).rejects.toThrow(/not found/i);
    expect(reverseProvisionalEntry).not.toHaveBeenCalled();
  });

  it('refuses a JE that is not provisional (needs_evidence=false)', async () => {
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: false, status: 'posted' }] },
    ]);
    await expect(dismissProvisionalEntry('co-1', 'je-1', 'u-1')).rejects.toThrow(/not provisional/i);
    expect(reverseProvisionalEntry).not.toHaveBeenCalled();
  });

  it('reverses through the controlled reversal, which returns the bank line to the queue itself', async () => {
    reverseProvisionalEntry.mockResolvedValue({ reversalJournalEntryId: 'je-contra', bankTransactionId: 'tx-1' });
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: true, status: 'posted' }] },
    ]);

    const r = await dismissProvisionalEntry('co-1', 'je-1', 'u-1');

    expect(reverseProvisionalEntry).toHaveBeenCalledWith('co-1', 'je-1', 'u-1', { reason: 'Provisional entry dismissed' });
    expect(r.reversalJournalEntryId).toBe('je-contra');
    expect(r.bankTransactionsReset).toBe(1);
    // No bank_transactions write of its own: the reset happens inside the controlled reversal's effect, under its
    // receipt. A second writer here would put the row outside that receipt.
    const statements = sqlMock.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(statements.some((text) => /UPDATE bank_transactions/.test(text))).toBe(false);
  });

  it('propagates the controlled reversal refusal for a journal no bank line names', async () => {
    // An evidence-only provisional entry has no bank line, so there is no allocation to reverse and nothing to prove a
    // provenance from — the reversal refuses by name, and dismiss no longer reports a success that reversed nothing.
    reverseProvisionalEntry.mockRejectedValue(new Error('No bank transaction names this provisional journal'));
    routeSql([
      { match: /FROM gl_journal_entries/, rows: [{ id: 'je-1', needs_evidence: true, status: 'posted' }] },
    ]);

    await expect(dismissProvisionalEntry('co-1', 'je-1', 'u-1')).rejects.toThrow(/names this provisional journal/);
  });
});
