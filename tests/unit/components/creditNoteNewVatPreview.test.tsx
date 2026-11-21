/**
 * #1701 round 3 M2: the new credit-note page shows the VAT and total the note is stored with (creditNoteVatAndTotal,
 * exact cents). Its float product showed 4.99 on 33.30 at 15% while createCreditNote now stores 5.00.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { formatCurrency } from '@/utils/formatters';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import CreditNoteNew from '../../../pages/accounting/credit-notes/new';

useApiJsonOverMock();
afterEach(cleanup);

const shown = (subtotal: string, rate?: string) => {
  vi.mocked(apiFetch).mockImplementation(async () => ok([]));
  render(<CreditNoteNew />);
  fireEvent.change(screen.getByLabelText(/^Subtotal \(excl\. VAT\)/), { target: { value: subtotal } });
  if (rate !== undefined) fireEvent.change(screen.getByLabelText(/^VAT rate/), { target: { value: rate } });
  return document.body.textContent ?? '';
};

describe('credit-notes/new: the VAT shown is the VAT stored', () => {
  it.each([['33.30', 5, 38.3], ['3.30', 0.5, 3.8], ['43.30', 6.5, 49.8], ['100.30', 15.05, 115.35]])(
    '%s at 15 percent shows VAT %s and total %s', (subtotal, vat, total) => {
      const text = shown(subtotal);
      expect(text).toContain(`VAT (15%)${formatCurrency(vat)}`);
      expect(text).toContain(`Total${formatCurrency(total)}`);
    });

  it('a rate the route refuses (above 100) shows no VAT or total, and the route\'s reason', () => {
    const text = shown('100.00', '150');
    expect(text).toContain(`VAT (150%)${formatCurrency(0)}`);
    expect(text).toContain(`Total${formatCurrency(0)}`);
    expect(screen.getByRole('alert').textContent).toBe('taxRate must be a number from 0 to 100');
  });

  it('a subtotal not in whole cents never reaches the preview: the amount box refuses it (#1701 round 4 LOW C)', () => {
    const text = shown('10.005');
    expect(text).toContain(`Total${formatCurrency(0)}`);
    expect(screen.getByLabelText(/^Subtotal \(excl\. VAT\)/).getAttribute('aria-invalid')).toBe('true');
  });

  it('a valid note shows no reason', () => {
    shown('33.30');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
