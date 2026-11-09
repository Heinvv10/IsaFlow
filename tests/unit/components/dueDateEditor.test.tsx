/**
 * The posted-document due-date editor (payment-terms programme PR 2; AR parity): it shows for the statuses the server
 * accepts (and no others), PUTs to the right route, and its statuses equal the services' own.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
// The services under comparison reach for the database module; only their exported status lists are read.
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn(), withSavepoint: vi.fn() }));

import { DUE_DATE_EDITORS, DueDateEditor } from '@/components/accounting/terms/DueDateEditor';
import { DUE_DATE_EDITABLE_STATUSES } from '@/modules/accounting/services/ap/billDueDateEdit';
import { INVOICE_DUE_DATE_EDITABLE_STATUSES } from '@/modules/accounting/services/ar/invoiceDueDateEdit';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const ALL = ['draft', 'pending_approval', 'approved', 'sent', 'overdue', 'partially_paid', 'paid', 'cancelled'];
const render_ = (kind: 'bill' | 'invoice', status: string, onSaved = vi.fn(), balance = 1150) =>
  render(<DueDateEditor kind={kind} invoiceId="i-1" status={status} balance={balance} invoiceDate="2026-09-16" dueDate="2026-12-15" dueDateSource="terms" onSaved={onSaved} />);

describe('DueDateEditor', () => {
  it('its statuses are the services\'', () => {
    expect([...DUE_DATE_EDITORS.bill.statuses]).toEqual([...DUE_DATE_EDITABLE_STATUSES]);
    expect([...DUE_DATE_EDITORS.invoice.statuses]).toEqual([...INVOICE_DUE_DATE_EDITABLE_STATUSES]);
  });

  it.each(ALL)('a customer invoice that is %s: editable exactly when the server accepts it', (status) => {
    render_('invoice', status);
    expect(Boolean(screen.queryByText('Change due date'))).toBe((INVOICE_DUE_DATE_EDITABLE_STATUSES as readonly string[]).includes(status));
  });

  it.each(ALL)('a supplier bill that is %s: editable exactly when the server accepts it', (status) => {
    render_('bill', status);
    expect(Boolean(screen.queryByText('Change due date'))).toBe((DUE_DATE_EDITABLE_STATUSES as readonly string[]).includes(status));
  });

  it.each([['bill', 0], ['bill', -50], ['invoice', 0], ['invoice', 0.004]] as const)(
    'a %s with %s owing (fully paid, status not yet moved): no editor, as the server refuses it', (kind, balance) => {
    render_(kind, 'partially_paid', vi.fn(), balance);
    expect(screen.queryByText('Change due date')).toBeNull();
  });

  it.each(['bill', 'invoice'] as const)('a %s owing one cent keeps the editor', (kind) => {
    render_(kind, 'partially_paid', vi.fn(), 0.01);
    expect(screen.queryByText('Change due date')).toBeTruthy();
  });

  it.each([
    ['invoice', '/api/accounting/customer-invoices-due-date'],
    ['bill', '/api/accounting/supplier-invoices-due-date'],
  ] as const)('a %s saves to %s with only the id and the date', async (kind, endpoint) => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ changed: true }));
    const onSaved = vi.fn();
    render_(kind, 'approved', onSaved);
    expect(screen.getByText(/Payment terms/)).toBeTruthy(); // the source shown beside the date
    fireEvent.click(screen.getByText('Change due date'));
    typeDate(screen.getByLabelText('New due date'), '31 Dec 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(url).toBe(endpoint);
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: 'i-1', dueDate: '2026-12-31' });
  });
});
