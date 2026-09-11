/**
 * After Save, the Company Name input showed the OLD name until a reload.
 *
 * The page's load effect depended on the company context's `loading` flag, so when that flag
 * settled after the form was already on screen the effect ran again: it re-fetched the company
 * while the PUT was still in flight, read the row before the save committed, and wrote that
 * stale row over the form. Reproduced here in that order — the context settles mid-save and
 * the re-read answers with the pre-commit name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const ctx = vi.hoisted(() => ({ value: { activeCompany: { id: 'c1', name: 'Old Name' }, loading: true } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {} }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ctx.value }));
import CompanySettingsPage from '../../../pages/accounting/company-settings';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('company settings after a save', () => {
  it('keeps the saved Company Name when the company context settles while the save is in flight', async () => {
    let committedName = 'Old Name';
    let releasePut: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/accounting/companies?id=')) return json({ success: true, data: { id: 'c1', name: committedName } });
      if (url === '/api/accounting/companies' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { name: string };
        await new Promise<void>(resolve => { releasePut = resolve; });
        committedName = body.name;
        return json({ success: true, data: { id: 'c1', name: body.name, warnings: [] } });
      }
      return json({ success: true, data: null });
    }));

    const view = render(<CompanySettingsPage />);
    fireEvent.change(await screen.findByDisplayValue('Old Name'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(releasePut).toBeDefined());

    // The company context finishes loading while the PUT has not committed yet.
    ctx.value = { ...ctx.value, loading: false };
    view.rerender(<CompanySettingsPage />);
    await new Promise(resolve => setTimeout(resolve, 20));
    releasePut!();

    await screen.findByText(/Changes saved successfully/);
    expect(screen.getByDisplayValue('New Name'), 'the form went back to the name before the save').toBeInTheDocument();
    expect(screen.queryByDisplayValue('Old Name')).not.toBeInTheDocument();
  });
});
