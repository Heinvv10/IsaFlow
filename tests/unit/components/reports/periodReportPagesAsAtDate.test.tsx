/**
 * R-059 round 3 (LOW-5) — the four period report pages state their as-at date
 * in SAST and say so in the column heads.
 *
 * `to` / `period_end` stopped being a plain range end when the routes behind
 * these pages started rewinding Received/Outstanding to it. Two consequences
 * the pages had not caught up with:
 *
 *   1. All four built the date with `toISOString().split('T')[0]`, which
 *      converts to UTC first. On this UTC+2 host that names YESTERDAY between
 *      00:00 and 02:00 SAST, so for two hours every night the default report
 *      rewound a day and a receipt banked today dropped out of "Received".
 *      They use `fmtDate` now — the helper `ar-aging.tsx` and `ap-aging.tsx`
 *      already use for exactly this.
 *   2. "Received", "Paid", "Outstanding" and "Balance" changed meaning from
 *      "today" to "as at the period end", and nothing on the page said so.
 *
 * PREMISE OF TEST 1: the host runs UTC+2, so a local time inside the first two
 * hours of the day is the previous day in UTC and the two spellings disagree.
 * The suite asserts that premise rather than assuming it — on a UTC host the
 * mutation would not be detectable here and the assertion would be decorative.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fmtDate } from '@/lib/fmtDate';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const asked: string[] = [];
/** One row, with every field any of the four pages reads. Two of them render
 *  no table at all when the list is empty, and the column heads are the point. */
const ROW = {
  clientId: 'c1', clientName: 'Acme', supplierId: 's1', supplierName: 'Acme',
  invoiceCount: 1, totalInvoiced: 100, totalPaid: 40, balance: 60,
  totalSales: 100, paymentsReceived: 40, totalPurchases: 100, paymentsMade: 40,
  outstanding: 60,
};
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async (url: string) => {
    asked.push(String(url));
    return new Response(JSON.stringify({ success: true, data: [ROW] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

import SalesByCustomerPage from '../../../../pages/accounting/reports/sales-by-customer';
import PurchasesBySupplierPage from '../../../../pages/accounting/reports/purchases-by-supplier';
import CustomerReportsPage from '../../../../pages/accounting/reports/customer-reports';
import SupplierReportsPage from '../../../../pages/accounting/reports/supplier-reports';

/** 00:30 LOCAL — inside the window where toISOString names the previous day. */
const EARLY_LOCAL = new Date(2026, 8, 10, 0, 30, 0);
const LOCAL_DAY = '2026-09-10';

const PAGES = [
  { name: 'sales-by-customer', Page: SalesByCustomerPage, param: 'to', columns: ['Received at', 'Outstanding at'] },
  { name: 'purchases-by-supplier', Page: PurchasesBySupplierPage, param: 'to', columns: ['Paid at', 'Outstanding at'] },
  { name: 'customer-reports', Page: CustomerReportsPage, param: 'period_end', columns: ['Paid at', 'Balance at'] },
  { name: 'supplier-reports', Page: SupplierReportsPage, param: 'period_end', columns: ['Paid at', 'Balance at'] },
] as const;

beforeEach(() => {
  asked.length = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(EARLY_LOCAL);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('R-059 the period report pages date themselves in SAST', () => {
  it('the premise: at 00:30 local this host disagrees with UTC about the day', () => {
    expect(fmtDate(new Date())).toBe(LOCAL_DAY);
    expect(new Date().toISOString().split('T')[0]).not.toBe(LOCAL_DAY);
  });

  for (const { name, Page, param, columns } of PAGES) {
    it(`${name} asks the API for the LOCAL day, not the UTC one`, async () => {
      render(<Page />);
      await waitFor(() => expect(asked.length).toBeGreaterThan(0));
      const url = asked[0]!;
      expect(url).toContain(`${param}=${LOCAL_DAY}`);
      expect(url).not.toContain(new Date().toISOString().split('T')[0]!);
    });

    it(`${name} says which date its settlement columns are stated at`, async () => {
      render(<Page />);
      await waitFor(() => expect(asked.length).toBeGreaterThan(0));
      for (const column of columns) {
        expect(
          await screen.findByRole('columnheader', {
            name: new RegExp(`^${column}\\s+${LOCAL_DAY}$`, 'i'),
          }),
        ).toBeInTheDocument();
      }
    });
  }
});
