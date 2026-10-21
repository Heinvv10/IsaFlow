/**
 * The migration hub's "Moving from Sage?" opener. A Sage move is the CSV /
 * Excel files exported from Sage, uploaded through this wizard — there is no
 * sign-in to Sage. Before a migration is started the opener points at the
 * source cards on the same page (no self-link); during one it links to the
 * wizard's first upload step. Shown in both states.
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
const opener = async () => (await screen.findByText(/Moving from Sage Business Cloud or Sage 50 \/ Pastel\?/)).parentElement!.parentElement!;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('migration hub: Moving from Sage?', () => {
  it('before a migration: describes the CSV / Excel export and links nowhere', async () => {
    answer(null);
    render(<MigrationHubPage />);
    const box = await opener();
    expect(box.tagName).not.toBe('A');
    expect(box.closest('a')).toBeNull();
    expect(box.textContent).toMatch(/CSV or Excel/);
    expect(box.textContent).not.toMatch(/sign in|password|connect/i);
    // The cards it points at are on the same page.
    expect(screen.getByText('Sage Business Cloud')).toBeTruthy();
    expect(screen.getByText('Sage 50 / Pastel')).toBeTruthy();
  });

  it('during a migration: links to the first upload step', async () => {
    answer(SESSION);
    render(<MigrationHubPage />);
    const link = (await opener()).closest('a');
    expect(link?.getAttribute('href')).toBe('/accounting/migration/chart-of-accounts');
    expect(link?.textContent).toMatch(/CSV or Excel/);
    expect(link?.textContent).not.toMatch(/sign in|password|connect/i);
  });

  // At 375px the text was squeezed beside the button. It stacks below `sm`
  // (text, then a full-width button) and is a row from `sm` up. jsdom has no
  // layout, so this pins the classes; the look is a browser check.
  it.each([['no session yet', null], ['a session in progress', SESSION]])('stacks on small screens and is a row from sm up (%s)', async (_n, session) => {
    answer(session);
    render(<MigrationHubPage />);
    const box = await opener();
    expect(box.className.split(' ')).toEqual(expect.arrayContaining(['flex-col', 'sm:flex-row', 'sm:items-center']));
  });

  it('its button is full width on small screens', async () => {
    answer(SESSION);
    render(<MigrationHubPage />);
    const link = (await opener()).closest('a')!;
    const button = screen.getByText('Upload Sage files');
    expect(button.closest('a')).toBe(link);
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['w-full', 'text-center', 'sm:w-auto']));
  });
});
