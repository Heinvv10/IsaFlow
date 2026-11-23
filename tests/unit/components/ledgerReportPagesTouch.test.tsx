// Customer and supplier ledger report pages: back link, Export CSV, party select and Run Report are 44px on phones; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: () => undefined, replace: () => undefined }) }));

import CustomerLedgerPage from '../../../pages/accounting/reports/customer-ledger';
import SupplierLedgerPage from '../../../pages/accounting/reports/supplier-ledger';

afterEach(cleanup);
const cases: Array<[string, () => ReactNode, boolean]> = [
  ['customer', () => <CustomerLedgerPage />, true],
  ['supplier', () => <SupplierLedgerPage />, false], // the supplier page uses the SupplierSelect combobox, not a native select
];

describe.each(cases)('%s ledger report page on touch', (_n, page, nativeSelect) => {
  it('makes the back link, Export CSV, party select and Run Report 44px', () => {
    const { container } = render(<>{page()}</>);
    const els = [screen.getByRole('link', { name: /Back to Reports/ }), screen.getByRole('button', { name: /Export CSV/ }), screen.getByRole('button', { name: /Run Report/ })];
    // The customer page has a native select; the supplier page's SupplierSelect combobox input takes the height from the page.
    els.push(nativeSelect ? container.querySelector('select')! : container.querySelector('#supplier-ledger-supplier')!);
    for (const el of els) {
      expect(el.className.split(' '), el.textContent ?? 'select').toContain('max-lg:min-h-11');
    }
  });

  it('lets the title and Export CSV wrap onto two rows on a phone', () => {
    render(<>{page()}</>);
    const row = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!;
    expect(row.className.split(' ')).toContain('max-lg:flex-wrap');
  });
});
