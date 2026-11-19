// Intercompany P3 (pairing) screen: states, suggestions with a review step, exceptions, pairings, loan difference.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string, query: {} as Record<string, string> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import PairingPage from '../../../pages/accounting/settings/intercompany/pairing';
import type { PairingCandidate, PairingDoc, PairingView } from '@/modules/accounting/services/intercompany/pairingTypes';
import { connection, envelope, failure } from './intercompanyFixtures';

const doc = (id: string, number: string, total: number, over: Partial<PairingDoc> = {}): PairingDoc => ({ id, number, date: '2026-08-15', total, open: total, currency: 'ZAR', ...over });
const pair = (n: number, over: Partial<PairingCandidate> = {}): PairingCandidate => ({
  mine: doc(`m${n}`, `INV-${n}`, 1000 + n), theirs: doc(`t${n}`, `INV-${n}`, 1000 + n), ambiguous: false, openDiffers: false, ...over,
});
const EMPTY = { suggestions: [], mismatches: [], unmatchedMine: [], unmatchedTheirs: [], unsupported: [] };
const VIEW = (over: Partial<PairingView> = {}): PairingView => ({
  connectionId: 'conn-1', partnerName: 'Velocity Fibre', direction: 'ar', cutoverDate: '2026-10-01', blocked: null, confirmsBoth: false,
  matches: EMPTY, truncated: false, links: [], loan: null, ...over,
});

let view: (direction: string) => Response;
let posts: unknown[];
function serve() {
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    const u = String(url);
    const i = init as RequestInit | undefined;
    if (u === '/api/accounting/intercompany/connections') return envelope({ items: [connection({ settings: { settlementMode: 'cash', cutoverDate: '2026-10-01', interestRatePct: null } })], count: 1 });
    if (u.includes('/pairing/links/')) return envelope({ status: i?.method === 'PUT' ? 'active' : 'unlinked' });
    if (u.includes('/pairing') && i?.method === 'POST') { posts.push(JSON.parse(String(i.body))); return envelope({ created: 2, active: 0 }, 201); }
    if (u.includes('/pairing')) return view(new URL(u, 'http://x').searchParams.get('direction') ?? '');
    return envelope({});
  });
}
beforeEach(() => { h.role = 'owner'; h.query = {}; posts = []; vi.mocked(apiFetch).mockReset(); view = () => envelope(VIEW()); serve(); });
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

  it('opens on the connection named in the address', async () => {
    h.query = { connection: 'conn-1' };
    render(<PairingPage />);
    expect(await screen.findByTestId('pairing-view')).toBeInTheDocument();
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('/connections/conn-1/pairing'))).toBe(true);
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

  it('shows the loan balances as Dr / Cr with the difference, and says when the partner has not set a loan account', async () => {
    view = () => envelope(VIEW({ loan: { mine: 5000, theirs: -4800, difference: 200, asAt: '2026-09-30' } }));
    render(<PairingPage />);
    const card = await screen.findByTestId('loan-difference');
    expect(screen.getByTestId('loan-mine')).toHaveTextContent('R 5 000.00 Dr');
    expect(screen.getByTestId('loan-theirs')).toHaveTextContent('R 4 800.00 Cr');
    expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'differs');
    expect(card).toHaveTextContent('30 Sep 2026');
    view = () => envelope(VIEW({ loan: { mine: 0, theirs: 0, difference: 0, asAt: '2026-09-30' } }));
    fireEvent.click(screen.getByRole('tab', { name: /Owed by you/ }));
    await waitFor(() => expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'agrees'));
    view = () => envelope(VIEW({ loan: { mine: 100, theirs: null, difference: null, asAt: '2026-09-30' } }));
    fireEvent.click(screen.getByRole('tab', { name: /Owed to you/ }));
    await waitFor(() => expect(screen.getByTestId('loan-difference-value')).toHaveAttribute('data-state', 'unknown'));
    expect(screen.getByTestId('loan-difference')).toHaveTextContent(/has not set a loan account/);
  });
});
