/**
 * D2 round 3 (a6): approvals (rule delete, load) and VAT adjustments (create, approve, load). A refused write
 * must show the server's message and not claim success; a failed reload must not leave the old rows on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { afterWrite, empty500, expectNoJargon, MSG, ok, on, refuse, serve, type Route } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/components/accounting/approvals/ApprovalEnforcementPanel', () => ({ ApprovalEnforcementPanel: () => <span /> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import ApprovalsPage from '../../../pages/accounting/approvals/index';
import VATAdjustmentsPage from '../../../pages/accounting/vat-adjustments/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('approvals page', () => {
  const REQ = { id: 'q1', documentType: 'supplier_invoice', documentId: 'doc-00000001', documentReference: 'D2-INV-1', amount: 100,
    documentDigest: null, status: 'pending', requestedByName: 'D2 Requester', requestedAt: '2026-01-01T00:00:00Z', decidedAt: null, decisionNotes: null };
  const RULE = { id: 'r1', name: 'D2 Big Spend Rule', documentType: 'supplier_invoice', conditionField: 'amount', conditionOperator: 'gt',
    conditionValue: 1000, approverRole: 'admin', isActive: true };
  const base: Route[] = [on('GET', 'approval-requests', () => ok({ items: [REQ] })), on('GET', 'approval-rules', () => ok({ items: [RULE] }))];
  const toRules = async () => { render(<ApprovalsPage />); await screen.findByText(/Pending \(1\)/); fireEvent.click(screen.getByText('rules')); await screen.findByText('D2 Big Spend Rule'); };
  const trash = () => document.querySelector('button.text-red-400') as HTMLButtonElement;
  // R-035 PR A review r1: delete now asks first; confirm it.
  const confirmDelete = async () => fireEvent.click(await screen.findByRole('button', { name: 'Delete rule' }));

  it('load: refusal -> server message and no rows; empty-body 500 -> plain sentence', async () => {
    serve(on('GET', 'approval-requests', () => refuse()), ...base);
    render(<ApprovalsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'approval-rules', empty500), ...base);
    render(<ApprovalsPage />);
    expect(await screen.findByText('Could not load the approval rules - try again')).toBeDefined();
    expectNoJargon();
  });

  it('load: a failing reload (tab switch) clears the previous rows instead of leaving them under the new tab', async () => {
    let failing = false;
    serve((u) => (failing && u.includes('approval-') ? refuse() : undefined), ...base);
    render(<ApprovalsPage />);
    await screen.findByText('D2-INV-1', { exact: false });
    failing = true;
    fireEvent.click(screen.getByText('history'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2-INV-1', { exact: false })).toBeNull();
  });

  it('decision: an empty-body 500 gives a plain sentence', async () => {
    serve(on('POST', 'approval-requests', empty500), ...base);
    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText('Could not process the decision - try again')).toBeDefined();
    expectNoJargon();
  });

  it('delete rule: refusal -> message and the rule stays; empty-body 500 -> plain sentence', async () => {
    serve(on('DELETE', 'approval-rules', () => refuse()), ...base);
    await toRules();
    fireEvent.click(trash());
    await confirmDelete();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Big Spend Rule')).toBeDefined();
    serve(on('DELETE', 'approval-rules', empty500), ...base);
    fireEvent.click(trash());
    await confirmDelete();
    expect(await screen.findByText('Could not delete the rule - try again')).toBeDefined();
    expectNoJargon();
  });

  it('delete rule: a good delete reloads; if the reload fails the stale rule is gone and the error shown', async () => {
    serve(...afterWrite('DELETE', 'approval-rules', 'approval-rules'), ...base);
    await toRules();
    fireEvent.click(trash());
    await confirmDelete();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Big Spend Rule')).toBeNull();
  });
});

describe('VAT adjustments page', () => {
  const ADJ = { id: 'v1', adjustmentNumber: 'VA-D2-1', adjustmentDate: '2026-01-01', adjustmentType: 'input', amount: 10, reason: 'D2 reason', status: 'draft' };
  const list = on('GET', '/api/accounting/vat-adjustments', () => ok({ items: [ADJ] }));
  const fill = async () => {
    render(<VATAdjustmentsPage />);
    await screen.findByText('VA-D2-1');
    fireEvent.click(screen.getByText('New Adjustment'));
    fireEvent.change(screen.getByPlaceholderText('Amount *'), { target: { value: '25' } });
    fireEvent.change(screen.getByPlaceholderText('Reason for adjustment *'), { target: { value: 'D2 typed reason' } });
    fireEvent.submit(screen.getByText('Create Adjustment').closest('form')!);
  };

  it('load: refusal -> message and no rows; empty-body 500 -> plain sentence', async () => {
    serve(on('GET', '/api/accounting/vat-adjustments', () => refuse()));
    render(<VATAdjustmentsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', '/api/accounting/vat-adjustments', empty500));
    render(<VATAdjustmentsPage />);
    expect(await screen.findByText('Could not load VAT adjustments - try again')).toBeDefined();
    expectNoJargon();
  });

  it('create: refusal -> message, the form stays with the typed reason; empty-body 500 -> plain sentence (never bare "Failed")', async () => {
    serve(on('POST', '/api/accounting/vat-adjustments', () => refuse()), list);
    await fill();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect((screen.getByPlaceholderText('Reason for adjustment *') as HTMLInputElement).value).toBe('D2 typed reason');
    serve(on('POST', '/api/accounting/vat-adjustments', empty500), list);
    fireEvent.submit(screen.getByText('Create Adjustment').closest('form')!);
    expect(await screen.findByText('Could not save the VAT adjustment - try again')).toBeDefined();
    expectNoJargon();
  });

  it('create: written (200) then the reload fails -> form closed, reload error shown, old rows gone', async () => {
    serve(...afterWrite('POST', '/api/accounting/vat-adjustments', '/api/accounting/vat-adjustments'), list);
    await fill();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('VA-D2-1')).toBeNull();
    expect(screen.queryByPlaceholderText('Amount *')).toBeNull();
  });

  it('approve: refusal -> message and the row stays draft; empty-body 500 -> plain sentence; not stuck busy', async () => {
    serve(on('POST', 'vat-adjustments-action', () => refuse()), list);
    render(<VATAdjustmentsPage />);
    fireEvent.click(await screen.findByTitle('Approve'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('draft')).toBeDefined();
    await waitFor(() => expect((screen.getByTitle('Approve') as HTMLButtonElement).disabled).toBe(false));
    serve(on('POST', 'vat-adjustments-action', empty500), list);
    fireEvent.click(screen.getByTitle('Approve'));
    expect(await screen.findByText('Could not approve the VAT adjustment - try again')).toBeDefined();
    expectNoJargon();
  });
});
