// The goods received list shows each note's status: a cancelled note (migration 1021, cancel_goods_received) is not an ordinary
// receipt, so it carries a Cancelled pill and its reason; a live note shows its own status.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import GoodsReceivedPage from '../../../pages/accounting/goods-received/index';

const note = (over: Record<string, unknown>) => ({
  id: 'g', grn_number: 'GRN-1', po_number: 'PO-1', supplier_name: 'Acme', received_date: '2026-01-01', received_by: 'Sam', notes: null,
  status: 'received', cancel_reason: null, ...over,
});
afterEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('goods received list', () => {
  it('marks a cancelled note with a Cancelled pill and its reason, and a live note with its own status', async () => {
    const rows = [
      note({ id: 'g1', grn_number: 'GRN-LIVE-1', status: 'received' }),
      note({ id: 'g2', grn_number: 'GRN-GONE-2', status: 'cancelled', cancel_reason: 'Wrong purchase order' }),
    ];
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: rows }), { status: 200 }));
    render(<GoodsReceivedPage />);
    await waitFor(() => expect(screen.getByText('GRN-GONE-2')).toBeTruthy());
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeTruthy();
    const live = screen.getByText('GRN-LIVE-1').closest('tr')!;
    const gone = screen.getByText('GRN-GONE-2').closest('tr')!;
    expect(within(live).getByText('Received')).toBeTruthy();
    expect(within(live).queryByText('Cancelled')).toBeNull();
    expect(within(gone).getByText('Cancelled')).toBeTruthy();
    expect(within(gone).getByText(/Wrong purchase order/)).toBeTruthy();
  });
});
