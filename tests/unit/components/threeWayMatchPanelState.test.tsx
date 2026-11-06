// The panel renders what the route returns (`ThreeWayMatchState`). It used to read fields the route never sent, so
// every bill read "no linked PO", whatever its link.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { ThreeWayMatchPanel } from '@/components/accounting/ap/ThreeWayMatchPanel';
import type { ThreeWayMatchState } from '@/modules/accounting/services/ap/threeWayMatchState';

const respond = (state: ThreeWayMatchState) => vi.mocked(apiFetch).mockResolvedValue(
  new Response(JSON.stringify({ success: true, data: state }), { status: 200 }),
);
const base = {
  invoiceId: 'b', matchStatus: 'po_matched', paymentMatched: false, paymentMatchedAt: null,
  tolerancesApplied: { qtyTolerancePct: 2, priceTolerancePct: 2 },
} as const;

afterEach(() => vi.mocked(apiFetch).mockReset());

describe('ThreeWayMatchPanel', () => {
  it('shows a linked bill\'s lines against its PO', async () => {
    respond({
      ...base, hasPurchaseOrder: true,
      summary: { totalLines: 1, fullyMatched: 0, priceMismatches: 1, quantityMismatches: 0, grnMismatches: 1 },
      itemResults: [{
        invoiceItemId: 'i', description: 'Router', poQuantity: 1, invoiceQuantity: 1, grnQuantityReceived: 0, poUnitPrice: 100,
        invoiceUnitPrice: 110, qtyVariancePct: 0, priceVariancePct: 10, lineMatchStatus: 'unmatched', mismatches: [],
      }],
    });
    render(<ThreeWayMatchPanel invoiceId="b" />);
    expect(await screen.findByText('Router')).toBeTruthy();
    expect(screen.getByText(/1 price mismatch/)).toBeTruthy();
    expect(screen.queryByText(/no linked PO/)).toBeNull();
  });

  it('says so when the bill has no PO', async () => {
    respond({
      ...base, matchStatus: 'unmatched', hasPurchaseOrder: false, itemResults: [],
      summary: { totalLines: 1, fullyMatched: 0, priceMismatches: 0, quantityMismatches: 0, grnMismatches: 0 },
    });
    render(<ThreeWayMatchPanel invoiceId="b" />);
    expect(await screen.findByText(/no linked PO/)).toBeTruthy();
  });
});
