import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {loadOwnedBankAttachmentEvidence} from '@/modules/accounting/services/controls/bankAttachmentEvidenceSource';
import {addBankTxAttachment} from '@/modules/accounting/services/bank/bankTxAttachmentService';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const bytes=Buffer.from('%PDF-1.7\nSynthetic local bank receipt');
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function source(options:{foreign?:boolean;deny?:boolean;url?:string;cancel?:boolean;missing?:boolean}={}){
 const client=await pool.connect(),bank=randomUUID(),account=randomUUID(),attachment=randomUUID();
 try{
  await client.query('BEGIN');
  await client.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[fixture.companyB,fixture.u1.id]);
  const company=options.foreign?fixture.companyB:fixture.companyA;
  await client.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank','asset','debit',3,true)",[account,company]);
  await client.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount) VALUES($1,$2,$3,'2026-09-09',100)",[bank,company,account]);
  if(options.foreign||options.url)await client.query('INSERT INTO bank_transaction_attachments(id,bank_transaction_id,file_url,file_size) VALUES($1,$2,$3,$4)',[attachment,bank,options.url??`data:application/pdf;base64,${bytes.toString('base64')}`,bytes.length]);
  if(options.deny)await client.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',false,false) ON CONFLICT(company_id,user_id,module_key) DO UPDATE SET can_read=false,can_write=false",[fixture.companyA,fixture.u1.id]);
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  return await withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},
   {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},async()=>{
    let id=attachment;
    if(!options.foreign&&!options.url&&!options.missing){
     const result=await addBankTxAttachment(fixture.companyA,{bankTransactionId:bank,fileName:'synthetic.pdf',mimeType:'application/pdf',bytes,maxBytes:2*1024*1024,uploadedBy:fixture.u1.id});
     if(!result.ok)throw new Error('Synthetic attachment upload failed');id=result.attachment.id;
    }
    const controller=new AbortController();if(options.cancel)controller.abort(new Error('Capture cancelled'));
    return loadOwnedBankAttachmentEvidence(requireControlTx(),id,controller.signal);
   });
 }finally{await client.query('ROLLBACK');client.release();}
}
it('retains actual shared-writer bytes with computed hash and explicit historical unknown',async()=>{
 const result=await source();expect(result).toMatchObject({status:'available',sha256:createHash('sha256').update(bytes).digest('hex'),recordedHashVerified:false,mediaType:'application/pdf'});
 if(result?.status==='available')expect(Buffer.from(result.bytes)).toEqual(bytes);
});
it('does not expose a foreign bank attachment even for a dual-member user',async()=>{expect(await source({foreign:true})).toBeNull();});
it('enforces current bank read permissions',async()=>{await expect(source({deny:true})).rejects.toThrow(/permission|scope|denied/i);});
it('returns explicit unsupported source for historical external URLs without fetching them',async()=>{
 expect(await source({url:'http://127.0.0.1:1/untrusted-source'})).toMatchObject({status:'unavailable',reason:'unsupported_attachment_source'});
});
it('distinguishes missing source and honours capture cancellation',async()=>{
 expect(await source({missing:true})).toBeNull();await expect(source({cancel:true})).rejects.toThrow('Capture cancelled');
});
