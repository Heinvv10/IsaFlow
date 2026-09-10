import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bank39Fixture} from './bank39Fixture';
import {allocateTransaction,splitAllocateTransaction,reverseReconciledTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
let b:Awaited<ReturnType<typeof bank39Fixture>>;
beforeAll(async()=>{b=await bank39Fixture();});afterAll(async()=>{await b?.close();});
async function allocation(kind:'account'|'split'){
 const tx=await b.source(),p=await b.prepare({version:1,kind,bankTransactionId:tx,lines:[{accountId:b.expense,amount:'115',vatCode:'none'}]});
 const run=()=>kind==='split'?splitAllocateTransaction(b.f.companyA,tx,[{contraAccountId:b.expense,amount:115}],b.f.u1.id,{intentId:p.intentId,approvalId:p.approvalId}):allocateTransaction(b.f.companyA,tx,b.expense,b.f.u1.id,undefined,'account',undefined,undefined,undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId:p.approvalId});
 return{tx,p,run};
}
it('fresh allocation and approved inverse both clear a real prior batch reference',async()=>{
 const a=await allocation('account'),batch=randomUUID();
 await b.pool.query("INSERT INTO bank_allocation_batches(id,company_id,created_by,tool,line_count) VALUES($1,$2,$3,'BANK39 synthetic historical batch',1)",[batch,b.f.companyA,b.f.u1.id]);
 await b.pool.query('UPDATE bank_transactions SET allocation_batch_id=$1 WHERE company_id=$2 AND id=$3',[batch,b.f.companyA,a.tx]);
 await b.actor(a.run);
 expect((await b.pool.query('SELECT allocation_batch_id FROM bank_transactions WHERE company_id=$1 AND id=$2',[b.f.companyA,a.tx])).rows[0].allocation_batch_id).toBeNull();
 await b.pool.query('UPDATE bank_transactions SET allocation_batch_id=$1 WHERE company_id=$2 AND id=$3',[batch,b.f.companyA,a.tx]);
 const reverse=await b.actor(ctx=>prepareBankAllocationReversal(ctx,{originalIntentId:a.p.intentId,reversalDate:'2026-04-01',reason:'BANK39 batch correction'})),approvalId=await b.approve(reverse.operation);
 await b.actor(()=>reverseReconciledTransaction(b.f.companyA,a.tx,b.f.u1.id,{intentId:reverse.intentId,approvalId,reversalDate:'2026-04-01'}));
 expect((await b.pool.query('SELECT status,matched_journal_line_id,allocation_batch_id FROM bank_transactions WHERE company_id=$1 AND id=$2',[b.f.companyA,a.tx])).rows).toEqual([{status:'imported',matched_journal_line_id:null,allocation_batch_id:null}]);
});
for(const kind of ['account','split','inverse'] as const)it(`${kind}: actual adapter blocks on the owned bank row held by another session`,async()=>{
 const a=await allocation(kind==='split'?'split':'account');let run:()=>Promise<unknown>=a.run;
 if(kind==='inverse'){
  await b.actor(a.run);
  const reverse=await b.actor(ctx=>prepareBankAllocationReversal(ctx,{originalIntentId:a.p.intentId,reversalDate:'2026-04-01',reason:'BANK39 lock correction'})),approvalId=await b.approve(reverse.operation);
  // Normalize the result only for a common callback type; the actual inverse is executed.
  run=async()=>{const r=await reverseReconciledTransaction(b.f.companyA,a.tx,b.f.u1.id,{intentId:reverse.intentId,approvalId,reversalDate:'2026-04-01'});return{journalEntryId:r.reversalJournalEntryId};};
 }
 const blocker=await b.pool.connect();let pending:Promise<unknown>|undefined;
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM bank_transactions WHERE company_id=$1 AND id=$2 FOR UPDATE',[b.f.companyA,a.tx]);
  let announce!:(pid:number)=>void;const started=new Promise<number>(resolve=>{announce=resolve;});
  pending=b.actor(async ctx=>{const rows=await ctx.sql`SELECT pg_backend_pid() AS pid` as {pid:number}[];announce(rows[0]!.pid);return run();});
  const pid=await started;let blocked=false;
  for(let attempt=0;attempt<100&&!blocked;attempt++){
   blocked=(await b.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
   if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(blocked).toBe(true);
  await blocker.query('ROLLBACK');await pending;
 }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined);}
});
