import {afterEach,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {transferControlFixture} from './bankTransferControlFixture';
let f:Awaited<ReturnType<typeof transferControlFixture>>;
beforeEach(async()=>{f=await transferControlFixture();});afterEach(async()=>{if(f)await f.close();});
it.each(['post','link'])('rolls back %s bank publication, journals, effects and events even when caller catches',async mode=>{
 const bank=await f.bank(),original=await f.prepare(bank);
 if(mode==='link')await f.execute(original.intentId,await f.approve(original.operation));
 const target=mode==='link'?await f.bank(f.to,'115.23'):bank;
 const prepared=mode==='link'?await f.prepare(target,f.from):original,approvalId=await f.approve(prepared.operation);
 const before=await f.snapshot(),name='synthetic_transfer_'+randomUUID().replaceAll('-','');
 // The only rejected row is this fresh fixture's owned target; unrelated suites pass through.
 await f.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.company_id='${f.f.companyA}'::uuid AND NEW.id='${target}'::uuid AND NEW.status='allocated'
 THEN RAISE EXCEPTION 'Synthetic transfer publication fault'; END IF; RETURN NEW; END $$`);
 try{
  await f.pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try{
   const failure=await f.actor(async ctx=>{
    try{await executeBankAllocation(ctx,prepared.intentId,{approvalId});return null;}
    catch(error){return String(error);}
   });
   expect(failure).toContain('Synthetic transfer publication fault');
   expect(await f.snapshot()).toEqual(before);
  }finally{await f.pool.query(`DROP TRIGGER ${name} ON bank_transactions`);}
 }finally{await f.pool.query(`DROP FUNCTION public.${name}()`);}
 // Recovery on the same approved intent proves the failure did not consume it.
 const result=await f.execute(prepared.intentId,approvalId);expect(result.journalEntryId).toBeTruthy();
 expect(await f.journals()).toHaveLength(1);
});
