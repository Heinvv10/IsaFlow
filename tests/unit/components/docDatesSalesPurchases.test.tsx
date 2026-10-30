/**
 * Wave 2 PR A: every document date in Sales, Purchases, Banking and Inventory is a typed DateField, not a native
 * date input. For each converted form: no `input[type=date]` is left, "5 Oct 2031" + blur leaves the ISO date
 * "2031-10-05" in the form's own state (read from the hidden input DateField mirrors `value` into, via its `name`),
 * and text the field refuses never becomes the form's date.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: route.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
import { apiFetch } from '@/lib/apiFetch';
import { cases, type DateCase } from '../helpers/docDateCases';

useApiJsonOverMock();
let current: DateCase | undefined;
beforeEach(() => {
  route.query = current?.query ?? {};
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(current?.respond?.(String(url)) ?? []));
});
afterEach(() => { cleanup(); });

const mirror = (name: string): HTMLInputElement => document.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)!;
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;

describe.each(cases)('$page', (c) => {
  beforeEach(() => { current = c; route.query = c.query ?? {}; });
  const show = async (): Promise<void> => {
    render(c.element as ReactElement);
    if (c.open) await c.open();
    await waitFor(() => expect(mirror(c.fields[0]!.name)).toBeTruthy());
  };

  it('has no native date input', async () => {
    await show();
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(0);
  });

  for (const f of c.fields) {
    it(`${f.label}: typed text reaches the form as ISO`, async () => {
      await show();
      typeDate(box(f.label), '5 Oct 2031');
      await waitFor(() => expect(mirror(f.name).value).toBe('2031-10-05'));
    });

    it(`${f.label}: refused text never becomes the date; the form keeps the last good one`, async () => {
      await show();
      typeDate(box(f.label), '5 Oct 2031');
      await waitFor(() => expect(mirror(f.name).value).toBe('2031-10-05'));
      typeDate(box(f.label), 'zz');
      expect(box(f.label).getAttribute('aria-invalid')).toBe('true');
      expect(box(f.label).value).toBe('zz');
      // The form still holds the last good date (the gate, not the value, is what stops a submit: docDatesGate,
      // docDatesSubmit and docDatesGuards each submit with this refusal on screen and expect no request).
      expect(mirror(f.name).value).toBe(c.clearsRefused ? '' : '2031-10-05');
    });
  }
});
