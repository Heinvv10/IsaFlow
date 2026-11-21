/**
 * The Item Movement page renders the report as it now answers (Codex gate at 4840b1a6): a row keyed by a catalogue ITEM (kind
 * 'item', productId null) next to a product row, and a NUMERIC-summed balance (0.3, not 0.30000000000000004).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(async () => true) }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ItemMovement from '../../../pages/accounting/reports/item-movement';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ROWS = [
  { date: '2026-06-20', type: 'GRN', reference: 'GRN-1', kind: 'product', productId: 'p1', itemId: null, itemName: 'Widget product', itemCode: 'P-1', qtyIn: 0.1, qtyOut: 0, balance: 0.1 },
  { date: '2026-06-20', type: 'GRN', reference: 'GRN-2', kind: 'product', productId: 'p1', itemId: null, itemName: 'Widget product', itemCode: 'P-1', qtyIn: 0.2, qtyOut: 0, balance: 0.3 },
  { date: '2026-06-21', type: 'GRN', reference: 'GRN-3', kind: 'item', productId: null, itemId: 'i1', itemName: 'Catalogue bolt', itemCode: 'I-1', qtyIn: 2, qtyOut: 0, balance: 2 },
];

describe('the Item Movement page', () => {
  it('renders item-keyed and product-keyed rows and the NUMERIC balance', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: ROWS }), { status: 200 }));
    render(<ItemMovement />);
    expect(await screen.findByText('Catalogue bolt')).toBeTruthy();
    expect(screen.getAllByText('Widget product')).toHaveLength(2);
    expect(screen.getByText('GRN-3')).toBeTruthy();
    expect(screen.getAllByText('0.3').length).toBeGreaterThan(0);
    expect(screen.queryByText('0.30000000000000004')).toBeNull();
  });
});
