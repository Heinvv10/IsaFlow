import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useBankTransferRelink} from '@/components/accounting/bank-transactions/useBankTransferRelink';
const {apiFetch}=vi.hoisted(()=>({apiFetch:vi.fn()}));
vi.mock('@/lib/apiFetch',()=>({apiFetch}));
const pending={bankTransactionId:'bank-source',intentId:'saved-intent',approvalId:'approval'};
beforeEach(()=>vi.clearAllMocks());
it('preserves owned pending references without claiming a posted transfer',async()=>{
 apiFetch.mockResolvedValue({ok:true,json:async()=>({data:{linked:0,failed:false,pending:[pending]}})});
 const {result}=renderHook(()=>useBankTransferRelink('bank-account'));
 await waitFor(()=>expect(result.current.pending).toEqual([pending]));
 expect(result.current.failed).toBe(false);expect(result.current.linked).toBe(0);
});
it('keeps partial failures distinct from available pending work and reports HTTP refusal',async()=>{
 apiFetch.mockResolvedValueOnce({ok:true,json:async()=>({data:{linked:0,failed:true,pending:[pending]}})}).mockResolvedValueOnce({ok:false});
 const {result,rerender}=renderHook(({bank})=>useBankTransferRelink(bank),{initialProps:{bank:'one'}});
 await waitFor(()=>expect(result.current.failed).toBe(true));expect(result.current.pending).toEqual([pending]);
 rerender({bank:'two'});await waitFor(()=>expect(result.current.failed).toBe(true));expect(result.current.pending).toEqual([]);
});
it('does not restore old-account pending links after a new account response',async()=>{
 let finish:(value:unknown)=>void=()=>{throw new Error('Missing deferred request');};
 apiFetch.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({ok:true,json:async()=>({data:{linked:0,failed:false,pending:[]}})});
 const {result,rerender}=renderHook(({bank})=>useBankTransferRelink(bank),{initialProps:{bank:'one'}});
 rerender({bank:'two'});await act(async()=>{finish({ok:true,json:async()=>({data:{linked:0,failed:false,pending:[pending]}})});});
 expect(result.current.pending).toEqual([]);expect(result.current.failed).toBe(false);
});
