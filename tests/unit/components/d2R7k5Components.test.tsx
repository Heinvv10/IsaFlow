// D2 round 7 (k5): RecordNavigation, CostCentreAssignmentCard, InvoicePreviewModal and CompanyProvider
// must not drop a failed response silently (400 -> server message, empty 500 -> plain sentence, 200 -> completes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const warn = vi.fn();
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => warn(...a), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/ui/Modal', () => {
  const Modal = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Modal.Body = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  Modal.Footer = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { Modal };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import { RecordNavigation } from '@/components/accounting/RecordNavigation';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';
import { InvoicePreviewModal } from '@/components/accounting/InvoicePreviewModal';
import { CompanyProvider, useCompany } from '@/contexts/CompanyContext';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); warn.mockReset(); window.localStorage.clear(); });
afterEach(() => { cleanup(); });

describe('RecordNavigation', () => {
  const nav = () => render(<RecordNavigation entity="customers" currentId="c-1" basePath="/x" />);
  const prev = () => screen.getByLabelText('Previous record') as HTMLButtonElement;
  it('200: the arrows enable', async () => {
    serve(on('GET', 'record-adjacent', () => ok({ prevId: 'a', nextId: 'b' })));
    nav();
    await waitFor(() => expect(prev().disabled).toBe(false));
  });
  for (const [what, fail] of [['400', () => refuse()], ['empty 500', empty500]] as const) {
    it(`${what}: arrows stay off, the title says why, and the failure is logged`, async () => {
      serve(on('GET', 'record-adjacent', fail));
      nav();
      await waitFor(() => expect(prev().title).toBe('Could not load the neighbouring records'));
      expect(prev().disabled).toBe(true);
      expect(warn).toHaveBeenCalled();
    });
  }
  it('a failed load for the next record drops the previous record\'s neighbours', async () => {
    let n = 0;
    serve(on('GET', 'record-adjacent', () => (n++ === 0 ? ok({ prevId: 'a', nextId: 'b' }) : empty500())));
    const { rerender } = nav();
    await waitFor(() => expect(prev().disabled).toBe(false));
    rerender(<RecordNavigation entity="customers" currentId="c-2" basePath="/x" />);
    await waitFor(() => expect(prev().disabled).toBe(true));
  });
});

describe('CostCentreAssignmentCard load', () => {
  const card = () => render(<CostCentreAssignmentCard employeeId="e-1" currentCostCentreId={null} onChange={vi.fn()} />);
  const CC = [{ id: 'cc-1', code: 'D2', name: 'D2 Centre', isActive: true }];
  it('400 on cost centres: the server message', async () => {
    serve(on('GET', 'cost-centres', () => refuse()), on('GET', 'cost-allocations', () => ok([])));
    card();
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500 on allocations: a plain sentence, not an editable blank view', async () => {
    serve(on('GET', 'cost-centres', () => ok(CC)), on('GET', 'cost-allocations', () => empty500()));
    card();
    expect(await screen.findByText('Could not load the cost centres and allocations - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: lists the centres, no error', async () => {
    serve(on('GET', 'cost-centres', () => ok(CC)), on('GET', 'cost-allocations', () => ok([])));
    card();
    await waitFor(() => expect(document.body.textContent).toContain('D2 Centre'));
    expect(screen.queryByText(/could not load/i)).toBeNull();
  });
});

describe('InvoicePreviewModal load', () => {
  const modal = () => render(<InvoicePreviewModal open onClose={vi.fn()} invoiceId="i-1" />);
  const INV = { id: 'i-1', invoice_number: 'D2-INV-1', client_name: 'D2 Client', status: 'draft', invoice_date: '2026-01-01', due_date: '2026-01-31',
    subtotal: 100, tax_rate: 15, tax_amount: 15, total_amount: 115, amount_paid: 0, items: [] };
  it('400: the server message', async () => {
    serve(on('GET', 'customer-invoices-detail', () => refuse()));
    modal();
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('empty 500: a plain sentence', async () => {
    serve(on('GET', 'customer-invoices-detail', () => empty500()));
    modal();
    expect(await screen.findByText('Could not load the invoice - try again')).toBeDefined();
    expectNoJargon();
  });
  it('200: shows the invoice', async () => {
    serve(on('GET', 'customer-invoices-detail', () => ok(INV)));
    modal();
    expect(await screen.findByText('D2 Client')).toBeDefined();
  });
});

describe('CompanyProvider: company details enrichment', () => {
  function Probe() { const { activeCompany } = useCompany(); return <p>{activeCompany ? `active:${activeCompany.name}` : 'none'}</p>; }
  const run = (details: () => Response) => {
    window.localStorage.setItem('isaflow_active_company', JSON.stringify({ id: 'co-1', name: 'D2 Stored Co' }));
    serve(
      on('GET', 'action=user-companies', () => ok({ items: [], activeCompanyId: 'co-1' })),
      on('GET', 'companies?id=co-1', details),
    );
    render(<CompanyProvider><Probe /></CompanyProvider>);
  };
  it('a refused details fetch keeps the stored company and is logged, not dropped', async () => {
    run(() => refuse());
    await waitFor(() => expect(warn).toHaveBeenCalledWith('Failed to load company details', expect.anything(), 'context'));
    expect(screen.getByText('active:D2 Stored Co')).toBeDefined();
  });
  it('200: the profile replaces the stored stub', async () => {
    run(() => ok({ id: 'co-1', name: 'D2 Full Co' }));
    expect(await screen.findByText('active:D2 Full Co')).toBeDefined();
    expect(warn).not.toHaveBeenCalledWith('Failed to load company details', expect.anything(), 'context');
  });
});
