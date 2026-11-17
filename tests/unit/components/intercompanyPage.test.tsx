// Settings > Intercompany connections page: load, create, edit through the cards, refresh without unmounting, stale answers.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyConnectionsPage from '../../../pages/accounting/settings/intercompany';
import { CANDIDATE, OPTIONS, connection, envelope, failure } from './intercompanyFixtures';

type Route = { connections?: () => Response | Promise<Response>; candidates?: () => Response; options?: () => Response; other?: (url: string, init?: RequestInit) => Response | Promise<Response> };
function serve(r: Route) {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (u === '/api/accounting/intercompany/connections' && (!i || !i.method)) return r.connections?.() ?? envelope({ items: [], count: 0 });
    if (u.endsWith('/group-candidates')) return r.candidates?.() ?? envelope({ items: [], count: 0 });
    if (u.endsWith('/side-options')) return r.options?.() ?? envelope(OPTIONS);
    return r.other?.(u, i) ?? envelope({});
  });
}
const calls = (match: string) => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes(match));

beforeEach(() => { h.role = 'owner'; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('IntercompanyConnectionsPage', () => {
  it('loads the connections, the group candidates and the pick-lists, and shows each connection as a card', async () => {
    serve({ connections: () => envelope({ items: [connection(), connection({ id: 'conn-2', partnerName: 'Brighttech' })], count: 2 }), candidates: () => envelope({ items: [CANDIDATE], count: 1 }) });
    render(<IntercompanyConnectionsPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect((await screen.findAllByTestId('connection-card'))).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Intercompany connections' })).toBeInTheDocument();
    expect(screen.getByLabelText('Company')).toBeInTheDocument();
    expect(calls('/side-options')).toHaveLength(1);
  });

  it('says so when there are no connections, and shows no create panel to a viewer', async () => {
    h.role = 'viewer';
    serve({});
    render(<IntercompanyConnectionsPage />);
    expect(await screen.findByTestId('no-connections')).toBeInTheDocument();
    expect(screen.queryByText('Connect a group company')).toBeNull();
  });

  it('a viewer sees the cards but no action buttons', async () => {
    h.role = 'viewer';
    serve({ connections: () => envelope({ items: [connection({ canEditSettings: false })], count: 1 }) });
    render(<IntercompanyConnectionsPage />);
    await screen.findByTestId('connection-card');
    expect(screen.queryByRole('button', { name: 'My settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('shows a failed load as an alert with Try again, and Try again loads it (error path)', async () => {
    let n = 0;
    serve({ connections: () => (++n === 1 ? failure('The server is busy.', 503) : envelope({ items: [connection()], count: 1 })) });
    render(<IntercompanyConnectionsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server is busy.');
    expect(screen.queryByTestId('no-connections')).toBeNull();
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Try again' })); });
    await screen.findByTestId('connection-card');
    expect(screen.queryByText('The server is busy.')).toBeNull();
  });

  it('creating a connection posts the partner and then reloads the list', async () => {
    let created = false;
    serve({
      connections: () => envelope({ items: created ? [connection({ id: 'new' })] : [], count: created ? 1 : 0 }),
      candidates: () => envelope({ items: created ? [] : [CANDIDATE], count: 1 }),
      other: (_u, i) => { if (i?.method === 'POST') { created = true; return envelope(connection({ id: 'new' }), 201); } return envelope({}); },
    });
    render(<IntercompanyConnectionsPage />);
    fireEvent.change(await screen.findByLabelText('Company'), { target: { value: 'co-b' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    expect(await screen.findByTestId('connection-card')).toBeInTheDocument();
    expect(await screen.findByTestId('no-candidates')).toBeInTheDocument();
    expect(await screen.findByText('Connection created. Set up your side below.')).toBeInTheDocument();
  });

  it('saving a card replaces it, and revoking it shows the revoked state', async () => {
    let state = connection();
    serve({
      connections: () => envelope({ items: [state], count: 1 }),
      other: (u, i) => {
        if (i?.method === 'DELETE') { state = connection({ status: 'revoked' }); return envelope(state); }
        if (u.endsWith('/settings')) { state = connection({ settings: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: null } }); return envelope(state); }
        return envelope({});
      },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<IntercompanyConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection settings' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' })); });
    await waitFor(() => expect(screen.getByTestId('pair-summary')).toHaveTextContent('through an intercompany loan'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Revoke' })); });
    await waitFor(() => expect(screen.getByTestId('connection-status')).toHaveTextContent('revoked'));
  });

  it('a refresh keeps the cards mounted (an open form keeps what was typed) and shows a small busy state', async () => {
    let release: (r: Response) => void = () => undefined;
    let n = 0;
    serve({
      connections: () => (++n === 1 ? envelope({ items: [connection()], count: 1 }) : (new Promise<Response>((res) => { release = res; }) as unknown as Response)),
      other: () => envelope(connection({ settings: { settlementMode: 'cash', cutoverDate: null, interestRatePct: 3 } })),
    });
    render(<IntercompanyConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'My settings' }));
    const card = screen.getByTestId('connection-card');
    fireEvent.change(screen.getByLabelText(/Customer that is/), { target: { value: 'cust-2' } });
    // a save elsewhere triggers the refresh: use the card's own save, whose reply starts the reload
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    expect(await screen.findByText('Refreshing…')).toBeInTheDocument();
    expect(screen.getByTestId('connection-card')).toBe(card); // the same DOM node: not unmounted
    await act(async () => { release(envelope({ items: [connection()], count: 1 })); });
    await waitFor(() => expect(screen.queryByText('Refreshing…')).toBeNull());
    expect(screen.getByTestId('connection-card')).toBe(card);
  });

  it('a failed refresh keeps the rows on screen and says so', async () => {
    let n = 0;
    serve({
      connections: () => (++n === 1 ? envelope({ items: [connection()], count: 1 }) : failure('The server is busy.', 503)),
      other: () => envelope(connection()),
    });
    render(<IntercompanyConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'My settings' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    expect(await screen.findByText('The server is busy.')).toBeInTheDocument();
    expect(screen.getByTestId('connection-card')).toBeInTheDocument();
  });

  it('an older answer that arrives after a newer one is ignored (request id)', async () => {
    const pending: Array<(r: Response) => void> = [];
    let n = 0;
    serve({
      connections: () => (++n === 1 ? envelope({ items: [connection()], count: 1 }) : (new Promise<Response>((res) => { pending.push(res); }) as unknown as Response)),
      other: () => envelope(connection()),
    });
    render(<IntercompanyConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'My settings' }));
    // two saves, so two reloads are in flight; the second (newer) answers first
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save my settings' })); });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]!(envelope({ items: [connection({ partnerName: 'Newest' })], count: 1 })); });
    await waitFor(() => expect(screen.getByText('Newest')).toBeInTheDocument());
    await act(async () => { pending[0]!(envelope({ items: [connection({ partnerName: 'Stale' })], count: 1 })); });
    expect(screen.queryByText('Stale')).toBeNull();
    expect(screen.getByText('Newest')).toBeInTheDocument();
  });
});
