import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
vi.mock('next/router', () => ({ useRouter: () => ({ query: { as_at_date: '2026-08-31' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import Page from '../../../pages/accounting/supplier-statements';
it('shows gross ageing, on-account credits and the reconciled net balance', async () => {
 vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({data:[{entityId:'supplier-1',entityName:'Cable Feeder',current:5844901.36,days30:0,days60:0,days90:0,days120Plus:0,total:5844901.36,onAccount:884343.60,netBalance:4960557.76}]})));
 render(<Page />);
 const link=await screen.findByRole('link',{name:'Cable Feeder'});
 const row=within(link.closest('tr')!);
 expect(row.getAllByRole('cell').map(c => c.textContent)).toContain(formatCurrency(884343.60));
 expect(row.getAllByRole('cell').map(c => c.textContent)).toContain(formatCurrency(4960557.76));
 expect(link.getAttribute('href')).toContain('as_at_date=2026-08-31');
});

it('shows loading failures without claiming no balances exist',async()=>{
 vi.mocked(apiFetch).mockImplementation(async () => new Response('{}',{status:500}));
 render(<Page />);
 expect(await screen.findByText('Failed to load supplier balances')).toBeTruthy();
 expect(screen.queryByText('No supplier balances')).toBeNull();
});
