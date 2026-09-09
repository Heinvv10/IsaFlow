import {renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useBankControlResume} from '@/components/accounting/bank-transactions/useBankControlResume';
const router=vi.hoisted(()=>({isReady:true,pathname:'/accounting/bank-transactions',query:{} as Record<string,string>,replace:vi.fn()}));
vi.mock('next/router',()=>({useRouter:()=>router}));vi.mock('@/utils/toast',()=>({notify:{error:vi.fn()}}));
beforeEach(()=>{router.query={};router.replace.mockReset().mockResolvedValue(true);});
it('refresh resumes the exact saved server instruction once and never executes it',async()=>{
 router.query={bankControlBank:'bank',bankControlIntent:'intent',account_id:'account'};const open=vi.fn().mockResolvedValue('pending'),posted=vi.fn();
 const view=renderHook(()=>useBankControlResume({state:null,open},posted));view.rerender();
 await waitFor(()=>expect(open).toHaveBeenCalledTimes(1));expect(open).toHaveBeenCalledWith({bankTransactionId:'bank',intentId:'intent',mode:'allocate'});expect(posted).not.toHaveBeenCalled();
});
it('persisted instruction URL retains unrelated account selection',async()=>{
 router.query={account_id:'account'};const state={id:1,bankTransactionId:'bank',selected:{intentId:'intent'}};
 renderHook(()=>useBankControlResume({state,open:vi.fn()},vi.fn()));
 await waitFor(()=>expect(router.replace).toHaveBeenCalledWith({pathname:router.pathname,query:{account_id:'account',bankControlBank:'bank',bankControlIntent:'intent'}},undefined,{shallow:true}));
});
