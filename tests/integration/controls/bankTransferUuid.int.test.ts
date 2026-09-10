import {afterAll,beforeAll,expect,it} from 'vitest';
import {transferControlFixture} from './bankTransferControlFixture';
import {prepareBankTransfer,executeBankTransfer} from '@/modules/accounting/services/bank/bankTransferPostingService';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeAll(async()=>{f=await transferControlFixture();},30000);
afterAll(async()=>{await f?.close();});
async function prepare(){
 return f.actor(()=>prepareBankTransfer(f.f.companyA,f.f.u1.id,{fromAccountId:f.from,toAccountId:f.to,amount:'10',transferDate:'2026-09-09'}));
}
function execute(id:string,approvalId?:string){return f.actor(()=>executeBankTransfer(f.f.companyA,f.f.u1.id,id,{approvalId}));}
async function population(id:string){
 const journals=(await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_bank_transfer' AND source_record_id=$2::uuid",[f.f.companyA,id])).rows;
 const totals=(await f.pool.query("SELECT COALESCE(sum(l.debit),0)::text AS debit,COALESCE(sum(l.credit),0)::text AS credit FROM gl_journal_lines l JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id WHERE j.company_id=$1 AND j.source='auto_bank_transfer' AND j.source_record_id=$2::uuid AND j.status='posted'",[f.f.companyA,id])).rows[0];
 const effects=(await f.pool.query("SELECT id,entity_id,result FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND operation='bank_transfer.post' AND lower(entity_id)=$2",[f.f.companyA,id])).rows;
 return{journals,totals,effects};
}
it('cannot post a transfer twice through an independently approved UUID case variant',async()=>{
 const prepared=await prepare(),approval=await f.approve(prepared.operation);
 const first=await execute(prepared.intentId,approval),upper=prepared.intentId.toUpperCase();
 expect(upper).not.toBe(prepared.intentId);
 const secondApproval=await f.approve({...prepared.operation,entityId:upper});
 let second:Awaited<ReturnType<typeof execute>>|undefined,refusal:unknown;
 try{second=await execute(upper,secondApproval);}catch(error){refusal=error;}
 if(second)expect(second).toEqual(first);else expect(refusal).toBeInstanceOf(Error);
 const saved=await population(prepared.intentId);
 expect(saved.journals).toEqual([{id:first.journalEntryId}]);expect(saved.effects).toHaveLength(1);
 expect(saved.totals).toEqual({debit:'10.00',credit:'10.00'});
});
it.each([false,true])('replays either UUID case after initial uppercase=%s execution without another approval',async uppercase=>{
 const prepared=await prepare(),approval=await f.approve(prepared.operation),upper=prepared.intentId.toUpperCase();
 const first=await execute(uppercase?upper:prepared.intentId,approval);
 expect(first.intentId).toBe(prepared.intentId);
 await expect(execute(prepared.intentId)).resolves.toEqual(first);
 await expect(execute(upper)).resolves.toEqual(first);
 const saved=await population(prepared.intentId);expect(saved.journals).toHaveLength(1);expect(saved.effects).toHaveLength(1);
 expect(saved.totals).toEqual({debit:'10.00',credit:'10.00'});
});
