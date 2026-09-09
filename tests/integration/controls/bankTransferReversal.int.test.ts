import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {transferReversalFixture} from './bankTransferReversalFixture';
import {executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
let f:Awaited<ReturnType<typeof transferReversalFixture>>;
beforeEach(async()=>{f=await transferReversalFixture();});afterEach(async()=>{if(f)await f.close();});
it('prepares an inverse of a real approved transfer post',async()=>{
 const p=await f.posted();const inverse=await f.prepareInverse(p.intent.intentId);
 expect(await f.reversalIntent(inverse.intentId)).toMatchObject({original_intent_id:p.intent.intentId,bank_transaction_id:p.bank});
 expect(await f.journalRows()).toHaveLength(1);
});
for(const amount of ['-115.23','115.23'])it(`reverses ${amount} with exact contra, both saved bank resets and one retry effect`,async()=>{
 const p=await f.posted(amount),before=await f.lineRows(p.effect.journalEntryId),inverse=await f.prepareInverse(p.intent.intentId),approval=await f.approve(inverse.operation);
 const result=await f.executeInverse(inverse.intentId,approval),journals=await f.journalRows();
 expect(journals).toHaveLength(2);expect(journals.find(j=>j.id===p.effect.journalEntryId)?.reversed_at).toBeTruthy();
 const contra=journals.find(j=>j.reversal_of_id===p.effect.journalEntryId)!;expect(contra.entry_date).toBe('2026-09-10');
 expect(await f.lineRows(contra.id)).toEqual(before.map(l=>({...l,debit:l.credit,credit:l.debit})));
 for(const bank of await f.banks())expect(bank).toMatchObject({status:'imported',matched_journal_line_id:null,transfer_journal_entry_id:null,counterparty_account_id:null,allocation_type:null});
 expect(await f.executeInverse(inverse.intentId,approval)).toEqual(result);
 expect((await f.effects()).filter(e=>e.operation==='bank_allocation.reverse')).toHaveLength(1);expect(await f.journalRows()).toHaveLength(2);
 expect((await f.effects()).find(e=>e.operation==='bank_allocation.post')?.result).toEqual(p.effect);
});
it('canonicalizes a late link intent to its original and leaves later unlinked arrivals untouched',async()=>{
 const p=await f.posted('-115.23',false),late=await f.bank(f.to,'115.23'),link=await f.prepare(late,f.from);
 await f.execute(link.intentId,await f.approve(link.operation));const extra=await f.bank(f.to,'115.23');
 const untouched=(await f.banks()).find(b=>b.id===extra),inverse=await f.prepareInverse(link.intentId);
 expect((await f.reversalIntent(inverse.intentId)).original_intent_id).toBe(p.intent.intentId);
 await f.executeInverse(inverse.intentId,await f.approve(inverse.operation));
 expect(await f.journalRows()).toHaveLength(2);
 expect((await f.banks()).find(b=>b.id===extra)).toEqual(untouched);
 for(const id of [p.bank,late])expect((await f.banks()).find(b=>b.id===id)).toMatchObject({status:'imported',matched_journal_line_id:null,transfer_journal_entry_id:null,counterparty_account_id:null});
});
it('reverses a single-feed post without selecting a later matching arrival',async()=>{
 const p=await f.posted('-115.23',false),late=await f.bank(f.to,'115.23'),before=(await f.banks()).find(b=>b.id===late);
 const inverse=await f.prepareInverse(p.intent.intentId);await f.executeInverse(inverse.intentId,await f.approve(inverse.operation));
 expect((await f.banks()).find(b=>b.id===late)).toEqual(before);expect(await f.journalRows()).toHaveLength(2);
});
for(const mutation of ['source','opposite','journal','permission'] as const)it(`refuses stale ${mutation} without effect`,async()=>{
 const p=await f.posted(),inverse=await f.prepareInverse(p.intent.intentId),approval=await f.approve(inverse.operation);
 if(mutation==='permission')await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 else if(mutation==='journal')await f.pool.query('UPDATE gl_journal_lines SET debit=CASE WHEN debit>0 THEN 110 ELSE 0 END,credit=CASE WHEN credit>0 THEN 110 ELSE 0 END WHERE company_id=$1 AND journal_entry_id=$2',[f.f.companyA,p.effect.journalEntryId]);
 else await f.pool.query('UPDATE bank_transactions SET amount=amount+1 WHERE company_id=$1 AND id=$2',[f.f.companyA,mutation==='source'?p.bank:p.opposite]);
 const before=await f.snapshot();await expect(f.executeInverse(inverse.intentId,approval)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
});
it('allows at most one of two independently approved concurrent inverses',async()=>{
 const p=await f.posted(),a=await f.prepareInverse(p.intent.intentId),b=await f.prepareInverse(p.intent.intentId,'u2');
 const aa=await f.approve(a.operation),ab=await f.approve(b.operation,'u2');
 const outcomes=await Promise.allSettled([f.executeInverse(a.intentId,aa),f.executeInverse(b.intentId,ab,'u2')]);
 expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);expect(await f.journalRows()).toHaveLength(2);
 expect((await f.effects()).filter(e=>e.operation==='bank_allocation.reverse')).toHaveLength(1);
});
it('rolls back journal, both banks, approval and protected history on a reset failure caught inside the transaction',async()=>{
 const p=await f.posted(),inverse=await f.prepareInverse(p.intent.intentId),approval=await f.approve(inverse.operation),suffix=randomUUID().replaceAll('-','');
 const trigger=`synthetic_transfer_inverse_${suffix}`,fn=`synthetic_transfer_inverse_fn_${suffix}`;
 // Only generated safe identifiers and UUID literals enter this synthetic fixture DDL.
 await f.pool.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.id='${p.opposite}'::uuid AND NEW.status='imported' THEN RAISE EXCEPTION 'Synthetic transfer inverse reset failure'; END IF; RETURN NEW; END $$`);
 await f.pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
 try{
  const before=await f.snapshot();
  await f.actor(async ctx=>{await expect(executeBankAllocationReversal(ctx,inverse.intentId,{approvalId:approval})).rejects.toThrow('Synthetic transfer inverse reset failure');});
  expect(await f.snapshot()).toEqual(before);
 }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON bank_transactions`);await f.pool.query(`DROP FUNCTION IF EXISTS public.${fn}()`);}
 await f.executeInverse(inverse.intentId,approval);expect(await f.journalRows()).toHaveLength(2);
});
