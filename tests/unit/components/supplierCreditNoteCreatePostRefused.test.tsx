/**
 * R-035 PR3 review B1: "Post Credit Note" on the new supplier credit note
 * form creates the draft and then posts it. When approval enforcement refuses
 * the post, the server KEEPS the draft and answers 409 naming it
 * (`error.details.creditNoteId`). The form must take the user to that draft —
 * where the approval panel offers Submit for approval — and never POST again:
 * each retry used to create one more draft.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn(async () => true);
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme Supplies')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import NewSupplierCreditNotePage from '../../../pages/accounting/supplier-credit-notes/new';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
const MESSAGE = 'Supplier credit note CN-0009 needs owner approval before it can be posted (rule: Owner signs).';
const refused = () => new Response(JSON.stringify({ success: false, error: {
  code: 'CONFLICT', message: MESSAGE,
  details: { reason: 'APPROVAL_REQUIRED', requiredRole: 'owner', requestId: null, creditNoteId: 'cn-9' },
} }), { status: 409 });

/** Click Post (it picks the action), then submit the form — jsdom does not submit on a button click. */
function post() {
  fireEvent.click(screen.getByRole('button', { name: /post credit note/i }));
  fireEvent.submit(document.querySelector('form')!);
}

function fillAndPost() {
  fireEvent.click(screen.getByText('pick-supplier'));
  fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Returned goods' } });
  fireEvent.change(screen.getAllByRole('spinbutton')[1]!, { target: { value: '100' } });
  post();
}

describe('new supplier credit note — create-and-post refused by approval', () => {
  beforeEach(() => { fetchMock.mockReset(); push.mockClear(); });

  it('goes to the kept draft, where Submit for approval is offered', async () => {
    fetchMock.mockResolvedValueOnce(refused());
    render(<NewSupplierCreditNotePage />);
    fillAndPost();
    await waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/supplier-credit-notes/cn-9'));
    expect(push).not.toHaveBeenCalledWith('/accounting/supplier-credit-notes');
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toMatchObject({ submitAction: 'post', supplierId: 'sup-1' });
  });

  it('a second Post does not create another draft', async () => {
    push.mockImplementation(async () => { throw new Error('navigation cancelled'); });
    fetchMock.mockResolvedValueOnce(refused());
    render(<NewSupplierCreditNotePage />);
    fillAndPost();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    // Navigation failed: the page says where the draft is, and posting again only retries the navigation.
    expect(await screen.findByText(/saved as a draft/i)).toBeDefined();
    post();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push).toHaveBeenLastCalledWith('/accounting/supplier-credit-notes/cn-9');
    expect(posts()).toHaveLength(1);
    push.mockImplementation(async () => true);
  });

  it('any other refusal is shown, as before', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'creditDate is required' } }), { status: 400 }));
    render(<NewSupplierCreditNotePage />);
    fillAndPost();
    expect(await screen.findByText('creditDate is required')).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });
});
