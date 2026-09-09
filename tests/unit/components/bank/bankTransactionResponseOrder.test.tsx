import {act,renderHook,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {useBankTransactionsController} from '@/components/accounting/bank-transactions/useBankTransactionsController';
const api=vi.hoisted(()=>({fetch:vi.fn(),refresh:vi.fn()}));
vi.mock('@/lib/apiFetch',()=>({apiFetch:api.fetch}));
vi.mock('next/router',()=>({useRouter:()=>({query:{},isReady:true})}));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData',()=>({useBankTxRefData:()=>({refreshBankAccounts:api.refresh})}));
vi.mock('@/components/accounting/bank-transactions/useBankControlResume',()=>({useBankControlResume:()=>undefined}));
vi.mock('@/components/accounting/bank-transactions/useBankTransferRelink',()=>({useBankTransferRelink:()=>({pending:[],failed:false,refresh:api.refresh})}));
vi.mock('@/components/accounting/bank-transactions/useBankControlWorkflow',()=>({useBankControlWorkflow:()=>({state:null,open:vi.fn()})}));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions',()=>({buildBankTxActions:()=>({})}));
interface Deferred {resolve:(value:unknown)=>void;reject:(error:Error)=>void;signal?:AbortSignal}
let requests:Map<string,Deferred>;
beforeEach(()=>{
 requests=new Map();vi.clearAllMocks();api.fetch.mockImplementation((url:string,options?:{signal?:AbortSignal})=>{
  if(!url.startsWith('/api/accounting/bank-transactions?'))return Promise.resolve({ok:true,json:async()=>({data:[]})});
  const bank=new URL(url,'http://127.0.0.1').searchParams.get('bank_account_id')!;
  return new Promise((resolve,reject)=>requests.set(bank,{resolve,reject,signal:options?.signal}));
 });
});
const response=(bank:string)=>({ok:true,json:async()=>({data:{transactions:[{id:bank,description:bank}],total:1}})});
it('keeps selected B rows when the initial A response finishes after B',async()=>{
 const {result}=renderHook(()=>useBankTransactionsController());act(()=>result.current.setSelectedBank('A'));await waitFor(()=>expect(requests.has('A')).toBe(true));
 act(()=>result.current.setSelectedBank('B'));await waitFor(()=>expect(requests.has('B')).toBe(true));
 await act(async()=>requests.get('B')!.resolve(response('B')));await act(async()=>requests.get('A')!.resolve(response('A')));
 expect(result.current.selectedBank).toBe('B');expect(result.current.transactions.map(row=>row.id)).toEqual(['B']);expect(result.current.total).toBe(1);
});
it('ignores old errors and completion while the selected bank is still loading',async()=>{
 const {result}=renderHook(()=>useBankTransactionsController());act(()=>result.current.setSelectedBank('A'));act(()=>result.current.setSelectedBank('B'));
 await waitFor(()=>expect(requests.has('B')).toBe(true));await act(async()=>requests.get('A')!.reject(new Error('Old bank failed')));
 expect(result.current.error).toBe('');expect(result.current.isLoading).toBe(true);
 await act(async()=>requests.get('B')!.resolve(response('B')));expect(result.current.isLoading).toBe(false);expect(result.current.error).toBe('');
});
it('aborts the owned transaction request on unmount',async()=>{
 const {result,unmount}=renderHook(()=>useBankTransactionsController());act(()=>result.current.setSelectedBank('A'));await waitFor(()=>expect(requests.has('A')).toBe(true));
 const request=requests.get('A')!;unmount();expect(request.signal?.aborted).toBe(true);await act(async()=>request.resolve(response('A')));
});
it('does not start a later callback request after the controller unmounts',async()=>{
 const {result,unmount}=renderHook(()=>useBankTransactionsController());act(()=>result.current.setSelectedBank('A'));await waitFor(()=>expect(requests.has('A')).toBe(true));
 const reload=result.current.loadTransactions,previous=api.fetch.mock.calls.length;unmount();
 void reload();expect(api.fetch.mock.calls.length).toBe(previous);
 await act(async()=>requests.get('A')!.resolve(response('A')));
});
it('retained A callbacks refresh current B instead of issuing a newer stale A request',async()=>{
 const {result}=renderHook(()=>useBankTransactionsController());act(()=>result.current.setSelectedBank('A'));await waitFor(()=>expect(requests.has('A')).toBe(true));
 const oldReload=result.current.loadTransactions;await act(async()=>requests.get('A')!.resolve(response('A')));
 act(()=>result.current.setSelectedBank('B'));await waitFor(()=>expect(requests.has('B')).toBe(true));await act(async()=>requests.get('B')!.resolve(response('B')));
 act(()=>{void oldReload();});
 const last=api.fetch.mock.calls.at(-1)![0] as string;expect(new URL(last,'http://127.0.0.1').searchParams.get('bank_account_id')).toBe('B');
 await act(async()=>requests.get('B')!.resolve(response('B')));expect(result.current.selectedBank).toBe('B');expect(result.current.transactions.map(row=>row.id)).toEqual(['B']);
});
