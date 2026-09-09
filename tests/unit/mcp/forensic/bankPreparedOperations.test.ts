import {beforeEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({ctx:{principal:{companyId:'company',personId:'person'}},permission:vi.fn(async()=>undefined),dispatch:vi.fn(async()=>({intentId:'saved'}))}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mocks.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/bank/bankControlActionService',()=>({dispatchBankControlAction:mocks.dispatch}));
import {bankPreparedOperationTools} from '@/lib/mcp/tools/bankPreparedOperations';
import {validateToolArguments} from '@/lib/mcp/inputValidation';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const ctx={companyId:'company',userId:'person',scopes:['write:bank-tx','write:post'],tokenJti:'token',oauthAppId:null};
const prepare={instruction:{action:'prepare_allocate',bankTransactionId:id,allocationType:'transfer',contraAccountId:other},idempotency_key:'prepare'};
const execute={instruction:{action:'allocate',bankTransactionId:id,intent_id:id,approval_id:other},idempotency_key:'execute'};
beforeEach(()=>{vi.clearAllMocks();mocks.permission.mockResolvedValue(undefined);});
it('exposes strict preparation and execution contracts admitted by registry validation',()=>{
 expect(bankPreparedOperationTools.map(t=>t.name)).toEqual(['prepare_bank_operation','execute_bank_operation']);
 bankPreparedOperationTools.forEach((tool,i)=>{expect(validateToolArguments(tool,[prepare,execute][i]).ok).toBe(true);expect(tool).toMatchObject({scope:'write:bank-tx',write:true,requiresPost:true,perUserIdempotency:true});});
});
it('uses actual issued context and MCP actor provenance for the shared execution coordinator',async()=>{
 await bankPreparedOperationTools[1].handler(execute,ctx);
 expect(mocks.dispatch).toHaveBeenCalledWith(mocks.ctx,execute.instruction,{postingAgent:'mcp:execute_bank_operation:v1',actorType:'agent',actorTokenJti:'token'});
});
it('rechecks current bank and posting rights before a registry replay without executing work',async()=>{
 await bankPreparedOperationTools[0].authorize!(prepare,ctx);
 expect(mocks.permission.mock.calls.map(c=>c[1])).toEqual(['write:bank-tx','write:post']);expect(mocks.dispatch).not.toHaveBeenCalled();
 mocks.permission.mockRejectedValueOnce(new Error('revoked'));
 await expect(bankPreparedOperationTools[1].authorize!(execute,ctx)).rejects.toThrow('revoked');
});
it('rejects instruction mixups and financial edits on execution before shared work',async()=>{
 for(const [index,args] of [[0,execute],[1,prepare],[1,{...execute,instruction:{...execute.instruction,description:'replacement'}}],[1,{...execute,instruction:{...execute.instruction,approval_id:undefined}}]] as const)
  expect((await bankPreparedOperationTools[index].handler(args,ctx)).isError).toBe(true);
 expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('refuses caller authority and mismatched issued principal; matching company assertion is stripped',async()=>{
 await bankPreparedOperationTools[0].handler({...prepare,company_id:'company'},ctx);
 expect(mocks.dispatch).toHaveBeenCalledWith(mocks.ctx,prepare.instruction,expect.any(Object));
 await expect(bankPreparedOperationTools[0].handler({...prepare,company_id:'foreign'},ctx)).rejects.toThrow();
 await expect(bankPreparedOperationTools[0].authorize!(prepare,{...ctx,userId:'other-person'})).rejects.toThrow();
 await expect(bankPreparedOperationTools[0].authorize!(prepare,{...ctx,companyId:'other-company'})).rejects.toThrow();
 expect((await bankPreparedOperationTools[0].handler({...prepare,instruction:{...prepare.instruction,actorType:'human'}},ctx)).isError).toBe(true);
});
it('never invokes caller accessors and rejects malformed UUID or impossible reversal date',async()=>{
 const getter=vi.fn(()=>prepare.instruction),args=Object.defineProperty({idempotency_key:'key'},'instruction',{enumerable:true,get:getter});
 expect((await bankPreparedOperationTools[0].handler(args,ctx)).isError).toBe(true);expect(getter).not.toHaveBeenCalled();
 for(const instruction of [{...prepare.instruction,bankTransactionId:'invalid'},{action:'prepare_reverse',bankTransactionId:id,originalIntentId:other,reversalDate:'2026-02-30',reason:'correct'}])
  expect((await bankPreparedOperationTools[0].handler({instruction,idempotency_key:'key'},ctx)).isError).toBe(true);
 expect(mocks.dispatch).not.toHaveBeenCalled();
});
it('propagates shared service failures so the registry rolls back the entire operation',async()=>{
 mocks.dispatch.mockRejectedValueOnce(new Error('after financial effect'));
 await expect(bankPreparedOperationTools[1].handler(execute,ctx)).rejects.toThrow('after financial effect');
});
