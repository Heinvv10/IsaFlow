import {beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({client:{},require:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:state.require}));
vi.mock('@/lib/als',()=>({als:{getStore:()=>({client:state.client})}}));
import {observeControlTransaction,settleControlTransaction} from '@/modules/accounting/services/controls/transactionObservers';
import type {PoolClient} from 'pg';
beforeEach(()=>{state.client={};state.require.mockReset();state.require.mockReturnValue({});});
it('defers observers until the wrapper reports a durable commit and settles once',async()=>{
 const observer=vi.fn();observeControlTransaction(observer);expect(observer).not.toHaveBeenCalled();
 await settleControlTransaction(state.client as PoolClient,'committed');
 await settleControlTransaction(state.client as PoolClient,'rolled_back');
 expect(observer).toHaveBeenCalledExactlyOnceWith('committed');
});
it('reports rollback without converting handler success into commit',async()=>{
 const observer=vi.fn();observeControlTransaction(observer);
 await settleControlTransaction(state.client as PoolClient,'rolled_back');
 expect(observer).toHaveBeenCalledExactlyOnceWith('rolled_back');
});
it('does not register outside an authenticated transaction',()=>{
 state.require.mockImplementation(()=>{throw new Error('no context');});
 expect(()=>observeControlTransaction(vi.fn())).toThrow('no context');
});
it('isolates observer failures after durable commit and still runs the remaining observers',async()=>{
 const second=vi.fn();observeControlTransaction(async()=>{throw new Error('observer failed');});observeControlTransaction(second);
 await expect(settleControlTransaction(state.client as PoolClient,'committed')).resolves.toBeUndefined();
 expect(second).toHaveBeenCalledExactlyOnceWith('committed');
});
