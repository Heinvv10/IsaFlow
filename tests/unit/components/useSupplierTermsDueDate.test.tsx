/**
 * The new-bill page's due date follows: the bill's own terms when chosen, else the supplier's, else the company default;
 * it is DERIVED until the user (or a scan) types one, and switching supplier takes the previous supplier's date out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { useSupplierTermsDueDate } from '@/components/accounting/supplier-invoices/useSupplierTermsDueDate';

useApiJsonOverMock();
const A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const C = 'cccccccc-0000-4000-8000-cccccccccccc';
const SUPPLIERS: Record<string, Record<string, unknown>> = {
  [A]: { payment_terms: 30, payment_terms_type: 'invoice_days', company_default_payment_terms: 30, company_default_payment_terms_type: 'invoice_days' },
  [B]: { payment_terms: 3, payment_terms_type: 'statement_months', company_default_payment_terms: 30, company_default_payment_terms_type: 'invoice_days' },
  [C]: { payment_terms: null, payment_terms_type: null, company_default_payment_terms: 2, company_default_payment_terms_type: 'statement_months' },
};

let claim: () => void = () => undefined;
function Harness({ supplierId, invoiceDate = '2026-11-05', invoiceTerms = '' }: { supplierId: string; invoiceDate?: string; invoiceTerms?: string }) {
  const [due, setDue] = useState('');
  const hook = useSupplierTermsDueDate({ supplierId, invoiceDate, invoiceTerms, apply: setDue });
  claim = hook.claim;
  return <><output data-testid="due">{due}</output><output data-testid="note">{hook.note ?? ''}</output></>;
}
const due = () => screen.getByTestId('due').textContent;
const note = () => screen.getByTestId('note').textContent;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  serve((u) => { const id = /id=([^&]+)/.exec(u)?.[1]; return id && SUPPLIERS[id] ? ok({ id, ...SUPPLIERS[id] }) : undefined; });
});
afterEach(() => cleanup());

describe('useSupplierTermsDueDate', () => {
  it('fills from the supplier\'s terms, with a note', async () => {
    render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    expect(note()).toBe("Due date from the supplier's terms: 30 days from invoice date.");
  });

  it('a supplier with no terms is dated by the company default, and the note says so', async () => {
    render(<Harness supplierId={C} />);
    await waitFor(() => expect(due()).toBe('2027-01-31'));
    expect(note()).toBe('Supplier terms not confirmed: due date from the company default (2 months after statement).');
  });

  it('switching supplier A to B takes A\'s derived date out and re-derives from B', async () => {
    const { rerender } = render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    rerender(<Harness supplierId={B} />);
    await waitFor(() => expect(due()).toBe('2027-02-28'));
  });

  it('switching to a supplier that cannot be read leaves NO date, not the previous supplier\'s', async () => {
    const { rerender } = render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    serve((u) => (u.includes(B) ? empty500() : undefined));
    rerender(<Harness supplierId={B} />);
    await waitFor(() => expect(due()).toBe(''));
    await act(async () => { await new Promise((r) => { setTimeout(r, 30); }); });
    expect(due()).toBe('');
  });

  it('clearing the supplier clears the derived date', async () => {
    const { rerender } = render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    rerender(<Harness supplierId="" />);
    await waitFor(() => expect(due()).toBe(''));
  });

  it('a date the user typed (claimed) survives a supplier switch and an invoice date change', async () => {
    const { rerender } = render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    act(() => claim());
    rerender(<Harness supplierId={B} invoiceDate="2026-12-01" />);
    await act(async () => { await new Promise((r) => { setTimeout(r, 30); }); });
    expect(due()).toBe('2026-12-05');
    expect(note()).toBe('');
  });

  it('follows the invoice date until claimed', async () => {
    const { rerender } = render(<Harness supplierId={A} />);
    await waitFor(() => expect(due()).toBe('2026-12-05'));
    rerender(<Harness supplierId={A} invoiceDate="2026-11-10" />);
    await waitFor(() => expect(due()).toBe('2026-12-10'));
  });

  it('the bill\'s own terms, when chosen, beat the supplier\'s; clearing them goes back to the supplier\'s', async () => {
    const { rerender } = render(<Harness supplierId={B} invoiceTerms="net60" />);
    await waitFor(() => expect(due()).toBe('2027-01-04'));
    expect(note()).toBe("Due date from this bill's payment terms.");
    rerender(<Harness supplierId={B} invoiceTerms="" />);
    await waitFor(() => expect(due()).toBe('2027-02-28'));
  });

  it('immediate is the invoice date', async () => {
    render(<Harness supplierId={B} invoiceTerms="immediate" />);
    await waitFor(() => expect(due()).toBe('2026-11-05'));
  });
});
