// Settings > Intercompany > Loan reconciliation (P5, read only): a connection select and NO date field; the summary card says "as at <T>,
// read at <readAt>", both balances or "Withheld: <sentence>", the difference, the components with counts and the badge ("Reconciles",
// "Unexplained R x" with its four parts, or "Does not reconcile: n rows need attention"); with the partner withheld there is no badge and no
// difference. Three tabs with paginated tables (each page shows its own readAt), empty states, NO action buttons, and links to this
// company's own documents only (the partner's payload text is never a link). A refusal shows its sentence. Round 1: the four parts show
// whenever any is not 0, a failed read offers "Try again" and keeps the chosen connection, and a capped list says it was cut. Hand postings
// that cancel (mirrored openings) show "Reconciles" WITH a note naming both figures; residuals that cancel are "Does not reconcile".
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, isReady: true }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import ReconPage from '../../../pages/accounting/settings/intercompany/loan-reconciliation';
import type { ReconItem, ReconReport, ReconSummary } from '@/modules/accounting/services/intercompany/loanReconTypes';
import { envelope, failure } from './intercompanyFixtures';
import { formatCurrency } from '@/utils/formatters';

const summary = (over: Partial<ReconSummary> = {}): ReconSummary => ({
  partnerState: 'ok', own: { balance: -63700, attributed: -13700, other: -50000, loanShared: false }, partner: { balance: 60800, attributed: 10800, other: 50000 },
  withheld: null, difference: -2900,
  components: [{ key: 'in_flight', amount: -2500, count: 1 }, { key: 'receiver_undone', amount: -1200, count: 1 }, { key: 'payer_undone', amount: 800, count: 1 }],
  unexplained: { total: 0, ownOther: 0, partnerOther: 0, residualOwn: 0, residualPartner: 0 }, reconciles: true, blockingRows: 0,
  identityFailures: 0, loanAccountChanged: false, counts: { messages: 5, undone: 2, attention: 1, mismatch: 0 }, truncated: { unsent: false, unlinked: false }, ...over,
});
const item = (over: Partial<ReconItem> = {}): ReconItem => ({
  kind: 'message', id: 'msg-1', createdAt: '2026-09-10T08:00:00.000Z', direction: 'out', status: 'accepted', bucket: 'receiver_undone', amount: 1200,
  contribution: -1200, payerState: 'standing', receiverState: 'clearing_voided', partnerDocument: 'not_open', payerJournalDiffers: false,
  receiverJournalDiffers: false, flags: [], mismatches: [],
  error: null, sentence: 'The partner cancelled its clearing receipt; your side still stands.',
  display: { paymentNumber: 'PAY-9', paymentDate: '2026-09-10', reference: 'ref', payerDocumentNumber: 'PARTNER-INV-7', currency: 'ZAR' },
  own: { billId: 'bill-1', billNumber: 'BILL-1', paymentId: 'pay-1', paymentNumber: 'PAY-9', paymentStatus: 'processed', invoiceId: null, invoiceNumber: null, receiptId: null, receiptNumber: null },
  cutover: null, ...over,
});
const report = (over: Partial<ReconReport> = {}, items: ReconItem[] = [item()], total = items.length, offset = 0): ReconReport => ({
  connectionId: 'conn-1', partnerName: 'Velocity Fibre', asOf: '2026-11-24', readAt: '2026-11-24T10:15:00.000Z', summary: summary(),
  section: { key: 'undone', items, total, limit: 50, offset }, ...over,
});

