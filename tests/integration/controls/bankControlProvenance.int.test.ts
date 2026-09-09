import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankControlReadFixture} from './bankControlReadFixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {readBankControlState} from '@/modules/accounting/services/bank/bankControlReadService';
let f:Awaited<ReturnType<typeof bankControlReadFixture>>;
beforeAll(async()=>{f=await bankControlReadFixture();});afterAll(async()=>{if(f)await f.close();});
it('all owned journal lines participate in proof, including balanced foreign-account legs',async()=>{
 const p=await f.prepare(),approval_id=await f.approve(p.operation),posted=await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id});expect(posted.status).toBe(200);
 const foreign=randomUUID();await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic foreign control proof','expense','debit',true)",[foreign,f.fixture.companyB]);
 const client=await f.pool.connect(),user=f.fixture.u1,claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
 try{await client.query('BEGIN');
  await client.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,5,0),($1,$2,$3,0,5)',[user.companyId,posted.body.data.journalEntryId,foreign]);
  await client.query('SET LOCAL ROLE app_user');await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  await expect(withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>readBankControlState(requireControlTx(),{bankTransactionId:p.bankTransactionId}))).rejects.toThrow(/ownership|journal|provenance/i);
 }finally{await client.query('ROLLBACK');client.release();}
 expect((await f.read(p.bankTransactionId)).body.data.currentOriginalIntentId).toBe(p.intentId);
});
