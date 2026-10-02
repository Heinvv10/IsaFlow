/**
 * D2 round 12: the upload pages that open the result after the write succeeded (capture, bank statement import,
 * supplier statements). A pending navigation keeps the button disabled; a cancelled one releases it; a rejected one is
 * logged and never says the upload failed. capture/index had no component test: success, refusal and empty 500 are here;
 * supplier-statements' list success reads the real `data` array.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve } from '../helpers/d2R3a6';
import { pendingNavigationKeepsButtonDisabled, rejectedNavigationIsNotAWriteFailure, type NavCase } from '../helpers/d2R12aNav';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
const warn = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/capture/AttachToTransactionSheet', () => ({ AttachToTransactionSheet: () => <p>ATTACH SHEET</p> }));
vi.mock('@/components/accounting/bank-transactions/StatementReviewPanel', () => ({ StatementReviewPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CapturePage from '../../../pages/accounting/capture/index';
import ImportPdfPage from '../../../pages/accounting/bank/statements/import-pdf';
import SupplierStatementsPage from '../../../pages/accounting/ap/supplier-statements/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); warn.mockReset(); toast.success.mockReset(); toast.error.mockReset(); });
afterEach(() => { cleanup(); });

const pdf = () => new File(['%PDF'], 'stmt.pdf', { type: 'application/pdf' });
const pickFile = (accept: RegExp) => {
  const input = Array.from(document.querySelectorAll('input[type="file"]')).find((i) => accept.test(i.getAttribute('accept') ?? '')) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdf()] } });
};

describe('capture/index', () => {
  const upload = async (answer: () => Response) => {
    serve(on('POST', 'capture/upload', answer));
    render(<CapturePage />);
    pickFile(/pdf/);
    fireEvent.click(await screen.findByRole('button', { name: /Upload 1 document/ }));
  };
  const button = () => screen.getByRole('button', { name: /Upload 1 document|Uploading/ });

  it('success with no documents to attach opens the inbox', async () => {
    await upload(() => ok({ eventIds: ['e1'], documentIds: [] }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/capture/inbox'));
    expect(toast.success).toHaveBeenCalledWith('Documents uploaded successfully');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('success with documents offers the attach sheet and does not navigate', async () => {
    await upload(() => ok({ eventIds: ['e1'], documentIds: ['d1'] }));
    expect(await screen.findByText('ATTACH SHEET')).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('a refusal toasts the server message, keeps the files and frees the button', async () => {
    await upload(() => refuse());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG));
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  });
  it('an empty 500 toasts one plain sentence', async () => {
    await upload(() => empty500());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not upload the documents - try again'));
    expect(toast.error.mock.calls[0]![0]).not.toMatch(/JSON|Unexpected end|HTTP \d/);
  });
  const nav = (): NavCase => ({
    push: route.push, warn, // the previews and their button are gone once the upload succeeded: nothing to click
    drive: () => upload(() => ok({ eventIds: ['e1'], documentIds: [] })),
    claimsFailure: () => toast.error.mock.calls.length > 0,
  });
  it('a pending navigation, then a cancelled one, never reports a failure', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not toast that the upload failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('bank/statements/import-pdf', () => {
  const nav = (): NavCase => ({
    push: route.push, warn,
    button: () => screen.getByRole('button', { name: /Upload & extract|Uploading/ }),
    drive: async () => {
      serve(on('POST', '/api/accounting/bank-statements', () => ok({ id: 'imp-1' })),
        on('GET', 'bank-accounts', () => ok([{ id: 'a1', accountCode: '1110', accountName: 'FNB Cheque', bankAccountNumber: '62001234' }])));
      render(<ImportPdfPage />);
      await screen.findByRole('option', { name: /FNB Cheque/ });
      pickFile(/pdf/);
      fireEvent.click(screen.getByRole('button', { name: /Upload & extract/ }));
    },
    claimsFailure: () => screen.queryByText(/Could not upload the statement/) !== null,
  });
  it('a pending navigation keeps the button disabled; a cancelled one releases it', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the upload failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});

describe('ap/supplier-statements', () => {
  const row = { id: 'rec-1', supplierId: 's1', supplierName: 'D2 Stationery Pty', statementDate: '2026-09-30', periodStart: null, periodEnd: null,
    supplierBalance: 1234.5, isaflowBalance: 1000, variance: 234.5, status: 'unreconciled' };
  it('list success: the served rows are listed, none of the failure sentences show', async () => {
    serve(on('GET', '/api/accounting/supplier-statements', () => ok([row])));
    render(<SupplierStatementsPage />);
    expect(await screen.findByText(/D2 Stationery Pty/)).toBeTruthy();
    expect(screen.queryByText(/Could not load the supplier statements/)).toBeNull();
  });
  it('list failure: an empty 500 shows one sentence and no rows', async () => {
    serve(on('GET', '/api/accounting/supplier-statements', () => empty500()));
    render(<SupplierStatementsPage />);
    expect(await screen.findByText('Could not load the supplier statements - try again')).toBeTruthy();
    expect(screen.queryByText(/D2 Stationery Pty/)).toBeNull(); expectNoJargon();
  });
  const nav = (): NavCase => ({
    push: route.push, warn, // the modal (and its Upload button) closes once the upload succeeded
    drive: async () => {
      serve(on('POST', '/api/accounting/supplier-statements', () => ok({ id: 'rec-1' })),
        on('GET', 'suppliers-list', () => ok({ suppliers: [{ id: 's26', name: 'Supplier 26' }], total: 1 })),
        on('GET', '/api/accounting/supplier-statements', () => ok([])));
      render(<SupplierStatementsPage />);
      fireEvent.click(screen.getByRole('button', { name: /Upload statement/ }));
      const inputs = screen.getAllByRole('textbox', { name: 'Supplier' });
      const input = inputs[inputs.length - 1]!;
      fireEvent.focus(input); fireEvent.change(input, { target: { value: 'Supplier 26' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Supplier 26' }, { timeout: 2000 }));
      pickFile(/pdf/);
      fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    },
    claimsFailure: () => screen.queryByText(/Could not upload the statement/) !== null,
  });
  it('a pending navigation, then a cancelled one, never reports a failure', async () => { await pendingNavigationKeepsButtonDisabled(nav()); });
  it('a rejected navigation does not say the upload failed', async () => { await rejectedNavigationIsNotAWriteFailure(nav()); });
});
