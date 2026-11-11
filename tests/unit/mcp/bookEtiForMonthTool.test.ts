/**
 * book_eti_for_month (wave 5 ET, review round 4 M1(c)): the connector's "Book ETI for this month".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({ bookEtiForMonthLocked: vi.fn(), previewEtiForMonth: vi.fn() }));

import { bookEtiForMonthLocked, previewEtiForMonth } from '@/modules/accounting/services/payroll/etiRebook';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import { bookEtiForMonthTool } from '@/lib/mcp/tools/bookEtiForMonth';

const ctx = { companyId: 'co', userId: 'u1' } as never;
const text = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;
beforeEach(() => vi.resetAllMocks());

describe('book_eti_for_month', () => {
  it('posts to the ledger: write:payroll with write:post, like approve_pay_run', () => {
    expect(bookEtiForMonthTool).toMatchObject({ scope: 'write:payroll', write: true, requiresPost: true, requiresWriteRole: true });
  });
  it('dry run previews and writes nothing (wroteNothing keeps the idempotency key free)', async () => {
    vi.mocked(previewEtiForMonth).mockResolvedValue({ month: '2026-08', status: 'booked', entryDate: '2026-08-31', usedToBook: 0, refundToBook: 900 });
    const r = await bookEtiForMonthTool.handler({ month: '2026-08', dry_run: true, idempotency_key: 'k' }, ctx);
    expect(r.wroteNothing).toBe(true);
    expect(text(r as never)).toContain('"refundToBook":900');
    expect(bookEtiForMonthLocked).not.toHaveBeenCalled();
  });
  it('live: books with the connector\'s posting agent and answers the journal', async () => {
    vi.mocked(bookEtiForMonthLocked).mockResolvedValue({ month: '2026-08', status: 'booked', journalEntryId: 'je', entryDate: '2026-08-31' });
    const r = await bookEtiForMonthTool.handler({ month: '2026-08', idempotency_key: 'k' }, ctx);
    expect(bookEtiForMonthLocked).toHaveBeenCalledWith('co', { year: 2026, month: 8 }, 'u1', 'mcp:book_eti_for_month:v1');
    expect(text(r as never)).toContain('"journal_entry_id":"je"');
  });
  it('refuses a bad month, a month that has not ended, and a held lock as tool errors', async () => {
    expect((await bookEtiForMonthTool.handler({ month: 'Aug', idempotency_key: 'k' }, ctx)).isError).toBe(true);
    vi.mocked(bookEtiForMonthLocked).mockResolvedValueOnce({ month: '2026-12', status: 'not_ended', journalEntryId: null, entryDate: null });
    expect(text(await bookEtiForMonthTool.handler({ month: '2026-12', idempotency_key: 'k' }, ctx) as never)).toContain('has not ended');
    vi.mocked(bookEtiForMonthLocked).mockRejectedValueOnce(new PayrollLoanLockTimeoutError(null));
    expect((await bookEtiForMonthTool.handler({ month: '2026-08', idempotency_key: 'k' }, ctx)).isError).toBe(true);
  });
});
