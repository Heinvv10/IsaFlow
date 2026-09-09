import {expect,it} from 'vitest';
import type {ControlPrincipal} from '@/modules/accounting/services/controls/contracts';
import {bankAllocationActor} from '@/modules/accounting/services/bank/bankAllocationActor';
const principal={personId:'person',authMethod:'pat',provenance:'agent',connectionId:'real-pat',grantId:null} as ControlPrincipal;
it('uses actual credential identity despite forged actor options',()=>{
 expect(bankAllocationActor(principal,{postingAgent:'human:forged',actorType:'human',actorTokenJti:'forged'})).toEqual({actorType:'agent',actorTokenJti:'real-pat',postingAgent:'mcp:bank_allocation:v1'});
});
it('preserves MCP tool label and binds OAuth identity to the issued grant',()=>{
 expect(bankAllocationActor({...principal,authMethod:'oauth',grantId:'real-grant'},{postingAgent:'mcp:allocate_bank_transaction:v1'})).toEqual({actorType:'agent',actorTokenJti:'real-grant',postingAgent:'mcp:allocate_bank_transaction:v1'});
});
it('does not let cookie callers claim agent identity',()=>{
 expect(bankAllocationActor({...principal,authMethod:'cookie',provenance:'human'},{postingAgent:'mcp:fake:v1',actorType:'agent'})).toEqual({actorType:'human',actorTokenJti:null,postingAgent:'human:person'});
});
