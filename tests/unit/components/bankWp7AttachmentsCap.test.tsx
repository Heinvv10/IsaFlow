/**
 * WP7: a line with more documents than one list carries says so, in BOTH places that list them: "Showing newest N of M".
 * The modal reads the TRUE total from X-Attachments-Total (and reports it, not the list length, to the row badge); the
 * drawer reads it from the row's own attachmentCount (the same visible predicate).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { BankLineDrawerBody } from '@/components/accounting/bank-transactions/BankLineDrawerBody';
import { attachmentTotal } from '@/components/accounting/bankTxAttachmentHelpers';
import type { BankTx } from '@/components/accounting/BankTxTable';

useApiJsonOverMock();
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, bank_transaction_id: 'bt-1', file_name: `f${i}.png`, file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' }));
const resp = (n: number, total?: number) => new Response(JSON.stringify({ success: true, data: files(n) }), { status: 200, headers: total === undefined ? {} : { 'X-Attachments-Total': String(total) } });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('attachmentTotal', () => {
  const r = (v: string | null) => ({ headers: { get: () => v } });
  it('reads the header; falls back to the list length when it is absent, garbled or smaller than the list', () => {
    expect(attachmentTotal(r('137'), 100)).toBe(137);
    expect(attachmentTotal(r(null), 5)).toBe(5);
    expect(attachmentTotal(r('abc'), 5)).toBe(5);
    expect(attachmentTotal(r('3'), 5)).toBe(5);
    expect(attachmentTotal(r('1.5'), 1)).toBe(1);
  });
});

describe('modal', () => {
  it('a cut list says "Showing newest 3 of 137" and reports the TRUE total to the row badge', async () => {
    vi.mocked(apiFetch).mockResolvedValue(resp(3, 137));
    const onCount = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCount} onClose={() => undefined} />);
    expect((await screen.findByTestId('attachments-truncated')).textContent).toBe('Showing newest 3 of 137');
    expect(onCount).toHaveBeenCalledWith(137); // not 3
    expect(screen.getByText('137 attachments')).toBeTruthy();
  });

  it('an uncut list has no notice and reports its length', async () => {
    vi.mocked(apiFetch).mockResolvedValue(resp(3, 3));
    const onCount = vi.fn();
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onCountChange={onCount} onClose={() => undefined} />);
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
    expect(screen.queryByTestId('attachments-truncated')).toBeNull();
  });
});

describe('modal: delete on a cut list', () => {
  // Removing an attachment asks first (window.confirm, WP3): answer yes; afterEach unstubs it.
  beforeEach(() => { vi.stubGlobal('confirm', () => true); });
  it('when older rows exist (total > list), a delete refetches so the next-older rows appear', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if ((init as RequestInit | undefined)?.method === 'DELETE') return new Response(JSON.stringify({ success: true }), { status: 200 });
      gets += 1;
      return gets === 1 ? resp(3, 5) : resp(4, 4);
    });
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Remove f0.png'));
    await waitFor(() => expect(gets).toBe(2));
    expect(await screen.findByText('f3.png')).toBeTruthy(); // an older row that was cut before
  });

  it('a delete on a whole list does NOT refetch', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if ((init as RequestInit | undefined)?.method === 'DELETE') return new Response(JSON.stringify({ success: true }), { status: 200 });
      gets += 1;
      return resp(3, 3);
    });
    render(<BankTxAttachmentsModal bankTransactionId="bt-1" onClose={() => undefined} />);
    fireEvent.click(await screen.findByLabelText('Remove f0.png'));
    await waitFor(() => expect(screen.queryByText('f0.png')).toBeNull());
    expect(gets).toBe(1);
  });
});

describe('drawer', () => {
  const TX: BankTx = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115, status: 'imported', attachmentCount: 140 };
  it('says "Showing newest 3 of 140" when the row true count exceeds the list', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u).includes('bank-tx-attachments') ? resp(3) : new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })));
    render(<BankLineDrawerBody tx={TX} />);
    expect((await screen.findByTestId('attachments-truncated')).textContent).toBe('Showing newest 3 of 140');
  });
  it('no notice when the count matches the list', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u).includes('bank-tx-attachments') ? resp(3) : new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })));
    render(<BankLineDrawerBody tx={{ ...TX, attachmentCount: 3 }} />);
    await screen.findByText('f0.png');
    expect(screen.queryByTestId('attachments-truncated')).toBeNull();
  });
});
