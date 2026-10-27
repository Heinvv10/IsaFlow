/**
 * Wave 2 PR A: the shared document-date components. A typed date reaches the parent as ISO "YYYY-MM-DD"; text the
 * field refuses clears the value (the parent never keeps a stale date or receives the text); ResolveModal, which
 * posts, does not post while its date is refused.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
import { apiFetch } from '@/lib/apiFetch';
import { CustomerForm, INITIAL_CUSTOMER_FORM, type CustomerFormData } from '@/components/accounting/CustomerForm';
import { SupplierForm, INITIAL_SUPPLIER_FORM, type SupplierFormData } from '@/components/accounting/SupplierForm';
import { ExtractionReview } from '@/components/accounting/document-capture/ExtractionReview';
import { OpeningBalancesSection } from '@/components/accounting/items/ItemFormSections';
import { RecurringModal, type TemplateFormState } from '@/components/accounting/recurring-transactions/RecurringModal';
import { SupplierInvoiceSummary } from '@/components/invoices/SupplierInvoiceSummary';
import { ResolveModal } from '@/components/accounting/disputes/ResolveModal';
import type { DisputeRow } from '@/components/accounting/disputes/types';

afterEach(cleanup);
const box = (label: RegExp): HTMLInputElement => screen.getByRole('textbox', { name: label }) as HTMLInputElement;
const seen = <T,>(): { current: T | null } => ({ current: null });

function Customer({ out }: { out: { current: CustomerFormData | null } }): JSX.Element {
  const [form, setForm] = useState(INITIAL_CUSTOMER_FORM);
  return <CustomerForm form={form} onChange={(f) => { out.current = f; setForm(f); }} />;
}
function Supplier({ out }: { out: { current: SupplierFormData | null } }): JSX.Element {
  const [form, setForm] = useState(INITIAL_SUPPLIER_FORM);
  return <SupplierForm form={form} onChange={(f) => { out.current = f; setForm(f); }} />;
}

describe('opening balance date on the contact forms', () => {
  it('CustomerForm: typed -> ISO; refused -> cleared', () => {
    const out = seen<CustomerFormData>();
    render(<Customer out={out} />);
    typeDate(box(/opening balance as at/i), '5 Oct 2031');
    expect(out.current?.opening_balance_date).toBe('2031-10-05');
    typeDate(box(/opening balance as at/i), 'zz');
    expect(out.current?.opening_balance_date).toBe('');
  });
  it('SupplierForm: typed -> ISO; refused -> cleared', () => {
    const out = seen<SupplierFormData>();
    render(<Supplier out={out} />);
    typeDate(box(/opening balance as at/i), '5 Oct 2031');
    expect(out.current?.opening_balance_date).toBe('2031-10-05');
    typeDate(box(/opening balance as at/i), 'zz');
    expect(out.current?.opening_balance_date).toBe('');
  });
});

describe('single-date components', () => {
  it('ExtractionReview', () => {
    const onChange = vi.fn();
    const doc = { id: 'd1' } as never;
    render(<ExtractionReview uploadResult={{ document: doc, extracted: { confidence: 0.9, warnings: [], lineItems: [] } as never }}
      form={{ vendor: '', date: '', ref: '', total: '', vat: '', docType: '', notes: '' }} onChange={onChange} onDismiss={vi.fn()} onRefreshList={vi.fn()} />);
    typeDate(box(/^date/i), '5 Oct 2031');
    expect(onChange).toHaveBeenLastCalledWith('date', '2031-10-05');
    typeDate(box(/^date/i), 'zz');
    expect(onChange).toHaveBeenLastCalledWith('date', '');
  });
  it('ItemFormSections opening date', () => {
    const onChange = vi.fn();
    render(<OpeningBalancesSection opening_qty="" opening_cost="" opening_date="" onChange={onChange} />);
    typeDate(box(/opening date/i), '5 Oct 2031');
    expect(onChange).toHaveBeenLastCalledWith('opening_date', '2031-10-05');
    typeDate(box(/opening date/i), 'zz');
    expect(onChange).toHaveBeenLastCalledWith('opening_date', '');
  });
  it('RecurringModal next run date', () => {
    const onChange = vi.fn();
    const form: TemplateFormState = { name: 'T', entityType: 'journal_entry', frequency: 'monthly', nextRunDate: '', isActive: true, autoPost: false, templateData: '{}' };
    render(<RecurringModal form={form} isEdit={false} saving={false} formError={null} onChange={onChange} onSave={vi.fn()} onClose={vi.fn()} />);
    typeDate(box(/next run date/i), '5 Oct 2031');
    expect(onChange).toHaveBeenLastCalledWith({ nextRunDate: '2031-10-05' });
    typeDate(box(/next run date/i), 'zz');
    expect(onChange).toHaveBeenLastCalledWith({ nextRunDate: '' });
  });
  it('SupplierInvoiceSummary due date', () => {
    const onEditFormChange = vi.fn();
    render(<SupplierInvoiceSummary invoiceDate="2026-10-01" dueDate="2026-10-31" paymentTerms="" poNumber="" subtotal={0} taxAmount={0} taxRate={15}
      totalAmount={0} balance={0} notes="" items={[]} editing editForm={{ invoiceNumber: 'I', dueDate: '', paymentTerms: '', notes: '' }} onEditFormChange={onEditFormChange} />);
    typeDate(box(/due date/i), '5 Oct 2031');
    expect(onEditFormChange).toHaveBeenLastCalledWith({ dueDate: '2031-10-05' });
    typeDate(box(/due date/i), 'zz');
    expect(onEditFormChange).toHaveBeenLastCalledWith({ dueDate: '' });
  });
});

describe('ResolveModal credit note date', () => {
  const dispute = { id: 'disp-1', invoiceNumber: 'INV-1', disputedAmount: 100 } as unknown as DisputeRow;
  const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
  });

  it('posts the typed date as ISO', async () => {
    render(<ResolveModal dispute={dispute} onClose={vi.fn()} onDone={vi.fn()} />);
    typeDate(box(/credit note date/i), '5 Oct 2031');
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body))).toMatchObject({ mode: 'resolve_with_credit', creditDate: '2031-10-05' });
  });

  it('does not post while the date is refused, and posts once it is fixed', async () => {
    render(<ResolveModal dispute={dispute} onClose={vi.fn()} onDone={vi.fn()} />);
    typeDate(box(/credit note date/i), 'zz');
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    expect(posts()).toHaveLength(0);
    typeDate(box(/credit note date/i), '+30');
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body)).creditDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a refused date does not block a resolution that carries no credit date', async () => {
    render(<ResolveModal dispute={dispute} onClose={vi.fn()} onDone={vi.fn()} />);
    typeDate(box(/credit note date/i), 'zz');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'resolve_no_credit' } });
    fireEvent.click(screen.getByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
});
