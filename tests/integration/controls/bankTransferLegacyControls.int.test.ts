import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferReversalFixture} from './bankTransferReversalFixture';
import {autoLinkImportedBatchTransfers,relinkTransferCounterparts} from '@/modules/accounting/services/bank/bankTransferLinkService';
import {autoLinkCounterpartyTransfer} from '@/modules/accounting/services/bank/bankTransferAutoLink';
import {allocateTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
let f:Awaited<ReturnType<typeof transferReversalFixture>>;
beforeEach(async()=>{f=await transferReversalFixture();});afterEach(async()=>{if(f)await f.close();});
for(const mode of ['import','relink'] as const)it(`${mode} retains an unapproved counterpart and exposes the saved approval work`,async()=>{
 const posted=await f.posted('-115.23',false),late=await f.bank(f.to,'115.23'),batch=randomUUID();
 await f.pool.query('UPDATE bank_transactions SET import_batch_id=$1 WHERE company_id=$2 AND id=$3',[batch,f.f.companyA,late]);
 const before=await f.snapshot();
 const result=await f.actor(()=>mode==='import'?autoLinkImportedBatchTransfers(f.f.companyA,batch):relinkTransferCounterparts(f.f.companyA,f.to));
 expect(result).toMatchObject({linked:0,failed:false});
 expect((await f.banks()).find(b=>b.id===late)).toMatchObject({status:'imported',matched_journal_line_id:null});
 expect(await f.journals()).toEqual(before.journals.map(({reversed_at:_r,reversal_of_id:_o,entry_date:_d,...j})=>j));
 expect((await f.effects()).filter(e=>e.operation==='bank_allocation.post')).toHaveLength(1);
 const pending=(result as unknown as {pending:Array<{bankTransactionId:string;intentId:string;approvalId:string}>}).pending;
 expect(pending).toHaveLength(1);expect(pending[0]?.bankTransactionId).toBe(late);
 expect(await f.saved(pending[0]!.intentId)).toMatchObject({kind:'transfer',transfer:{mode:'link',originalIntentId:posted.intent.intentId}});
 const {decideOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
 await f.actor(ctx=>decideOperationApproval(ctx,pending[0]!.approvalId,'approved'),'u2');
 await f.execute(pending[0]!.intentId,pending[0]!.approvalId);
 expect(await f.journals()).toHaveLength(1);expect((await f.banks()).find(b=>b.id===late)?.status).toBe('allocated');
});
it('legacy transfer allocation executes the same pre-approved saved intent',async()=>{
 const bank=await f.bank(),intent=await f.prepare(bank),approval=await f.approve(intent.operation);
 const result=await f.actor(()=>allocateTransaction(f.f.companyA,bank,f.to,f.f.u1.id,undefined,'transfer',undefined,undefined,undefined,undefined,undefined,undefined,{intentId:intent.intentId,approvalId:approval}));
 expect(result.bankTransaction.status).toBe('allocated');expect(await f.journals()).toHaveLength(1);
 expect((await f.effects()).filter(e=>e.operation==='bank_allocation.post')).toHaveLength(1);
});

it('repeated relink reuses the same pending instruction and approval',async()=>{
 await f.posted('-115.23',false);await f.bank(f.to,'115.23');
 const first=await f.actor(()=>relinkTransferCounterparts(f.f.companyA,f.to));
 const second=await f.actor(()=>relinkTransferCounterparts(f.f.companyA,f.to));
 expect(first.pending).toHaveLength(1);expect(second.pending).toEqual(first.pending);expect(await f.journals()).toHaveLength(1);
});
it('legacy direct auto-link also returns pending control work without mutating the opposite feed',async()=>{
 const p=await f.posted('-115.23',false),late=await f.bank(f.to,'115.23');
 const result=await f.actor(()=>autoLinkCounterpartyTransfer({companyId:f.f.companyA,bankTxId:p.bank,bankAccountId:f.from,counterpartyAccountId:f.to,
  journalEntryId:p.effect.journalEntryId,amount:-115.23,txDate:'2026-09-09',allocatedEntityName:null}));
 expect(result).toMatchObject({linked:0,failed:false});expect(result.pending).toHaveLength(1);
 expect((await f.banks()).find(b=>b.id===late)?.status).toBe('imported');
});
it('unresolved legacy journal provenance is reported and never turned into a second transfer',async()=>{
 const p=await f.posted('-115.23',false);await f.bank(f.to,'115.23');
 await f.pool.query("UPDATE gl_journal_entries SET source='auto_bank_recon' WHERE company_id=$1 AND id=$2",[f.f.companyA,p.effect.journalEntryId]);
 const before=await f.snapshot(),result=await f.actor(()=>relinkTransferCounterparts(f.f.companyA,f.to));
 expect(result).toMatchObject({linked:0,failed:true,pending:[]});expect(await f.snapshot()).toEqual(before);
});
