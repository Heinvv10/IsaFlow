// Intercompany P3 (pairing) screen: states, suggestions with a review step, exceptions, pairings, loan difference.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string, query: {} as Record<string, string>, ready: true }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, isReady: h.ready }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import PairingPage from '../../../pages/accounting/settings/intercompany/pairing';
import { connection, envelope, failure } from './intercompanyFixtures';
import { EMPTY, VIEW, doc, pair } from './intercompanyPairingFixtures';

let view: (direction: string) => Response;
let connectionsReply: () => Response = () => envelope({ items: [connection({ settings: { settlementMode: 'cash', cutoverDate: '2026-10-01', interestRatePct: null } })], count: 1 });
let posts: unknown[];
function serve() {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (u === '/api/accounting/intercompany/connections') return connectionsReply();
    if (u.includes('/pairing/links/')) return envelope({ status: i?.method === 'PUT' ? 'active' : 'unlinked' });
    if (u.includes('/pairing') && i?.method === 'POST') { posts.push(JSON.parse(String(i.body))); return envelope({ created: 2, active: 0 }, 201); }
    if (u.includes('/pairing')) return view(new URL(u, 'http://x').searchParams.get('direction') ?? '');
    return envelope({});
  });
}
beforeEach(() => { h.role = 'owner'; h.query = {}; h.ready = true; posts = []; vi.mocked(apiFetch).mockReset(); view = () => envelope(VIEW()); connectionsReply = () => envelope({ items: [connection({ settings: { settlementMode: 'cash', cutoverDate: '2026-10-01', interestRatePct: null } })], count: 1 }); serve(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the page', () => {
  it('says so, with a way forward, when there is no active connection', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ items: [], count: 0 }));
    render(<PairingPage />);
    expect(await screen.findByTestId('no-live-connections')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a connection' })).toHaveAttribute('href', '/accounting/settings/intercompany');
  });

  it('loads the first connection\'s "owed to you" side, shows the cut-over date, and switches direction with the tabs', async () => {
    render(<PairingPage />);
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
    expect(screen.getByTestId('cutover')).toHaveTextContent('01 Oct 2026');
    expect(screen.getByRole('tab', { name: /Owed to you/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Owed by you/ }));
    await waitFor(() => expect(screen.getByRole('tab', { name: /Owed by you/ })).toHaveAttribute('aria-selected', 'true'));
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).endsWith('/pairing?direction=ap'))).toBe(true);
  });

  const TWO = () => envelope({ items: [connection({ id: 'conn-1', partnerName: 'First Co' }), connection({ id: 'conn-2', partnerName: 'Second Co' })], count: 2 });
  const pairingCalls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/pairing?'));

  it('opens on the connection named in the address, and waits for the router: a static page has an empty query on its first render', async () => {
    connectionsReply = TWO;
    h.ready = false;
    h.query = {};
    const { rerender } = render(<PairingPage />);
    await act(async () => { await Promise.resolve(); });
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
    h.ready = true;
    h.query = { connection: 'conn-2' };
    rerender(<PairingPage />);
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
    expect(pairingCalls().every((u) => u.includes('/connections/conn-2/pairing'))).toBe(true);
    expect(pairingCalls().length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Connection')).toHaveValue('conn-2');
  });

  it('falls back to the first live connection when the address names none that is live', async () => {
    connectionsReply = TWO;
    h.query = { connection: 'nope' };
    render(<PairingPage />);
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
    expect(screen.getByLabelText('Connection')).toHaveValue('conn-1');
  });

  it('a failed connections list shows Try again, and it fetches the list again (and keeps the address\'s choice)', async () => {
    connectionsReply = () => failure('Down', 500);
    h.query = { connection: 'conn-2' };
    render(<PairingPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Down');
    connectionsReply = TWO;
    await act(async () => { fireEvent.click(within(alert).getByRole('button', { name: 'Try again' })); });
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
    expect(screen.getByLabelText('Connection')).toHaveValue('conn-2');
    expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u) === '/api/accounting/intercompany/connections')).toHaveLength(2);
  });


  it.each([
    ['no_cutover', /cut-over date first/], ['no_party', /Link the customer/], ['revoked', /is revoked/], ['no_write_access', /owner, admin or manager/],
  ] as const)('a blocked screen (%s) tells the person what to do and offers no suggestions', async (blocked, text) => {
    view = () => envelope(VIEW({ blocked }));
    render(<PairingPage />);
    expect(await screen.findByTestId('blocked')).toHaveTextContent(text);
    expect(screen.queryByTestId('suggestions')).toBeNull();
  });

  it('has an empty state that names the likely cause, and a success state once everything is paired', async () => {
    render(<PairingPage />);
    expect(await screen.findByTestId('all-paired')).toHaveTextContent(/No open documents dated before the cut-over/);
    view = () => envelope(VIEW({ links: [{ id: 'l1', status: 'active', awaiting: null, conflict: false, mine: doc('m1', 'INV-1', 10), theirs: doc('t1', 'INV-1', 10), createdAt: '' }] }));
    fireEvent.click(screen.getByRole('tab', { name: /Owed by you/ }));
    expect(await screen.findByText('Every open document dated before the cut-over is paired.')).toBeInTheDocument();
  });

  it('a failed load shows the message and a retry, and the retry reloads', async () => {
    view = () => failure('Boom', 500);
    render(<PairingPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Boom');
    view = () => envelope(VIEW());
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
  });
});

