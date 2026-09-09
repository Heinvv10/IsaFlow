// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {createElement,type ReactNode} from 'react';
const fetch=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/apiFetch',()=>({apiFetch:fetch}));
vi.mock('@/components/layout/AppLayout',()=>({AppLayout:({children}:{children:ReactNode})=>children}));
import BankTransfersPage from '../../../../pages/accounting/bank-transfers';
it('does not restore an old prepared transfer after the destination changes while awaiting preparation',async()=>{
 let resolve!:(value:unknown)=>void;
 fetch.mockResolvedValueOnce({ok:true,json:async()=>({data:{accounts:[{id:'a',account_name:'Source'},{id:'b',account_name:'Old destination'},{id:'c',account_name:'New destination'}]}})})
 .mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 render(createElement(BankTransfersPage));
 await waitFor(()=>expect(screen.getAllByRole('combobox')).toHaveLength(2));
 fireEvent.change(screen.getAllByRole('combobox')[0]!,{target:{value:'a'}});
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'b'}});
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'100.01'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare Transfer'}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'c'}});
 await act(async()=>resolve({ok:true,json:async()=>({data:{intentId:'old-destination-intent',status:'prepared',requiresApproval:false,amount:'100.01',currency:'ZAR',accountingDate:'2026-02-28'}})}));
 expect(screen.queryByText('Intent: old-destination-intent')).toBeNull();
});
