// Bureau clients: linked list is a card table below lg; links and buttons are 44px.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href, className, ...p }: { children: ReactNode; href: string; className?: string }) => <a href={href} className={className} {...p}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' }, companies: [{ companyId: 'co-2', companyName: 'Spare Co' }] }) }));

import { apiFetch } from '@/lib/apiFetch';
import BureauClientsPage from '../../../pages/bureau/clients/index';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(cleanup);

describe('bureau clients on touch', () => {
  it('labels the linked table and gives every control a 44px target', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u: string) =>
      u === '/api/bureau'
        ? ok({ bureaus: [{ id: 'b1', name: 'One', role: 'owner' }, { id: 'b2', name: 'Two', role: 'member' }] })
        : ok({ companies: [{ companyId: 'co-9', companyName: 'Acme Ltd', addedAt: '2026-10-01' }] }));
    const { container } = render(<BureauClientsPage />);
    await screen.findByText('Acme Ltd');
    const tables = container.querySelectorAll('table');
    expect(tables[0].className).toContain('table-cards');
    expect([...tables[0].querySelectorAll('tbody td[data-label]')].map(td => td.getAttribute('data-label'))).toEqual(['Linked']);
    expect(screen.getByRole('link', { name: 'Back to bureau' }).className).toContain('max-lg:h-11');
    expect(screen.getByRole('link', { name: 'Back to bureau' }).className).toContain('max-lg:shrink-0');
    expect(screen.getByRole('link', { name: /Acme Ltd/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Unlink/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Link to bureau/ }).className).toContain('max-lg:min-h-11');
    for (const b of screen.getAllByRole('button', { name: /One|Two/ })) expect(b.className).toContain('max-lg:min-h-11');
  });

  it('gives a non-owner no empty actions cell and no Unlink', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u: string) =>
      u === '/api/bureau'
        ? ok({ bureaus: [{ id: 'b1', name: 'One', role: 'member' }] })
        : ok({ companies: [{ companyId: 'co-9', companyName: 'Acme Ltd', addedAt: '2026-10-01' }] }));
    const { container } = render(<BureauClientsPage />);
    await screen.findByText('Acme Ltd');
    expect(screen.queryByRole('button', { name: /Unlink/ })).toBeNull();
    expect(container.querySelectorAll('table')[0].querySelectorAll('tbody tr:first-child td')).toHaveLength(2);
  });
});
