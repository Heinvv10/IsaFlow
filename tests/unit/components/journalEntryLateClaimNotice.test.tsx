/**
 * Posting a manual journal dated in a filed VAT period claims its input VAT
 * late (s16(3)); the post route returns `lateClaim` and the journal page must
 * tell the person.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { entryId: 'je-1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import JournalEntryDetailPage from '../../../pages/accounting/journal-entries/[entryId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const draft = {
  id: 'je-1', entryNumber: 'JE-0001', entryDate: '2026-06-20', status: 'draft', source: 'manual',
  description: 'Stationery', createdBy: 'u', createdAt: '', updatedAt: '', lines: [],
};
const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });

describe('journal entry page — late claim notice', () => {
  beforeEach(() => { fetchMock.mockReset(); vi.mocked(notify.info).mockReset(); });

  it('tells the person the VAT was claimed in a later period', async () => {
    fetchMock.mockResolvedValueOnce(ok(draft));
    render(<JournalEntryDetailPage />);
    fetchMock.mockResolvedValueOnce(ok({
      ...draft, status: 'posted',
      lateClaim: { claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax: 15 },
    }));
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'posted' }));
    fireEvent.click(await screen.findByText('Post Entry'));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith(
      'Input VAT of R\xa015.00 claimed late, in the VAT period from 2026-07-01', 'Period 2026-05-01 to 2026-06-30 is filed.'));
  });
});
