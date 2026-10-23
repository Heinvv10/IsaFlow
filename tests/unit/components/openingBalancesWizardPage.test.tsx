/**
 * The opening-balance wizard page over a stubbed network.
 *
 * - Headers were matched case-sensitively, so "Account Code, Debit, Credit"
 *   parsed as blank rows and the button sat disabled with no explanation.
 * - The success line read `balancesSet` / `journalId`, which the service never
 *   returned ("set for undefined accounts"), and per-row errors were dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('papaparse', () => ({
  default: {
    parse: (_file: unknown, opts: { complete: (r: { data: Record<string, string>[]; meta: { fields: string[] } }) => void }) => {
      opts.complete({ data: PARSED, meta: { fields: FIELDS } });
    },
  },
}));

import OpeningBalancesPage from '../../../pages/accounting/migration/opening-balances';

let PARSED: Record<string, string>[] = [];
let FIELDS: string[] = [];
let posted: { balances?: Array<{ accountCode: string; debit: number; credit: number }> } | null = null;

const envelope = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  posted = null;
  FIELDS = ['Account Code', 'Account Name', 'Debit', 'Credit'];
  PARSED = [
    { 'Account Code': '1110', 'Account Name': 'Bank', Debit: 'R 1 234,56', Credit: '' },
    { 'Account Code': '3200', 'Account Name': 'Retained', Debit: '', Credit: '1,234.56' },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/accounting/migration/session')) return envelope({ session: { id: 's-1', sourceSystem: 'sage_cloud' } });
    if (url.startsWith('/api/accounting/migration/opening-balances')) {
      posted = JSON.parse(String(init?.body));
      return envelope({ journalEntryId: 'JE-9', linesImported: 1, errors: [{ step: 'opening_balances', row: 1, field: 'accountCode', message: 'Account 3200 not found' }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

function upload(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'tb.csv', { type: 'text/csv' })] } });
}

describe('opening balances wizard page', () => {
  it('reads Sage-style headers and SA amounts, then shows lines imported and the per-row errors', async () => {
    const { container } = render(<OpeningBalancesPage />);
    upload(container);
    expect(await screen.findByText('Balanced')).toBeTruthy();
    fireEvent.change(container.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2026-03-01' } });
    fireEvent.click(screen.getByText(/Set Opening Balances/));

    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 5000 });
    expect(posted!.balances).toEqual([
      { accountCode: '1110', debit: 1234.56, credit: 0 },
      { accountCode: '3200', debit: 0, credit: 1234.56 },
    ]);
    expect(await screen.findByText(/Opening balances posted: 1 account line\(s\)\. Journal entry JE-9/)).toBeTruthy();
    expect(screen.getByText(/Row 2: Account 3200 not found/)).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  }, 20000);

  it('names the expected headers when the file has none of them', async () => {
    FIELDS = ['Foo', 'Bar'];
    PARSED = [{ Foo: '1', Bar: '2' }];
    const { container } = render(<OpeningBalancesPage />);
    upload(container);
    expect(await screen.findByText(/Could not find the required columns.*Account Code.*Found: "Foo", "Bar"/)).toBeTruthy();
  }, 20000);
});
