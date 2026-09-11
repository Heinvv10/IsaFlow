// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {createElement,type ReactNode} from 'react';
vi.mock('@/components/layout/AppLayout',()=>({AppLayout:({children}:{children:ReactNode})=>children}));
import BankTransfersPage from '../../../../pages/accounting/bank-transfers';
const envelope=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('does not restore an old prepared transfer after the destination changes while awaiting preparation',async()=>{
 let resolve!:(value:Response)=>void;
 // The chart-of-accounts list as the route sends it: `data: GLAccount[]`, camelCase.
 const accounts={success:true,data:[{id:'a',accountCode:'1000',accountName:'Source'},{id:'b',accountCode:'1010',accountName:'Old destination'},{id:'c',accountCode:'1020',accountName:'New destination'}]};
 const fetch=vi.fn(async(url:string)=>url.startsWith('/api/accounting/chart-of-accounts')?envelope(accounts):new Promise<Response>(r=>{resolve=r;}));
 vi.stubGlobal('fetch',fetch);
 render(createElement(BankTransfersPage));
 await screen.findAllByRole('option',{name:'1020 — New destination'});
 fireEvent.change(screen.getAllByRole('combobox')[0]!,{target:{value:'a'}});
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'b'}});
 fireEvent.change(screen.getByRole('spinbutton'),{target:{value:'100.01'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare Transfer'}));
 await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
 fireEvent.change(screen.getAllByRole('combobox')[1]!,{target:{value:'c'}});
 await act(async()=>resolve(envelope({success:true,data:{intentId:'old-destination-intent',status:'prepared',requiresApproval:false,amount:'100.01',currency:'ZAR',accountingDate:'2026-02-28'}})));
 expect(screen.queryByText('Intent: old-destination-intent')).toBeNull();
});
