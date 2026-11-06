/**
 * The Aged Debtors screen's Total includes what is in dispute (still owed), and the disputed part is its own column and
 * summary card, so Current + 1-30 + 31-60 + 61-90 + 90+ + Disputed reads as the Total.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'c-1', name: 'Co' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '', headerClass: '' }) }));
vi.mock('@/components/accounting/AgingInvoicesPanel', () => ({ AgingInvoicesPanel: () => null }));

import ArAgingPage from '../../../pages/accounting/ar-aging';

useApiJsonOverMock();
afterEach(cleanup);

// 20 000 current + 21 765.50 at 1-30 + 300 (the undisputed half of a 600 invoice) at 31-60 + 300 disputed = 42 365.50
const ROW = { entityId: 'e1', entityName: 'Debtor Holdings', current: 20000, days30: 21765.5, days60: 300, days90: 0, days120Plus: 0, disputed: 300, total: 42365.5 };

describe('Aged Debtors with an open dispute', () => {
  it('shows the Total including the dispute, and the dispute as a column and a card', async () => {
    serve(on('GET', '/api/accounting/ar-aging', () => ok([ROW])));
    render(<ArAgingPage />);
    await screen.findByText('Debtor Holdings');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Disputed', 'Total']));
    expect(headers.indexOf('Disputed')).toBeLessThan(headers.indexOf('Total'));
    const row = screen.getByText('Debtor Holdings').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent?.replace(/\s/g, ' ') ?? '');
    expect(cells.at(-1)).toMatch(/42[\s ]365\.50/);
    expect(cells.at(-2)).toMatch(/300\.00/);
    // the summary card
    const card = screen.getAllByText('Disputed').map((e) => e.closest('div')).find((d) => d?.className.includes('rounded-lg'));
    expect(card?.textContent).toMatch(/300\.00/);
    expect(screen.getAllByText(/42[\s ]365\.50/).length).toBeGreaterThanOrEqual(2); // row Total and the Total card/footer
  });

  it('a book with no dispute shows a Disputed column of nothing, and an unchanged Total', async () => {
    serve(on('GET', '/api/accounting/ar-aging', () => ok([{ ...ROW, disputed: undefined, total: 42065.5, days60: 0 }])));
    render(<ArAgingPage />);
    const row = (await screen.findByText('Debtor Holdings')).closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
    expect(cells.at(-1)).toMatch(/42[\s ]065\.50/);
    expect(cells.at(-2)).toMatch(/0\.00/);
  });
});
