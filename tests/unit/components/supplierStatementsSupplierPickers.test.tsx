// The statements page's two supplier pickers read /api/accounting/suppliers, a route
// that does not exist, so they were always empty. They now use SupplierSelect
// (server-side search on /suppliers-list), so a supplier past the first 25 is reachable.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import SupplierStatementsIndexPage from '../../../pages/accounting/ap/supplier-statements/index';

const SUP = '00000000-0000-4000-8000-000000000026';
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
let posted: FormData | null = null;

beforeEach(() => {
  posted = null;
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/suppliers-list')) {
      return json({ suppliers: [{ id: SUP, name: 'Supplier 26' }], total: 1 });
    }
    if (u.startsWith('/api/accounting/supplier-statements')) return json([]);
    throw new Error(`unexpected apiFetch ${u}`);
  });
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
    posted = init?.body as FormData;
    return json({ id: 'rec-1' });
  }));
});

async function pick(input: HTMLElement) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'Supplier 26' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Supplier 26' }, { timeout: 2000 }));
}

describe('supplier statements page supplier pickers', () => {
  it('the filter finds a supplier by search and filters the list by its id', async () => {
    render(<SupplierStatementsIndexPage />);
    await pick(screen.getAllByRole('textbox', { name: 'Supplier' })[0]!);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(`/api/accounting/supplier-statements?supplierId=${SUP}`));
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls.some(u => /\/api\/accounting\/suppliers\?/.test(u))).toBe(false);
  });

  it('the upload modal uploads against the supplier picked by search', async () => {
    const { container } = render(<SupplierStatementsIndexPage />);
    fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
    const inputs = screen.getAllByRole('textbox', { name: 'Supplier' });
    await pick(inputs[inputs.length - 1]!);
    const file = new File(['%PDF'], 'stmt.pdf', { type: 'application/pdf' });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted!.get('supplierId')).toBe(SUP);
  });

  async function openModalAndPick(container: HTMLElement) {
    fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
    const inputs = screen.getAllByRole('textbox', { name: 'Supplier' });
    await pick(inputs[inputs.length - 1]!);
    return container;
  }

  it('reopening the modal after an upload does not carry the previous supplier', async () => {
    const { container } = render(<SupplierStatementsIndexPage />);
    await openModalAndPick(container);
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['%PDF'], 's.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(posted).not.toBeNull());
    await waitFor(() => expect(screen.queryByText('Upload Supplier Statement')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
    expect((container.querySelector('input[name="modalSupplier"]') as HTMLInputElement).value).toBe('');
  });

  it('cancelling the modal does not carry the supplier to the next open', async () => {
    const { container } = render(<SupplierStatementsIndexPage />);
    await openModalAndPick(container);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
    expect((container.querySelector('input[name="modalSupplier"]') as HTMLInputElement).value).toBe('');
  });
});
