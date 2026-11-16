// UXS round 1: the kit Select's `required` (accessible asterisk) and a disabled Select offering no clear.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Select } from '@/components/ui/Select';
import { PaymentTermsField } from '@/components/accounting/PaymentTermsField';
import { ReportBuilderFilters } from '@/components/accounting/reports/ReportBuilderFilters';

afterEach(cleanup);
const OPTS = [{ value: 'a', label: 'Alpha' }];

describe('Select required / disabled clear', () => {
  it('required: aria-required on the trigger, a visible asterisk the name does not read', () => {
    render(<Select label="Kind" required options={OPTS} value={null} onChange={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: 'Kind' });
    expect(box.getAttribute('aria-required')).toBe('true');
    expect(box.parentElement!.querySelector('label span[aria-hidden="true"]')!.textContent).toBe('*');
  });

  it('not required: no aria-required, no asterisk', () => {
    render(<Select label="Kind" options={OPTS} value={null} onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Kind' }).hasAttribute('aria-required')).toBe(false);
  });

  it('clearable and disabled: no Clear button; enabled: there is one', () => {
    const { rerender } = render(<Select label="Kind" clearable disabled options={OPTS} value="a" onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
    rerender(<Select label="Kind" clearable options={OPTS} value="a" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy();
  });

  it('payment terms: required, and still named "Payment Terms"', () => {
    render(<PaymentTermsField days="" type="" inputClass="x" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Payment Terms' }).getAttribute('aria-required')).toBe('true');
  });

  it('report builder: the field picker can go back to blank', () => {
    const onChange = vi.fn();
    const fields = [{ field: 'name', label: 'Name', type: 'text', filterable: true }];
    render(<ReportBuilderFilters availableFields={fields} onChange={onChange}
      filters={[{ id: 'f1', field: 'name', operator: 'contains', value: 'x', value2: '' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'f1', field: '', operator: 'equals', value: '', value2: '' }]);
  });
});

describe('payment terms: order and heading', () => {
  it('the Select is before the number box in the DOM and on screen (no order override)', () => {
    render(<PaymentTermsField days="30" type="invoice_days" inputClass="x w-full" onChange={vi.fn()} />);
    const box = screen.getByRole('combobox', { name: 'Payment Terms' });
    const num = screen.getByLabelText('Number of days or months');
    expect(box.compareDocumentPosition(num) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(num.className).not.toMatch(/\border-/);
    expect(box.parentElement!.parentElement!.className).not.toMatch(/\border-/);
  });

  it('clicking the visible heading focuses the Select', () => {
    render(<PaymentTermsField days="" type="" inputClass="x" onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Payment Terms', { selector: 'span[aria-hidden="true"]' }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Payment Terms' }));
  });

  it('the employee picker is aria-required', async () => {
    const { DirectiveEmployeeSelect } = await import('@/components/payroll/TaxDirectiveEmployeeSelect');
    render(<DirectiveEmployeeSelect value="" onChange={vi.fn()} employees={[]} loading={false} error="" labelCls="" onRetry={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Employee' }).getAttribute('aria-required')).toBe('true');
  });
});
