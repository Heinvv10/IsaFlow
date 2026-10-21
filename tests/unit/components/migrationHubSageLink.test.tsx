/**
 * Round 4, item 7: the migration hub offered "Moving from Sage?" / Import from
 * Sage only before a session existed. Once the operator had started a file
 * migration there was no way to the Sage connection from the hub at all. It is
 * shown in both states now.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' } }) }));

import MigrationHubPage from '../../../pages/accounting/migration/index';

const SESSION = {
  id: '11111111-2222-3333-4444-555555555555', sourceSystem: 'sage_cloud', status: 'in_progress', stepsCompleted: { coa: true },
  coaRecordsImported: 12, customersImported: 0, suppliersImported: 0, openingBalancesSet: false,
  arInvoicesImported: 0, apInvoicesImported: 0, errors: [], startedAt: '2026-10-01T10:00:00.000Z',
};
const answer = (session: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(
  JSON.stringify({ success: true, data: { session }, meta: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('migration hub: the way to Import from Sage', () => {
  it.each([['no session yet', null], ['a session in progress', SESSION]])('is shown with %s', async (_n, session) => {
    answer(session);
    render(<MigrationHubPage />);
    const link = (await screen.findByText(/Moving from Sage Business Cloud Accounting\?/)).closest('a');
    expect(link?.getAttribute('href')).toBe('/accounting/migration/sage');
  });

  // Round 5, item 6: at 375px the text was squeezed beside the button. It
  // stacks below `sm` (text, then a full-width button) and is a row from `sm`
  // up. jsdom has no layout, so this pins the classes; the look is a browser check.
  it('stacks on small screens and is a row from sm up', async () => {
    answer(null);
    render(<MigrationHubPage />);
    const link = (await screen.findByText(/Moving from Sage Business Cloud Accounting\?/)).closest('a')!;
    expect(link.className.split(' ')).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row', 'sm:items-center']));
    const button = screen.getAllByText('Import from Sage').find((n) => n.closest('a') === link)!;
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'text-center', 'sm:w-auto']));
  });
});