describe('suggestions: select, review, confirm', () => {
  const suggestions = () => [pair(1), pair(2), pair(3, { ambiguous: true }), pair(4, { openDiffers: true })];

  it('selects nothing by itself; "Select all unflagged" skips a repeated number and a pair whose open amounts differ; the review step shows the count and total before anything is sent', async () => {
    view = () => envelope(VIEW({ matches: { ...EMPTY, suggestions: suggestions() } }));
    render(<PairingPage />);
    const table = await screen.findByRole('table', { name: /Suggested pairs/ });
    expect(within(table).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Review 0 selected' })).toBeDisabled();
    expect(screen.getByText('Repeated number')).toBeInTheDocument();
    expect(screen.getByText('Open amounts differ')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select all unflagged' }));
    expect(screen.getByRole('button', { name: 'Review 2 selected' })).toBeEnabled();
    expect(screen.getByLabelText('Pair INV-3 with INV-3')).not.toBeChecked();
    expect(screen.getByLabelText('Pair INV-4 with INV-4')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Pair INV-3 with INV-3'));
    fireEvent.click(screen.getByLabelText('Pair INV-4 with INV-4'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 4 selected' }));

    const review = screen.getByTestId('review');
    expect(within(review).getByRole('heading')).toHaveTextContent('Confirm 4 pairings worth R 4 010.00');
    expect(review).toHaveTextContent('Velocity Fibre will see each pairing and has to confirm it');
    expect(review).toHaveTextContent('No journal is posted');
    expect(posts).toEqual([]);

    fireEvent.click(within(review).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Review 4 selected' })).toBeInTheDocument();
  });

  it('confirming POSTs exactly the chosen pairs, says who confirms next, and reloads', async () => {
    view = () => envelope(VIEW({ matches: { ...EMPTY, suggestions: suggestions() } }));
    render(<PairingPage />);
    await screen.findByTestId('suggestions');
    fireEvent.click(screen.getByLabelText('Pair INV-1 with INV-1'));
    fireEvent.click(screen.getByLabelText('Pair INV-2 with INV-2'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected' }));
    const loads = vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('direction=')).length;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' })); });
    await waitFor(() => expect(posts).toEqual([{ direction: 'ar', pairs: [{ mineId: 'm1', theirsId: 't1' }, { mineId: 'm2', theirsId: 't2' }] }]));
    expect(await screen.findByText(/2 pairings recorded\. Velocity Fibre is asked to confirm\./)).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('direction=')).length).toBeGreaterThan(loads));
  });

  it('after a confirmation, while the reload is in flight, the old rows cannot be ticked or confirmed', async () => {
    view = () => envelope(VIEW({ matches: { ...EMPTY, suggestions: [pair(1), pair(2)] } }));
    render(<PairingPage />);
    await screen.findByTestId('suggestions');
    fireEvent.click(screen.getByLabelText('Pair INV-1 with INV-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected' }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (String(url).includes('direction=')) await gate;
      return original(url as never, init as never);
    });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' })); });
    await waitFor(() => expect(screen.getByLabelText('Pair INV-2 with INV-2')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Select all unflagged' })).toBeDisabled();
    expect(screen.getByLabelText('Select all pairs that are not flagged')).toBeDisabled();
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByLabelText('Pair INV-2 with INV-2')).toBeEnabled());
  });

  it('a reload that drops every chosen pair (here: after an unlink, with the review open) closes the review instead of offering an empty confirmation', async () => {
    const link = { id: 'l9', status: 'active' as const, awaiting: null, conflict: false, mine: doc('m9', 'INV-9', 10), theirs: doc('t9', 'INV-9', 10), createdAt: '' };
    view = () => envelope(VIEW({ links: [link], matches: { ...EMPTY, suggestions: [pair(1)] } }));
    render(<PairingPage />);
    await screen.findByTestId('suggestions');
    fireEvent.click(screen.getByLabelText('Pair INV-1 with INV-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected' }));
    expect(screen.getByRole('button', { name: 'Confirm pairing' })).toBeEnabled();
    view = () => envelope(VIEW({ links: [], matches: { ...EMPTY, suggestions: [pair(2)] } }));
    fireEvent.click(screen.getByRole('button', { name: /Unlink the pairing of INV-9/ }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove pairing' })); });
    await waitFor(() => expect(screen.getByLabelText('Pair INV-2 with INV-2')).toBeInTheDocument());
    expect(screen.queryByTestId('review')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm pairing' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Review 0 selected' })).toBeDisabled();
  });

  it('tells a user who can write in both companies that both sides are confirmed at once', async () => {
    view = () => envelope(VIEW({ confirmsBoth: true, matches: { ...EMPTY, suggestions: [pair(1)] } }));
    render(<PairingPage />);
    await screen.findByTestId('suggestions');
    fireEvent.click(screen.getByLabelText('Pair INV-1 with INV-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected' }));
    expect(screen.getByTestId('review')).toHaveTextContent('You can write in both companies');
  });

  it('a refusal (a document paired elsewhere meanwhile) is shown, and the review stays open so nothing is lost', async () => {
    view = () => envelope(VIEW({ matches: { ...EMPTY, suggestions: [pair(1)] } }));
    render(<PairingPage />);
    await screen.findByTestId('suggestions');
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if (String(url).includes('/pairing') && (init as RequestInit | undefined)?.method === 'POST') return failure('One of these documents is no longer available to pair.', 409);
      return envelope(VIEW({ matches: { ...EMPTY, suggestions: [pair(1)] } }));
    });
    fireEvent.click(screen.getByLabelText('Pair INV-1 with INV-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing' })); });
    expect(await screen.findByText(/no longer available to pair/)).toBeInTheDocument();
    expect(screen.getByTestId('review')).toBeInTheDocument();
  });
});

