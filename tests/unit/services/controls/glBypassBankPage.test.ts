// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
const fetch=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/apiFetch',()=>({apiFetch:fetch}));
vi.mock('@/components/layout/AppLayout',()=>({AppLayout:({children}:{children:ReactNode})=>children}));
import BankTransfersPage from '../../../../pages/accounting/bank-transfers';
it('keeps preparation truthful and sends the exact decimal string',async()=>{
 fetch.mockResolvedValueOnce({ok:true,json:async()=>({data:{accounts:[{id:'a',account_name:'Source'},{id:'b',account_name:'Destination'}]}})})
  .mockResolvedValueOnce({ok:true,json:async()=>({data:{intentId:'intent',status:'approval_required',requiresApproval:true,amount:'100.01',currency:'ZAR',accountingDate:'2026-02-28'}})});
 render(createElement(BankTransfersPage));
 await waitFor(()=>expect(screen.getAllByRole('combobox')).toHaveLength(2));
 fireEvent.change(screen.getAllByRole('combobox')[0]!,{target:{value:'a'}});
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'b'}});
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'100.01'}});
 fireEvent.click(screen.getByRole('button',{name:/(Process|Prepare) Transfer/i}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 expect(JSON.parse(fetch.mock.calls[1]![1].body).amount).toBe('100.01');
 expect(await screen.findByText(/prepared.*approval required/i)).toBeTruthy();
 expect(screen.queryByText(/Transfer completed/)).toBeNull();
});
