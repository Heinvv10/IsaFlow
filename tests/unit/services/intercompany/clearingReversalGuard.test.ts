/**
 * Intercompany P4-D round 3 (D, H): the clearing-receipt reversal guard asks one cheap question first (does this company hold ANY accepted
 * allocation clearing?) and walks no chain when it does not; with one it refuses as before. The receipt's cancel names itself in any spelling of
 * its id (case, braces).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ any: true, receipt: null as null | { id: string; payment_number: string }, texts: [] as string[], root: 'je-1' }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    m.texts.push(text);
    if (text.includes('LIMIT 1') && !text.includes('customer_payments p')) return m.any ? [{ one: 1 }] : [];
    return m.receipt ? [m.receipt] : [];
  }),
}));
const chain = vi.hoisted(() => ({ findJournalChainRoot: vi.fn(async () => m.root) }));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => chain);

import { refuseReversingIntercompanyClearing } from '@/modules/accounting/services/intercompany/clearingReversalGuard';

const RECEIPT = 'a0000000-0000-4000-8000-0000000000ab';
beforeEach(() => { m.any = true; m.receipt = null; m.texts = []; m.root = 'je-1'; chain.findJournalChainRoot.mockClear(); });

describe('refuseReversingIntercompanyClearing', () => {
  it('a company with no accepted clearing: one existence query, no chain walk, no refusal', async () => {
    m.any = false;
    await refuseReversingIntercompanyClearing('co-1', { id: 'je-1', entryNumber: 'JE-1' });
    expect(chain.findJournalChainRoot).not.toHaveBeenCalled();
    expect(m.texts).toHaveLength(1);
    expect(m.texts[0]).toMatch(/FROM intercompany_messages[\s\S]*kind = 'allocation'[\s\S]*status = 'accepted'[\s\S]*LIMIT 1/);
  });

  it('a company with one: the chain is walked and a clearing receipt journal is refused', async () => {
    m.receipt = { id: RECEIPT, payment_number: 'CP-1' };
    await expect(refuseReversingIntercompanyClearing('co-1', { id: 'je-1', entryNumber: 'JE-1' })).rejects.toThrow(/clears an intercompany payment/);
    expect(chain.findJournalChainRoot).toHaveBeenCalledWith('co-1', 'je-1');
  });

  it("the receipt's own cancel passes in any spelling of its id; a non-root entry naming it does not", async () => {
    m.receipt = { id: RECEIPT, payment_number: 'CP-1' };
    for (const spelt of [RECEIPT, RECEIPT.toUpperCase(), `{${RECEIPT.toUpperCase()}}`, ` ${RECEIPT} `]) {
      await expect(refuseReversingIntercompanyClearing('co-1', { id: 'je-1', entryNumber: 'JE-1' }, spelt)).resolves.toBeUndefined();
    }
    m.root = 'je-0';
    await expect(refuseReversingIntercompanyClearing('co-1', { id: 'je-1', entryNumber: 'JE-1' }, RECEIPT)).rejects.toThrow(/clears an intercompany payment/);
  });
});
