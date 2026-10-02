// The bank page's "create supplier / customer" modal posted to /api/suppliers and /api/clients, routes that
// do not exist (404). It must post to the routes the supplier/customer "new" pages use, read the real
// envelope, and show the server's message on a refusal.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { CreateEntityModal } from '@/components/accounting/CreateEntityModal';

useApiJsonOverMock();

const envelope = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const onCreated = vi.fn();
const onClose = vi.fn();

function type(placeholder: string, value: string) {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
}
function lastCall() {
  const [url, init] = vi.mocked(apiFetch).mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, method: init.method };
}

describe('CreateEntityModal create requests', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a supplier through /api/accounting/suppliers-list with a flat body', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(envelope(200, { success: true, data: { id: 'sup-1', name: 'Acme' } }));
    render(<CreateEntityModal type="supplier" onClose={onClose} onCreated={onCreated} />);
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[0]!, { target: { value: ' Acme ' } });
    fireEvent.change(screen.getByPlaceholderText(/@/), { target: { value: 'a@acme.co.za' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const { url, body, method } = lastCall();
    expect(url).toBe('/api/accounting/suppliers-list');
    expect(method).toBe('POST');
    expect(body).toEqual({ name: 'Acme', email: 'a@acme.co.za' });
    expect(onCreated).toHaveBeenCalledWith({ id: 'sup-1', code: undefined, name: 'Acme' });
  });

  it('creates a customer through /api/accounting/customers keyed by `name`', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(envelope(200, { success: true, data: { id: 'cus-1', name: 'Fibertime' } }));
    render(<CreateEntityModal type="customer" onClose={onClose} onCreated={onCreated} />);
    type('e.g. Fibertime', 'Fibertime');
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const { url, body } = lastCall();
    expect(url).toBe('/api/accounting/customers');
    expect(body).toEqual({ name: 'Fibertime' });
    expect(onCreated).toHaveBeenCalledWith({ id: 'cus-1', name: 'Fibertime' });
  });

  it('shows the server message when the create is refused', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(envelope(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Supplier name must not exceed 200 characters' } }));
    render(<CreateEntityModal type="supplier" onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Acme' } });
    fireEvent.change(screen.getByPlaceholderText(/@/), { target: { value: 'a@acme.co.za' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Supplier name must not exceed 200 characters'));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
