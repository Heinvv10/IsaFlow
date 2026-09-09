import {afterEach,beforeEach,expect,it} from 'vitest';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {transferControlFixture} from './bankTransferControlFixture';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeEach(async()=>{f=await transferControlFixture();});afterEach(async()=>{if(f)await f.close();});
it('prepares external transfer instructions without caller-supplied matching selection',async()=>{
 const bank=await f.bank(),prepared=await f.prepare(bank);
 expect(await f.saved(prepared.intentId)).toMatchObject({version:1,kind:'transfer',bankTransactionId:bank,counterpartyAccountId:f.to,transfer:{mode:'post',oppositeBankTransactionId:null}});
 expect((await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_bank_transfer'",[f.f.companyA])).rows).toHaveLength(0);
});

it.each(['-115.23','115.23'])('posts one journal with exact two bank legs for %s and retries one effect',async amount=>{
 const bank=await f.bank(f.from,amount),p=await f.prepare(bank),approvalId=await f.approve(p.operation);
 const result=await f.execute(p.intentId,approvalId);expect(result.paymentId).toBeNull();
 expect(await f.execute(p.intentId,approvalId)).toEqual(result);
 const journals=await f.journals();expect(journals).toEqual([{id:result.journalEntryId,source:'auto_bank_transfer',source_record_id:bank,status:'posted'}]);
 const lines=(await f.pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 ORDER BY gl_account_id',[f.f.companyA,result.journalEntryId])).rows;
 expect(lines).toHaveLength(2);
 const source=lines.find(row=>row.gl_account_id===f.from),other=lines.find(row=>row.gl_account_id===f.to);
 expect(Number(source.debit)-Number(source.credit)).toBe(Number(amount));expect(Number(other.debit)-Number(other.credit)).toBe(-Number(amount));
 expect((await f.banks())[0]).toMatchObject({id:bank,status:'allocated',allocation_type:'transfer',counterparty_account_id:f.to,transfer_journal_entry_id:result.journalEntryId});
 expect((await f.effects()).filter(e=>e.operation==='bank_allocation.post')).toHaveLength(1);
});
it('links an already imported opposite feed to the same posted journal',async()=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23'),p=await f.prepare(bank);
 expect((await f.saved(p.intentId)).transfer).toEqual({mode:'post',oppositeBankTransactionId:opposite});
 const result=await f.execute(p.intentId,await f.approve(p.operation)),banks=await f.banks();
 expect(banks).toHaveLength(2);for(const row of banks){expect(row.status).toBe('allocated');expect(row.transfer_journal_entry_id).toBe(result.journalEntryId);expect(row.matched_journal_line_id).toBeTruthy();}
 expect(new Set(banks.map(row=>row.matched_journal_line_id)).size).toBe(2);expect(await f.journals()).toHaveLength(1);
});
it('late opposite feed prepares a link to the original and never posts a second journal',async()=>{
 const bank=await f.bank(),p=await f.prepare(bank),original=await f.execute(p.intentId,await f.approve(p.operation));
 const opposite=await f.bank(f.to,'115.23'),link=await f.prepare(opposite,f.from);
 expect((await f.saved(link.intentId)).transfer).toEqual({mode:'link',originalIntentId:p.intentId});
 const linked=await f.execute(link.intentId,await f.approve(link.operation));expect(linked.journalEntryId).toBe(original.journalEntryId);
 expect(await f.journals()).toHaveLength(1);expect((await f.banks()).every(row=>row.status==='allocated')).toBe(true);
 expect(await f.execute(link.intentId)).toEqual(linked);
});
it.each(['source','opposite'])('refuses stale %s rows without publication',async changed=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23'),p=await f.prepare(bank),approvalId=await f.approve(p.operation);
 if(changed==='source')await f.pool.query('UPDATE bank_transactions SET amount=-120 WHERE company_id=$1 AND id=$2',[f.f.companyA,bank]);
 else await f.pool.query("UPDATE bank_transactions SET status='excluded' WHERE company_id=$1 AND id=$2",[f.f.companyA,opposite]);
 const before=await f.snapshot();await expect(f.execute(p.intentId,approvalId)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
it('refuses current posting permission revocation without consuming approved intent',async()=>{
 const p=await f.prepare(await f.bank()),approvalId=await f.approve(p.operation);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 const before=await f.snapshot();await expect(f.execute(p.intentId,approvalId)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
it('serializes opposite feed executions into at most one journal and two linked rows',async()=>{
 const bank=await f.bank(),opposite=await f.bank(f.to,'115.23'),a=await f.prepare(bank),b=await f.prepare(opposite,f.from,'u2');
 const aa=await f.approve(a.operation),bb=await f.approve(b.operation,'u2');
 const results=await Promise.allSettled([f.execute(a.intentId,aa),f.execute(b.intentId,bb,'u2')]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.journals()).toHaveLength(1);
 expect((await f.banks()).every(row=>row.status==='allocated')).toBe(true);
});
it('a second token does not turn the maker into an independent human approver',async()=>{
 const p=await f.prepare(await f.bank(),f.to,'u1',0);
 const approval=await f.actor(ctx=>requestOperationApproval(ctx,p.operation),'u1',0);
 await expect(f.actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u1',1)).rejects.toThrow(/human/);
 await expect(f.actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u1')).rejects.toThrow(/Self approval/);
 expect((await f.snapshot()).approvals).toEqual([{id:approval.id,status:'pending'}]);expect(await f.journals()).toHaveLength(0);
 await f.actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 expect((await f.snapshot()).approvals[0].status).toBe('approved');
});
