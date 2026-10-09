/**
 * FX PR0: the new-invoice form's "ZAR equivalent" is toFunctional's figure —
 * the exact-decimal twin of the public.fx_functional the server stores — not
 * the float `Math.round(total * rate * 100) / 100` it replaced, which shows
 * R 1.00 for 1.005 at 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewInvoicePage from '../../../pages/accounting/customer-invoices/new';

useApiJsonOverMock();
afterEach(() => cleanup());

async function preview(unitPrice: string, taxRate: string, rate: string): Promise<string | null | undefined> {
  script((u) => (u.endsWith('/customers') ? ok([{ id: 'c-1', name: 'FX Client' }])
    : u.includes('currencies') ? ok([{ code: 'USD', name: 'US Dollar', symbol: '$' }]) : undefined));
  render(<NewInvoicePage />);
  await screen.findByRole('option', { name: /USD/ });
  fireEvent.change(document.querySelector('select[name="currencyCode"]')!, { target: { value: 'USD' } });
  fireEvent.change(document.querySelector('input[name="taxRate"]')!, { target: { value: taxRate } });
  fireEvent.change(document.querySelector('input[name="exchangeRate"]')!, { target: { value: rate } });
  fireEvent.change(document.querySelector('input[name="unitPrice"]')!, { target: { value: unitPrice } });
  return screen.getByText('ZAR equivalent').nextElementSibling?.textContent;
}

describe('new invoice: the ZAR equivalent', () => {
  it('USD 1 000 + 15% at 18.333 shows R 21,082.95', async () => {
    expect(await preview('1000', '15', '18.333')).toBe('R 21,082.95');
  });

  it('rounds a half cent away from zero, where float showed R 1.00', async () => {
    expect(await preview('1.005', '0', '1')).toBe('R 1.01');
  });
});
