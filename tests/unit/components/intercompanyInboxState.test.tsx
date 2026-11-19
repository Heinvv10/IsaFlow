// Bills > Intercompany inbox, the state around the list: clicking the filter that is already active, the open count kept while the list
// switches, a message the auto-accept worker gave up on, and a source the sender changed after sending.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { detail, item, serve } from './intercompanyInboxFixtures';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const inboxCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('/inbox?'));

describe('the filter buttons', () => {
  it('clicking the filter that is already active keeps the list (it used to leave the skeleton up for good)', async () => {
    serve();
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
    expect(screen.getByTestId('inbox-row')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading intercompany messages')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting for you')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Needs you/ })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('switching to Handled and back loads each list, and the open count stays on the button and the tab while the other list loads', async () => {
    serve({ items: [item(), item({ id: 'm-2', status: 'accepted', number: 'INV-200' })] });
    render(<IntercompanyInboxPage />);
    await screen.findByTestId('inbox-row');
    expect(screen.getByRole('button', { name: 'Needs you (1)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    // synchronously, before the Handled list has answered: the count is still there (the page was cleared, the count is not part of it)
    expect(screen.getByRole('button', { name: 'Needs you (1)' })).toBeInTheDocument();
    expect(await screen.findByText('INV-200')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
    expect(await screen.findByText('INV-100')).toBeInTheDocument();
    expect(inboxCalls().map(([u]) => String(u).match(/filter=(\w+)/)![1])).toEqual(['open', 'handled', 'open']);
  });
});

describe('a message the worker gave up on, and a source the sender changed', () => {
  it('an open message that used every auto-accept attempt says it needs a person', async () => {
    serve({ items: [item({ autoExhausted: true }), item({ id: 'm-2', number: 'INV-200' })] });
    render(<IntercompanyInboxPage />);
    const rows = await screen.findAllByTestId('inbox-row');
    expect(within(rows[0]!).getByTestId('auto-exhausted')).toHaveTextContent('Couldn\'t be auto-accepted; review it.');
    expect(within(rows[1]!).queryByTestId('auto-exhausted')).not.toBeInTheDocument();
  });

  it('the review dialog warns when the sender changed the document after sending it, and not otherwise', async () => {
    serve({ detail: detail({ item: item({ sourceChanged: true }) }) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByTestId('source-changed')).toHaveTextContent('changed this document after sending it');
  });

  it('no warning for an unchanged source', async () => {
    serve();
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText('Draft goes on supplier');
    expect(screen.queryByTestId('source-changed')).not.toBeInTheDocument();
  });
});
