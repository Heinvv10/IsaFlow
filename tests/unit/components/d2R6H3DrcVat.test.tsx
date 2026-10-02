// D2 round 6 (h3): DRC VAT - a failed reload after a good Apply keeps the success note, shows the load error,
// leaves no spinner and no stale invoice with its Apply button; a failed first load clears the lists.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import DRCVatPage from '../../../pages/accounting/drc-vat/index';

useApiJsonOverMock();
const INV = { id: 'i-1', invoiceNumber: 'D2-INV-77', supplierName: 'D2 Supplier', totalAmount: 1000, vatAmount: 150, invoiceDate: '2026-01-01' };
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const empty500 = () => new Response('', { status: 500 });
const LOAD_ERR = 'Could not load DRC VAT data - try again';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('DRC VAT reload failures', () => {
  it('a failed reload after a good Apply: success kept, load error shown, no spinner, no stale Apply button', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'POST') return ok({ vatAmount: 150 });
      gets += 1;
      return gets <= 2 ? ok({ items: [INV] }) : empty500();
    });
    render(<DRCVatPage />);
    fireEvent.click(await screen.findByRole('button', { name: /apply drc/i }));
    expect(await screen.findByText(LOAD_ERR)).toBeTruthy();
    expect(screen.getByText(/DRC VAT applied/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
    expect(screen.queryByText('D2-INV-77')).toBeNull();
    expect(screen.queryByRole('button', { name: /apply drc/i })).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d/);
  });

  it('a failed first load: plain sentence, spinner gone, lists empty', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<DRCVatPage />);
    expect(await screen.findByText(LOAD_ERR)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
    expect(screen.getByText(/Eligible \(0\)/)).toBeTruthy();
  });

  it('a good load lists the invoice', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ items: [INV] }));
    render(<DRCVatPage />);
    expect(await screen.findByText('D2-INV-77')).toBeTruthy();
  });
});
