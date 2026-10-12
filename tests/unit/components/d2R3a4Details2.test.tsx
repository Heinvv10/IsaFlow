/**
 * D2 round 3 (a4): detail pages (supplier credit note, expense claim). Status before body on loads, every write checked, refused writes never redirect / claim success.
 */
import { chartAccount } from '../helpers/chartAccount';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: { id: 'x1', poId: 'po1' } as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierCreditNotePage from '../../../pages/accounting/supplier-credit-notes/[id]';
import ExpenseClaimPage from '../../../pages/accounting/expenses/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  route.push.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { cleanup(); });

const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const btn = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('supplier-credit-notes/[id]', () => {
  const NOTE = { id: 'x1', creditNoteNumber: 'SCN-D2-1', supplierName: 'D2 Supplier', status: 'draft', creditDate: '2026-01-01',
    createdAt: '2026-01-01', invoiceNumber: null, reason: 'D2 reason', totalAmount: 10, subtotal: 9, taxAmount: 1, lines: [] };
  const script = (load: () => Response, write: () => Response = () => ok(NOTE)) =>
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (isWrite(init) ? write() : load()));

  it('a refused load shows the server message; an empty 500 shows a plain sentence', async () => {
    script(() => envelope());
    const { unmount } = render(<SupplierCreditNotePage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    unmount();
    script(empty500);
    render(<SupplierCreditNotePage />);
    expect(await screen.findByText(/Could not load the supplier credit note - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused post shows the server message and keeps the draft', async () => {
    script(() => ok(NOTE), () => envelope());
    render(<SupplierCreditNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Post$/ })).toBeTruthy();
  });

  it('a post answered with an empty 500 shows a plain sentence and the note is still a draft', async () => {
    script(() => ok(NOTE), empty500);
    render(<SupplierCreditNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));
    expect(await screen.findByText(/Could not update the credit note - try again/)).toBeTruthy();
    noJsonLeak();
    expect(screen.getByRole('button', { name: /^Post$/ })).toBeTruthy();
  });

  it('a refused delete shows the server message and does not navigate', async () => {
    script(() => ok(NOTE), () => envelope());
    render(<SupplierCreditNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a delete answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok(NOTE), empty500);
    render(<SupplierCreditNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    expect(await screen.findByText(/Could not delete the credit note - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a successful delete navigates to the list', async () => {
    script(() => ok(NOTE), () => ok({}));
    render(<SupplierCreditNotePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/supplier-credit-notes'));
  });
});

describe('expenses/[id]', () => {
  const CLAIM = { id: 'x1', claimNumber: 'EXP-D2-1', claimDate: '2026-01-01', employeeId: 'e1', title: 'D2 Claim', description: null,
    status: 'draft', totalAmount: 0, totalVat: 0, approvedBy: null, approvedAt: null, rejectionReason: null, postedJeId: null,
    postedAt: null, submittedAt: null, lines: [] };
  const script = (load: () => Response, write: () => Response = () => ok({ claim: CLAIM })) =>
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (isWrite(init)) return write();
      if (u.includes('chart-of-accounts')) return ok([chartAccount('g1', '6000', 'D2 Expense')]);
      return load();
    });
  const addReceipt = async () => {
    fireEvent.click(await screen.findByRole('button', { name: /Add receipt/ }));
    fireEvent.change(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    await screen.findByRole('option', { name: /D2 Expense/ });
    fireEvent.change(screen.getByDisplayValue('GL account…'), { target: { value: 'g1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
  };

  it('a refused load shows the server message, not "Network error"', async () => {
    script(() => envelope());
    render(<ExpenseClaimPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Network error')).toBeNull();
  });

  it('an empty-500 load shows a plain sentence, not "Network error"', async () => {
    script(empty500);
    render(<ExpenseClaimPage />);
    expect(await screen.findByText(/Could not load the expense claim - try again/)).toBeTruthy();
    expect(screen.queryByText('Network error')).toBeNull();
    noJsonLeak();
  });

  it('a refused add-receipt shows the server message as a toast and no "Line added"', async () => {
    script(() => ok({ claim: CLAIM }), () => envelope());
    render(<ExpenseClaimPage />);
    await addReceipt();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Line added')).toBeNull();
  });

  it('an add-receipt answered with an empty 500 shows a plain sentence', async () => {
    script(() => ok({ claim: CLAIM }), empty500);
    render(<ExpenseClaimPage />);
    await addReceipt();
    expect(await screen.findByText(/Could not add the line - try again/)).toBeTruthy();
    expect(screen.queryByText('Line added')).toBeNull();
    noJsonLeak();
  });

  it('a successful add-receipt toasts "Line added"', async () => {
    script(() => ok({ claim: CLAIM }), () => ok({ claim: CLAIM }));
    render(<ExpenseClaimPage />);
    await addReceipt();
    expect(await screen.findByText('Line added')).toBeTruthy();
  });

  it('a refused approve shows the server message and the claim stays submitted', async () => {
    script(() => ok({ claim: { ...CLAIM, status: 'submitted' } }), () => envelope());
    render(<ExpenseClaimPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeTruthy();
  });

  it('an approve answered with an empty 500 shows a plain sentence, not "Network error"', async () => {
    script(() => ok({ claim: { ...CLAIM, status: 'submitted' } }), empty500);
    render(<ExpenseClaimPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Approve$/ }));
    expect(await screen.findByText(/Could not update the claim - try again/)).toBeTruthy();
    expect(screen.queryByText('Network error')).toBeNull();
  });
});
