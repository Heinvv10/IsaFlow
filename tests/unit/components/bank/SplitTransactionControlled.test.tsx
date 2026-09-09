import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {SplitTransactionModal} from '@/components/accounting/SplitTransactionModal';
const mocks=vi.hoisted(()=>({apiFetch:vi.fn(),success:vi.fn(),error:vi.fn()}));
vi.mock('@/lib/apiFetch',()=>({apiFetch:mocks.apiFetch}));vi.mock('@/utils/toast',()=>({notify:{success:mocks.success,error:mocks.error}}));
beforeEach(()=>{vi.clearAllMocks();mocks.apiFetch.mockResolvedValue({ok:true,json:async()=>({success:true,data:{}})});});
function setup(){const onPrepare=vi.fn();render(<SplitTransactionModal transaction={{id:'bank',transactionDate:'2026-09-09',amount:-115.23,status:'imported'}} glAccounts={[{id:'account',name:'Office costs',code:'4000'}]} onClose={vi.fn()} onPrepare={onPrepare}/>);fireEvent.click(screen.getByRole('button',{name:'Select GL Account'}));fireEvent.click(screen.getByRole('button',{name:'4000 Office costs'}));return{onPrepare};}
it('split review passes exact strings to preparation without posting or success claim',async()=>{
 const f=setup();fireEvent.click(screen.getByRole('button',{name:/Split & Allocate|Review split/}));
 await waitFor(()=>expect(f.onPrepare).toHaveBeenCalledWith({action:'prepare_split_allocate',bankTransactionId:'bank',lines:[{contraAccountId:'account',amount:'115.23',vatCode:'none',description:undefined}]}));
 expect(mocks.apiFetch).not.toHaveBeenCalled();expect(mocks.success).not.toHaveBeenCalled();
});
it('a one-cent mismatch cannot be submitted as a complete split',()=>{
 setup();fireEvent.change(screen.getByPlaceholderText('0.00'),{target:{value:'115.22'}});
 expect((screen.getByRole('button',{name:/Split & Allocate|Review split/}) as HTMLButtonElement).disabled).toBe(true);
});
