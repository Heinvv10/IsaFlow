/**
 * approveCreditNote takes a customer note's keys (shared/creditNoteWalkKeys) as the next statement after its note row,
 * before its journal, walk or not, and hands them to the walk (#1701 round 8 item 1).
 */
import { describe, expect, it, vi } from 'vitest';
import { mockCreateJournalEntry, setNote, creditNoteRow, COMPANY_ID, CN_ID, USER_ID } from './creditNoteService.harness';

const order = vi.hoisted(() => [] as string[]);
vi.mock('@/modules/accounting/services/shared/creditNoteWalkKeys', () => ({
  lockCustomerWalkKeys: vi.fn(async () => { order.push('keys'); return new Set<string>(); }),
}));

import { lockCustomerWalkKeys } from '@/modules/accounting/services/shared/creditNoteWalkKeys';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';

describe('approveCreditNote and the walk keys', () => {
  it.each([['fifo', true], ['linked', false], ['none', false]] as const)('auto_apply %s: keys (walk %s) before the journal', async (autoApply, walk) => {
    order.length = 0; vi.mocked(lockCustomerWalkKeys).mockClear();
    mockCreateJournalEntry.mockImplementationOnce((async () => { order.push('journal'); return { id: 'je' }; }) as never);
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved' })]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply });
    expect(lockCustomerWalkKeys).toHaveBeenCalledWith(COMPANY_ID, 'client-uuid', null, walk, 1150);
    expect(order).toEqual(['keys', 'journal']);
  });
});
