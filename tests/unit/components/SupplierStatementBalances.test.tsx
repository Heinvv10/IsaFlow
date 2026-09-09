import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const { router } = vi.hoisted(() => ({ router: { isReady: true, query: { as_at_date: '2026-08-31' } } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
beforeEach(() => { vi.clearAllMocks(); router.isReady = true; });
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

it('ignores an older request that finishes after the selected date request',async()=>{
 let finishOld!: (res:Response)=>void;
 const fixture=(name:string)=>new Response(JSON.stringify({data:[{entityId:'s1',entityName:name,current:100,days30:0,days60:0,days90:0,days120Plus:0,total:100,onAccount:25,netBalance:75}]}));
 vi.mocked(apiFetch).mockImplementationOnce(()=>new Promise(resolve=>{finishOld=resolve;})).mockImplementationOnce(async()=>fixture('New date supplier'));
 render(<Page />);
 fireEvent.change(screen.getByLabelText('Statement date'),{target:{value:'2026-07-31'}});
 expect(await screen.findByRole('link',{name:'New date supplier'})).toBeTruthy();
 await act(async()=>finishOld(fixture('Old date supplier')));
 expect(screen.queryByRole('link',{name:'Old date supplier'})).toBeNull();
 expect(screen.getByRole('link',{name:'New date supplier'}).getAttribute('href')).toContain('2026-07-31');
});
it('waits for router readiness before loading a historical URL',()=>{
 router.isReady=false;
 render(<Page />);
 expect(apiFetch).not.toHaveBeenCalled();
});
