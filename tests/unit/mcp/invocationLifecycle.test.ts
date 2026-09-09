import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
const state=vi.hoisted(()=>({sql:vi.fn(),admit:vi.fn(),outcome:vi.fn(),verify:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:state.sql}));
vi.mock('@/lib/mcp/invocationPersistence',()=>({captureInvocationIdentity:()=>({}),persistInvocationAdmission:state.admit,persistInvocationOutcome:state.outcome,verifyInvocationOutcome:state.verify,closeInvocationPool:vi.fn()}));
import {beginMcpInvocation,completeMcpInvocation,type InvocationHandle} from '@/lib/mcp/invocationStore';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {settleControlTransaction} from '@/modules/accounting/services/controls/transactionObservers';
const input={tool:'synthetic_tool',argsHash:'a'.repeat(64),idempotencyKeyHash:null};
const completion={status:'ok' as const,reportedWrite:true,durationMs:1};
function request<T>(handler:()=>Promise<T>,client={} as PoolClient){const userId=randomUUID(),companyId=randomUUID();return withControlRequest({client,userId,companyId,claims:{}},{personId:userId,companyId,authMethod:'cookie'},handler);}
beforeEach(()=>{vi.clearAllMocks();state.sql.mockResolvedValue([{xid:'123'}]);state.admit.mockResolvedValue(undefined);state.outcome.mockResolvedValue(undefined);state.verify.mockResolvedValue({outcome:'unknown',completion:null});});
it('awaits durable admission and fails closed before the tool effect',async()=>{state.admit.mockRejectedValue(new Error('admission failed'));const effect=vi.fn();await expect(request(async()=>{await beginMcpInvocation(input);effect();})).rejects.toThrow();expect(effect).not.toHaveBeenCalled();});
it('leaves a savepoint-discarded receipt unknown despite in-memory completion',async()=>{const client={} as PoolClient;await request(async()=>{const handle=await beginMcpInvocation(input);await completeMcpInvocation(handle,completion);expect(state.outcome).not.toHaveBeenCalled();},client);await settleControlTransaction(client,'committed');expect(state.verify).toHaveBeenCalledOnce();expect(state.outcome).toHaveBeenCalledWith(expect.anything(),expect.any(String),'unknown',null,'observer');});
it('rejects completion from a later request even for the original person',async()=>{const handle=await request(()=>beginMcpInvocation(input));await expect(request(()=>completeMcpInvocation(handle,completion))).rejects.toThrow(/match authenticated request/);});
it('records observer rollback after completion without claiming commit',async()=>{const client={} as PoolClient;await request(async()=>{const handle=await beginMcpInvocation(input);await completeMcpInvocation(handle,completion);},client);await settleControlTransaction(client,'rolled_back');expect(state.outcome).toHaveBeenCalledWith(expect.anything(),expect.any(String),'rolled_back',completion,'observer');});
it('rejects forged handles and refuses malformed input without admission',async()=>{await expect(request(()=>completeMcpInvocation({attemptId:randomUUID()} as InvocationHandle,completion))).rejects.toThrow();await expect(request(()=>beginMcpInvocation({...input,argsHash:'raw secret'}))).rejects.toThrow();expect(state.admit).not.toHaveBeenCalled();});
it('captures validated admission fields before yielding to database work',async()=>{const mutable={...input};let release!:()=>void;state.sql.mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve([{xid:'123'}]);}));await request(async()=>{const pending=beginMcpInvocation(mutable);mutable.tool='mutated_after_validation';await Promise.resolve();release();await pending;});expect(state.admit).toHaveBeenCalledWith(expect.anything(),input,expect.any(String),'123');});