describe('exceptions, pairings and loan balances', () => {
  it('lists mismatches (with the difference), documents on one side only, and foreign-currency documents', async () => {
    view = () => envelope(VIEW({ matches: {
      suggestions: [],
      mismatches: [{ mine: doc('m1', 'INV-1', 1000), theirs: doc('t1', 'INV-1', 1100), ambiguous: false, openDiffers: true }],
      unmatchedMine: [doc('m2', 'INV-2', 500)], unmatchedTheirs: [doc('t3', 'INV-3', 700)],
      unsupported: [doc('m4', 'INV-4', 90, { currency: 'USD' })],
    } }));
    render(<PairingPage />);
    expect(await screen.findByTestId('mismatches')).toHaveTextContent('R 100.00');
    expect(screen.getByTestId('unmatched-mine')).toHaveTextContent('INV-2');
    expect(screen.getByTestId('unmatched-theirs')).toHaveTextContent('INV-3');
    expect(screen.getByTestId('unsupported')).toHaveTextContent('USD 90.00');
    expect(screen.getByRole('heading', { name: 'Exceptions (4)' })).toBeInTheDocument();
  });

  it('a proposal waiting for this company can be confirmed; a conflicting one only declined; unlinking asks first', async () => {
    view = () => envelope(VIEW({ links: [
      { id: 'l1', status: 'pending_confirmation', awaiting: 'me', conflict: false, mine: doc('m1', 'INV-1', 10), theirs: doc('t1', 'INV-1', 10), createdAt: '' },
      { id: 'l2', status: 'pending_confirmation', awaiting: 'me', conflict: true, mine: doc('m2', 'INV-2', 10), theirs: null, createdAt: '' },
      { id: 'l3', status: 'active', awaiting: null, conflict: false, mine: doc('m3', 'INV-3', 10), theirs: doc('t3', 'INV-3', 10), createdAt: '' },
    ] }));
    render(<PairingPage />);
    const rows = await screen.findAllByTestId('pairing-row');
    expect(screen.getByRole('status')).toHaveTextContent('2 pairings are waiting for you');
    expect(within(rows[0]!).getByRole('button', { name: /Confirm the pairing of INV-1/ })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole('button', { name: /Confirm/ })).toBeNull();
    expect(rows[1]).toHaveTextContent('Cannot be confirmed');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /Confirm the pairing/ }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u, i]) => String(u).endsWith('/pairing/links/l1') && (i as RequestInit).method === 'PUT')).toBe(true));
    fireEvent.click(within(rows[2]!).getByRole('button', { name: /Unlink the pairing of INV-3/ }));
    expect(screen.getByText('Remove this pairing?')).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove pairing' })); });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u, i]) => String(u).endsWith('/pairing/links/l3') && (i as RequestInit).method === 'DELETE')).toBe(true));
  });

  it('a viewer sees the pairings but no buttons', async () => {
    h.role = 'viewer';
    view = () => envelope(VIEW({ blocked: 'no_write_access', links: [{ id: 'l3', status: 'active', awaiting: null, conflict: false, mine: doc('m3', 'INV-3', 10), theirs: null, createdAt: '' }] }));
    render(<PairingPage />);
    const row = await screen.findByTestId('pairing-row');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it.each([
    ['revoked', /connection is revoked/], ['no_write_access', /owner, admin or manager role/], ['no_cutover', /cut-over date is set/], ['no_party', /customer or supplier is linked/],
  ] as const)('while blocked (%s) a pairing\'s missing partner document says why, not that it is closed', async (blocked, text) => {
    view = () => envelope(VIEW({ blocked, links: [{ id: 'l3', status: 'active', awaiting: null, conflict: false, mine: doc('m3', 'INV-3', 10), theirs: null, createdAt: '' }] }));
    render(<PairingPage />);
    const row = await screen.findByTestId('pairing-row');
    expect(row).toHaveTextContent(text);
    expect(row).not.toHaveTextContent('Not open any more');
  });

  it('shows the loan card on the page, from the view', async () => {
    view = () => envelope(VIEW({ loan: { mine: 5000, theirs: -4800, difference: 200, asAt: '2026-09-30' } }));
    render(<PairingPage />);
    expect(await screen.findByTestId('loan-difference')).toHaveTextContent('30 Sep 2026');
  });
});
