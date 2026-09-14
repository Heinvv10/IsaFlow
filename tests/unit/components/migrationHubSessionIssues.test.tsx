/**
 * The migration hub reads back what the wizard's steps recorded on the session.
 *
 * The import steps persist their per-row errors and their `severity: 'warning'`
 * rounding notes onto `migration_sessions.errors`, and the stated reason is
 * durability: "a row that imported with rounding drift is the whole point of
 * R-002 and is otherwise invisible". Nothing read that column — every consumer
 * read the API response of the import that had just run — so an operator who
 * navigated away lost the record, and the module docs asserted a behaviour the
 * product did not have.
 *
 * Rendered through the page, over the real response envelope, so the read-back
 * path is exercised rather than the panel alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'admin' } }),
}));

import MigrationHubPage from '../../../pages/accounting/migration/index';

const SESSION = {
  id: '11111111-2222-3333-4444-555555555555',
  sourceSystem: 'sage',
  status: 'in_progress',
  stepsCompleted: { coa: true, suppliers: true, ap_invoices: true },
  coaRecordsImported: 12,
  customersImported: 0,
  suppliersImported: 4,
  openingBalancesSet: false,
  arInvoicesImported: 0,
  apInvoicesImported: 1,
  errors: [
    { step: 'ap_invoices', row: 0, message: 'Imported with a rounding difference: INV-1 — subtotal 1000.00 + tax 150.00 != total 1150.01', severity: 'warning' },
    { step: 'suppliers', row: 2, message: 'Supplier not found: Acme Widgets' },
  ],
  startedAt: '2026-09-09T10:00:00.000Z',
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(
      JSON.stringify({ success: true, data: { session: SESSION }, meta: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ));
});

describe('migration hub', () => {
  it('shows the warnings and errors the session recorded, after a reload', async () => {
    render(<MigrationHubPage />);

    // The R-002 warning survives the page it was raised on.
    expect(await screen.findByText(/rounding difference: INV-1/)).toBeTruthy();
    // Row numbers are shown one-based, as the operator counts them.
    expect(await screen.findByText(/ap_invoices row 1:/)).toBeTruthy();
    // And an earlier step's error is still there beside it.
    expect(await screen.findByText(/Supplier not found: Acme Widgets/)).toBeTruthy();
  });

  it('shows no issues panel for a clean session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, data: { session: { ...SESSION, errors: [] } }, meta: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ));
    render(<MigrationHubPage />);
    expect(await screen.findByText(/Migration Steps/)).toBeTruthy();
    expect(screen.queryByText(/Import Issues/)).toBeNull();
  });
});
