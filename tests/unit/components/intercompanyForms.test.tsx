// Intercompany P1 components: the side form, the pair-settings form, the connection card and the new-connection panel.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import { ConnectionCard } from '@/components/accounting/intercompany/ConnectionCard';
import { NewConnectionPanel } from '@/components/accounting/intercompany/NewConnectionPanel';
import { PairSettingsForm } from '@/components/accounting/intercompany/PairSettingsForm';
import { SideForm } from '@/components/accounting/intercompany/SideForm';
import { CANDIDATE, OPTIONS, connection, envelope, failure } from './intercompanyFixtures';

const fetchMock = () => vi.mocked(apiFetch);
const lastCall = () => {
  const [url, init] = fetchMock().mock.calls.at(-1) as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
};

beforeEach(() => { fetchMock().mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('SideForm', () => {
  it('sends only this company\'s own side (customer, supplier, loan, expense, auto-accept) as a PUT to the connection', async () => {
    const saved = connection({ side: { customerId: 'cust-1', supplierId: 'supp-1', loanAccountId: null, defaultExpenseAccountId: 'acc-2', autoAccept: true, customer: null, supplier: null, loanAccount: null, defaultExpenseAccount: null } });
    fetchMock().mockResolvedValue(envelope(saved));
    const onSaved = vi.fn();
    render(<SideForm connection={connection()} options={OPTIONS} onSaved={onSaved} onError={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Customer that is Velocity Fibre/), { target: { value: 'cust-1' } });
    fireEvent.change(screen.getByLabelText(/Supplier that is Velocity Fibre/), { target: { value: 'supp-1' } });
    fireEvent.change(screen.getByLabelText(/Default expense account/), { target: { value: 'acc-2' } });
    fireEvent.click(screen.getByLabelText(/Accept invoices from Velocity Fibre automatically/));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(lastCall()).toEqual({
      url: '/api/accounting/intercompany/connections/conn-1', method: 'PUT',
      body: { customerId: 'cust-1', supplierId: 'supp-1', loanAccountId: null, defaultExpenseAccountId: 'acc-2', autoAccept: true },
    });
  });

  it('shows the loan account only while the pair settles through a loan, and never a settlement or cut-over field', () => {
    const { rerender } = render(<SideForm connection={connection()} options={OPTIONS} onSaved={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByLabelText('Intercompany loan account')).toBeNull();
    expect(screen.queryByLabelText('Settlement')).toBeNull();
    expect(screen.queryByLabelText(/Cut-over/)).toBeNull();
    rerender(<SideForm connection={connection({ settings: { settlementMode: 'loan', cutoverDate: null, interestRatePct: null } })} options={OPTIONS} onSaved={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByLabelText('Intercompany loan account')).toBeInTheDocument();
  });

  it('offers auto-accept on a group connection only, and does not send it for an external one', async () => {
    fetchMock().mockResolvedValue(envelope(connection()));
    render(<SideForm connection={connection({ kind: 'external' })} options={OPTIONS} onSaved={vi.fn()} onError={vi.fn()} />);
    expect(screen.queryByLabelText(/Accept invoices from/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    expect(lastCall().body).not.toHaveProperty('autoAccept');
  });

  it('says the server\'s refusal in plain words and stays usable (error path), then a fallback sentence for a bare 500', async () => {
    fetchMock().mockResolvedValueOnce(failure('That customer is already linked to another intercompany connection.', 409));
    const onError = vi.fn();
    render(<SideForm connection={connection()} options={OPTIONS} onSaved={vi.fn()} onError={onError} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('That customer is already linked to another intercompany connection.'));
    expect(screen.getByRole('button', { name: 'Save my settings' })).toBeEnabled();
    fetchMock().mockResolvedValueOnce(new Response('', { status: 500 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Could not save these settings - try again'));
  });
});

describe('PairSettingsForm', () => {
  const type = (label: string | RegExp, text: string) => {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
  };

  it('PUTs mode, cut-over and interest to the settings route', async () => {
    const saved = connection({ settings: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 } });
    fetchMock().mockResolvedValue(envelope(saved));
    const onSaved = vi.fn();
    render(<PairSettingsForm connection={connection()} onSaved={onSaved} onError={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Settlement'), { target: { value: 'loan' } });
    type(/Cut-over date/, '2026-12-01');
    type(/Interest/, '10,5');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' })); });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(lastCall()).toEqual({
      url: '/api/accounting/intercompany/connections/conn-1/settings', method: 'PUT',
      body: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 },
    });
  });

  it('an empty interest is "none" (null); a stored value starts in the field', async () => {
    fetchMock().mockResolvedValue(envelope(connection()));
    render(<PairSettingsForm connection={connection({ settings: { settlementMode: 'cash', cutoverDate: '2026-12-01', interestRatePct: 7 } })} onSaved={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByLabelText(/Interest/)).toHaveValue('7');
    type(/Interest/, '');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' })); });
    expect(lastCall().body).toEqual({ settlementMode: 'cash', cutoverDate: '2026-12-01', interestRatePct: null });
  });

  it.each(['abc', '100.5', '-1', '1e3'])('interest %s blocks the save with a message, and nothing is sent', async (text) => {
    render(<PairSettingsForm connection={connection()} onSaved={vi.fn()} onError={vi.fn()} />);
    type(/Interest/, text);
    expect(screen.getByRole('button', { name: 'Save connection settings' })).toBeDisabled();
    expect(screen.getByText('A number from 0 to 100')).toBeInTheDocument();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('an unreadable cut-over date blocks the save', () => {
    render(<PairSettingsForm connection={connection()} onSaved={vi.fn()} onError={vi.fn()} />);
    type(/Cut-over date/, 'not a date');
    expect(screen.getByRole('button', { name: 'Save connection settings' })).toBeDisabled();
  });

  it('reports the server\'s refusal (a viewer in one company, a revoked connection) and a fallback for a bare failure', async () => {
    const onError = vi.fn();
    fetchMock().mockResolvedValueOnce(failure('Changing the connection\'s settings needs an owner, admin or manager role in both companies.', 403));
    render(<PairSettingsForm connection={connection()} onSaved={vi.fn()} onError={onError} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' })); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Changing the connection\'s settings needs an owner, admin or manager role in both companies.'));
    fetchMock().mockRejectedValueOnce(new TypeError('network'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' })); });
    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Could not save the connection settings - try again'));
  });
});

describe('ConnectionCard', () => {
  const props = (over: Partial<Parameters<typeof ConnectionCard>[0]> = {}) => ({
    connection: connection(), options: OPTIONS, canEdit: true, onChanged: vi.fn(), onNotice: vi.fn(), ...over,
  });

  it('shows the partner, kind, status, the pair summary and the checklist badges', () => {
    render(<ConnectionCard {...props({ connection: connection({ settings: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10 } }) })} />);
    const card = screen.getByTestId('connection-card');
    expect(within(card).getByText('Velocity Fibre')).toBeInTheDocument();
    expect(within(card).getByText('Group company')).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('active');
    expect(screen.getByTestId('pair-summary')).toHaveTextContent(/through an intercompany loan.*Cut-over: 01 Dec 2026.*10% a year/);
    expect(screen.getByTestId('check-customer')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('check-loanAccount')).toHaveAttribute('data-state', 'optional');
  });

  it('offers "Connection settings" only to a user who can write in both companies, and "My settings" to a writer of this one', () => {
    const { rerender } = render(<ConnectionCard {...props()} />);
    expect(screen.getByRole('button', { name: 'Connection settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My settings' })).toBeInTheDocument();
    rerender(<ConnectionCard {...props({ connection: connection({ canEditSettings: false }) })} />);
    expect(screen.queryByRole('button', { name: 'Connection settings' })).toBeNull();
    rerender(<ConnectionCard {...props({ canEdit: false })} />);
    expect(screen.queryByRole('button', { name: 'My settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('an open panel goes away when a refresh shows the user can no longer use it', () => {
    const { rerender } = render(<ConnectionCard {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }));
    expect(screen.getByRole('form', { name: 'Connection settings' })).toBeInTheDocument();
    rerender(<ConnectionCard {...props({ connection: connection({ canEditSettings: false }) })} />);
    expect(screen.queryByRole('form', { name: 'Connection settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'My settings' }));
    expect(screen.getByRole('button', { name: 'Save my settings' })).toBeInTheDocument();
    rerender(<ConnectionCard {...props({ canEdit: false })} />);
    expect(screen.queryByRole('button', { name: 'Save my settings' })).toBeNull();
  });

  it('opens one panel at a time and closes it again', () => {
    render(<ConnectionCard {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'My settings' }));
    expect(screen.getByRole('button', { name: 'Save my settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings' }));
    expect(screen.queryByRole('button', { name: 'Save my settings' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Connection settings' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(screen.queryByRole('form', { name: 'Connection settings' })).toBeNull();
  });

  it('revokes after confirmation: DELETE, the card is told, a notice says so', async () => {
    const revoked = connection({ status: 'revoked', revokedAt: '2026-11-17T12:00:00.000Z' });
    fetchMock().mockResolvedValue(envelope(revoked));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const p = props();
    render(<ConnectionCard {...p} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke' })); });
    await waitFor(() => expect(p.onChanged).toHaveBeenCalledWith(revoked));
    expect(lastCall()).toMatchObject({ url: '/api/accounting/intercompany/connections/conn-1', method: 'DELETE' });
    expect(p.onNotice).toHaveBeenCalledWith('Connection revoked', true);
  });

  it('does nothing when the confirmation is declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<ConnectionCard {...props()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke' })); });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('says why a revoke failed (error path)', async () => {
    fetchMock().mockResolvedValue(failure('This connection is already revoked.', 409));
    vi.stubGlobal('confirm', vi.fn(() => true));
    const p = props();
    render(<ConnectionCard {...p} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke' })); });
    await waitFor(() => expect(p.onNotice).toHaveBeenCalledWith('This connection is already revoked.', false));
    expect(p.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeEnabled();
  });

  it('a revoked connection shows its status and no actions, summary or checklist', () => {
    render(<ConnectionCard {...props({ connection: connection({ status: 'revoked' }) })} />);
    expect(screen.getByTestId('connection-status')).toHaveTextContent('revoked');
    expect(screen.queryByRole('button', { name: 'My settings' })).toBeNull();
    expect(screen.queryByTestId('pair-summary')).toBeNull();
    expect(screen.getByText(/This connection was revoked/)).toBeInTheDocument();
  });
});

describe('NewConnectionPanel', () => {
  it('offers only companies without a live connection, with a reconnect hint for a revoked one, and POSTs the chosen company', async () => {
    const created = connection({ id: 'new' });
    fetchMock().mockResolvedValue(envelope(created, 201));
    const onCreated = vi.fn();
    const onNotice = vi.fn();
    render(<NewConnectionPanel candidates={[
      CANDIDATE,
      { ...CANDIDATE, companyId: 'co-c', companyName: 'Active Co', connectionStatus: 'active' },
      { ...CANDIDATE, companyId: 'co-d', companyName: 'Revoked Co', connectionStatus: 'revoked' },
    ]} onCreated={onCreated} onNotice={onNotice} />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose a company', 'Velocity Fibre (Hein group)', 'Revoked Co (Hein group) - reconnect']);
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(lastCall()).toEqual({ url: '/api/accounting/intercompany/connections', method: 'POST', body: { partnerCompanyId: 'co-b' } });
    expect(onNotice).toHaveBeenCalledWith('Connection created. Set up your side below.', true);
  });

  it('says so when there is nobody to connect', () => {
    render(<NewConnectionPanel candidates={[{ ...CANDIDATE, connectionStatus: 'active' }]} onCreated={vi.fn()} onNotice={vi.fn()} />);
    expect(screen.getByTestId('no-candidates')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('reports a refusal in plain words (error path) and keeps the choice', async () => {
    fetchMock().mockResolvedValue(failure('Connecting two companies needs an owner, admin or manager role in both.', 403));
    const onNotice = vi.fn();
    render(<NewConnectionPanel candidates={[CANDIDATE]} onCreated={vi.fn()} onNotice={onNotice} />);
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Connecting two companies needs an owner, admin or manager role in both.', false));
    expect(screen.getByLabelText('Company')).toHaveValue('co-b');
  });

  it('a reply that is not a connection is reported, not shown', async () => {
    fetchMock().mockResolvedValue(envelope({ items: [], count: 0 }, 201));
    const onNotice = vi.fn();
    const onCreated = vi.fn();
    render(<NewConnectionPanel candidates={[CANDIDATE]} onCreated={onCreated} onNotice={onNotice} />);
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-b' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Could not create the connection - try again', false));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
