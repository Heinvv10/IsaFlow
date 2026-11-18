/**
 * The page wires the supplier's default FNO into the line table: pick a supplier whose rule holds a default CC1,
 * open Dimensions, and a line that names no CC shows that CC1 (read from the cost-centre ladder).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string) => void }) => (
    <><button type="button" onClick={() => onChange('s1')}>pick supplier</button><button type="button" onClick={() => onChange('s2')}>pick supplier 2</button></>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceNew from '../../../pages/accounting/supplier-invoices/new';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => cleanup());

describe('supplier invoice page: the default CC1 reaches the line', () => {
  it('shows the supplier default FNO on a line with no CC of its own', async () => {
    serve(
      on('GET', '/supplier-rules/s1', () => ok({ defaultCc1Id: 'f1', defaultCc2Id: null, defaultBuId: null })),
      on('GET', 'detail=dimensions', () => ok({ items: [{ id: 'f1', code: 'FT', name: 'Fibertime', ccType: 'cc1', isActive: true, fnoCode: 'FT' }] })),
    );
    render(<SupplierInvoiceNew />);
    fireEvent.click(screen.getByRole('button', { name: 'pick supplier' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dimensions' }));
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: FT Fibertime'));
  });

  it('a supplier with no rule (404) has no default: a line with no CC shows a dash, not "unknown"', async () => {
    serve(
      on('GET', '/supplier-rules/s2', () => new Response('', { status: 404 })),
      on('GET', 'detail=dimensions', () => ok({ items: [] })),
    );
    render(<SupplierInvoiceNew />);
    fireEvent.click(screen.getByRole('button', { name: 'pick supplier 2' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dimensions' }));
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: —'));
  });

  const LADDER = { items: [{ id: 'f1', code: 'FT', name: 'Fibertime', ccType: 'cc1', isActive: true, fnoCode: 'FT' }] };
  it.each([
    ['still loading', () => new Promise<Response>(() => undefined)],
    ['failed', () => new Response('', { status: 500 })],
  ] as const)('switching supplier: while the new rule is %s the line says unknown, not the previous supplier CC1', async (_, second) => {
    serve(
      on('GET', '/supplier-rules/s1', () => ok({ defaultCc1Id: 'f1', defaultCc2Id: null, defaultBuId: null })),
      on('GET', '/supplier-rules/s2', second),
      on('GET', 'detail=dimensions', () => ok(LADDER)),
    );
    render(<SupplierInvoiceNew />);
    fireEvent.click(screen.getByRole('button', { name: 'pick supplier' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dimensions' }));
    await waitFor(() => expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: FT Fibertime'));
    fireEvent.click(screen.getByRole('button', { name: 'pick supplier 2' }));
    expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: unknown, applied on save');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId('line-cc1').textContent).toBe('CC1: unknown, applied on save');
  });
});