let reply: (u: URL) => Response;
const calls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => new URL(String(u), 'http://x'));
beforeEach(() => {
  h.query = {};
  vi.mocked(apiFetch).mockReset();
  reply = () => envelope(report());
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    const u = new URL(String(url), 'http://x');
    if (u.pathname === '/api/accounting/intercompany/loan-reconciliation') {
      return envelope({ connections: [{ id: 'conn-1', partnerName: 'Velocity Fibre', settlementMode: 'loan', status: 'active' }, { id: 'conn-2', partnerName: 'Blitz', settlementMode: 'loan', status: 'active' }] });
    }
    return reply(u);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the summary card', () => {
  it('as at T and read at, both balances, the difference, the components with counts, "Reconciles"; no date field', async () => {
    render(<ReconPage />);
    const card = await screen.findByTestId('recon-summary');
    expect(card).toHaveTextContent(/as at 24 Nov 2026/i);
    expect(card).toHaveTextContent(/read at/i);
    expect(within(card).getByTestId('own-balance')).toHaveTextContent(/63\s700\.00/);
    expect(within(card).getByTestId('partner-balance')).toHaveTextContent(/60\s800\.00/);
    expect(within(card).getByTestId('difference')).toHaveTextContent(/2\s900\.00/);
    expect(within(card).getByTestId('badge')).toHaveTextContent('Reconciles');
    const rows = within(within(card).getByRole('table')).getAllByRole('row');
    expect(rows.length).toBe(4);
    expect(card).toHaveTextContent(/In flight/);
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.getByRole('combobox', { name: /connection/i })).toBeInTheDocument();
    // every part 0: nothing to break down, no hand-postings note
    expect(within(card).queryByTestId('unexplained-parts')).toBeNull();
    expect(within(card).queryByTestId('hand-postings-note')).toBeNull();
  });

  it('hand-posted openings that cancel: "Reconciles" with a note naming yours and the partner\'s, the parts listed', async () => {
    reply = () => envelope(report({ summary: summary({ reconciles: true, unexplained: { total: 0, ownOther: -50000, partnerOther: 50000, residualOwn: 0, residualPartner: 0 } }) }));
    render(<ReconPage />);
    expect(await screen.findByTestId('badge')).toHaveTextContent('Reconciles');
    const note = screen.getByTestId('hand-postings-note');
    // the signed figures, each as the card shows money: yours the credit, the partner's the debit
    expect(note.textContent).toBe(`Includes hand postings on the loan accounts: yours ${formatCurrency(-50000)}, partner's ${formatCurrency(50000)} (they cancel)`);
    expect(formatCurrency(-50000)).not.toBe(formatCurrency(50000));
    const parts = screen.getByTestId('unexplained-parts');
    expect(parts).toHaveTextContent(/Other postings, your account/);
  });

  it('residuals that cancel (U = 0): "Does not reconcile: postings no message explains", no hand-postings note', async () => {
    reply = () => envelope(report({ summary: summary({ reconciles: false, unexplained: { total: 0, ownOther: 0, partnerOther: 0, residualOwn: -300, residualPartner: 300 } }) }));
    render(<ReconPage />);
    expect(await screen.findByTestId('badge')).toHaveTextContent('Does not reconcile: postings no message explains');
    expect(screen.queryByText('Reconciles')).toBeNull();
    expect(screen.queryByTestId('hand-postings-note')).toBeNull();
    expect(screen.getByTestId('unexplained-parts')).toHaveTextContent(/Journals that differ from their messages, your side/);
  });

  it('Unexplained: the badge names R |U| and its four parts', async () => {
    reply = () => envelope(report({ summary: summary({ reconciles: false, unexplained: { total: -1000, ownOther: -50000, partnerOther: 49000, residualOwn: 0, residualPartner: 0 } }) }));
    render(<ReconPage />);
    const badge = await screen.findByTestId('badge');
    expect(badge).toHaveTextContent(/Unexplained R\s1\s000\.00/);
    const parts = screen.getByTestId('unexplained-parts');
    expect(parts).toHaveTextContent(/Other postings, your account/);
    expect(parts).toHaveTextContent(/49\s000\.00/);
    expect(parts).toHaveTextContent(/Journals that differ from their messages/);
    expect(screen.queryByTestId('hand-postings-note')).toBeNull();
  });

  it('U = 0 with rows that need attention: "Does not reconcile", never "Reconciles"', async () => {
    reply = () => envelope(report({ summary: summary({ reconciles: false, blockingRows: 2 }) }));
    render(<ReconPage />);
    expect(await screen.findByTestId('badge')).toHaveTextContent('Does not reconcile: 2 rows need attention');
    expect(screen.queryByText('Reconciles')).toBeNull();
  });

  it('the partner withheld: own figures, "Withheld: <sentence>", no difference, no components, no badge', async () => {
    reply = () => envelope(report({ summary: summary({ partnerState: 'partner_flag_off', partner: null, difference: null, components: null, unexplained: null, reconciles: null,
      blockingRows: null, withheld: { reason: 'partner_flag_off', sentence: 'The partner has not turned on intercompany loan clearing.' } }) }, [item({ bucket: null, contribution: null })]));
    render(<ReconPage />);
    const card = await screen.findByTestId('recon-summary');
    expect(within(card).getByTestId('own-balance')).toHaveTextContent(/63\s700\.00/);
    expect(card).toHaveTextContent('Withheld: The partner has not turned on intercompany loan clearing.');
    expect(within(card).queryByTestId('badge')).toBeNull();
    expect(within(card).queryByTestId('difference')).toBeNull();
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('an identity failure is an "Unexplained (count)" line, and a changed loan account and a shared one are said', async () => {
    reply = () => envelope(report({ summary: summary({ identityFailures: 1, reconciles: false, loanAccountChanged: true, own: { balance: 0, attributed: 0, other: 0, loanShared: true } }) }));
    render(<ReconPage />);
    expect(await screen.findByText(/Unexplained \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/a loan account was changed: figures cover the current account only/i)).toBeInTheDocument();
    expect(screen.getByText(/also serves another of your connections/i)).toBeInTheDocument();
  });
});

describe('the sections', () => {
  it('three tabs; each row names its state; links go to this company\'s own documents only; no action buttons', async () => {
    render(<ReconPage />);
    const table = await screen.findByTestId('recon-section');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([expect.stringMatching(/Accepted, then undone/), expect.stringMatching(/Needs attention/), expect.stringMatching(/Mismatches/)]);
    expect(table).toHaveTextContent('The partner cancelled its clearing receipt; your side still stands.');
    const links = within(table).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(links.sort()).toEqual(['/accounting/supplier-invoices/bill-1', '/accounting/supplier-payments/pay-1']);
    // the partner's document number is text, never a link
    expect(within(table).getByText(/PARTNER-INV-7/).closest('a')).toBeNull();
    for (const name of [/accept/i, /void/i, /resend/i, /repair/i, /reject/i, /dismiss/i, /fix/i]) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('switching tab asks for that section; an empty tab says so', async () => {
    reply = (u) => {
      const r = report({}, u.searchParams.get('section') === 'mismatch' ? [] : [item()]);
      return envelope({ ...r, section: { ...r.section, key: u.searchParams.get('section') ?? 'undone' } });
    };
    render(<ReconPage />);
    await screen.findByTestId('recon-section');
    fireEvent.click(screen.getByRole('tab', { name: /Mismatches/ }));
    expect(await screen.findByText(/No mismatches/i)).toBeInTheDocument();
    expect(calls().some((u) => u.searchParams.get('section') === 'mismatch')).toBe(true);
  });

  it('pagination: Next asks for the next page; each page shows its own readAt', async () => {
    const many = Array.from({ length: 50 }, (_, i) => item({ id: `msg-${i}` }));
    reply = (u) => (u.searchParams.get('offset') === '50'
      ? envelope(report({ readAt: '2026-11-24T10:20:00.000Z' }, [item({ id: 'msg-50' })], 51, 50))
      : envelope(report({}, many, 51)));
    render(<ReconPage />);
    await screen.findByTestId('recon-section');
    expect(screen.getByTestId('page-info')).toHaveTextContent('1-50 of 51');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(screen.getByTestId('page-info')).toHaveTextContent('51-51 of 51'));
    expect(calls().some((u) => u.searchParams.get('offset') === '50' && u.searchParams.get('limit') === '50')).toBe(true);
    expect(screen.getByTestId('recon-summary')).toHaveTextContent(/12:20/);
    expect(screen.getByText(/two pages are two reads/i)).toBeInTheDocument();
  });

  it('a refusal shows its sentence', async () => {
    reply = () => failure('Intercompany loan reconciliation is not enabled for this company.', 403);
    render(<ReconPage />);
    expect(await screen.findByText('Intercompany loan reconciliation is not enabled for this company.')).toBeInTheDocument();
  });

  it('a failed read offers Try again, keeps the chosen connection, and reads that connection again', async () => {
    let fail = false;
    reply = (u) => (fail ? failure('Could not load the reconciliation - try again', 500) : envelope(report({ connectionId: u.pathname.split('/').pop()! })));
    render(<ReconPage />);
    await screen.findByTestId('recon-summary');
    fail = true;
    fireEvent.change(screen.getByRole('combobox', { name: /connection/i }), { target: { value: 'conn-2' } });
    const retry = await screen.findByRole('button', { name: /try again/i });
    expect(screen.queryByTestId('recon-summary')).toBeNull();
    expect(screen.getByRole('combobox', { name: /connection/i })).toHaveValue('conn-2');
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByTestId('recon-summary')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /connection/i })).toHaveValue('conn-2');
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
    const reads = calls().filter((u) => u.pathname.endsWith('/conn-2'));
    expect(reads.length).toBe(2);
  });

  it('the connection list failing: Try again asks for it again', async () => {
    let fail = true;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = new URL(String(url), 'http://x');
      if (u.pathname === '/api/accounting/intercompany/loan-reconciliation') {
        return fail ? failure('Could not load your intercompany connections - try again', 500)
          : envelope({ connections: [{ id: 'conn-1', partnerName: 'Velocity Fibre', settlementMode: 'loan', status: 'active' }] });
      }
      return envelope(report());
    });
    render(<ReconPage />);
    const retry = await screen.findByRole('button', { name: /try again/i });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByTestId('recon-summary')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /connection/i })).toHaveValue('conn-1');
  });

  it('a capped list says it was cut (Needs attention)', async () => {
    reply = (u) => {
      const r = report({ summary: summary({ truncated: { unsent: true, unlinked: false } }) });
      return envelope({ ...r, section: { ...r.section, key: u.searchParams.get('section') ?? 'undone' } });
    };
    render(<ReconPage />);
    await screen.findByTestId('recon-section');
    expect(screen.queryByTestId('recon-truncated')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Needs attention/ }));
    expect(await screen.findByTestId('recon-truncated')).toHaveTextContent('Only the oldest 500 payments not sent to the partner are listed.');
  });

  it('no loan connection: says so', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope({ connections: [] }));
    render(<ReconPage />);
    expect(await screen.findByText(/no intercompany loan connection/i)).toBeInTheDocument();
  });
});
