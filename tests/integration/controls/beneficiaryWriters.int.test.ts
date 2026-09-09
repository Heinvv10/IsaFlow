import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { NextApiRequest,NextApiResponse } from 'next';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture,validateFixtureTarget,type ForensicFixture } from '../forensic-fixture';
import { withControlRequest,requireControlTx } from '../../../src/modules/accounting/services/controls/context';
import { createSupplier,updateSupplier } from '../../../src/modules/accounting/services/core/supplierWriteService';
import { importSuppliers } from '../../../src/modules/accounting/services/core/migrationContactService';
import { mergeEntities } from '../../../src/modules/accounting/services/core/duplicateMergeService';
import { verifyBeneficiaryChange } from '../../../src/modules/accounting/services/controls/beneficiaryService';
import type { ControlTx } from '../../../src/modules/accounting/services/controls/contracts';
import supplierHandler from '../../../pages/api/accounting/suppliers-list';
import mergeHandler from '../../../pages/api/accounting/supplier-merge';
// Admission is supplied by the real synthetic authenticated transaction below; business handlers are unchanged.
vi.mock('@/lib/auth',()=>({withAuth:(h:unknown)=>h,withWriteAccess:(h:unknown)=>h}));
vi.mock('@/lib/auth/withCsrf',()=>({withCsrf:(h:unknown)=>h}));
vi.mock('@/lib/api-error-handler',()=>({withErrorHandler:(h:unknown)=>h}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
process.env.ENCRYPTION_KEY='synthetic-beneficiary-encryption-key-only';
process.env.CONTROL_FINGERPRINT_KEY='synthetic-beneficiary-fingerprint-key-only';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:4,statement_timeout:7000});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(async()=>{await pool.end();});
const bank={bankName:'Synthetic bank',bankAccountNumber:'00987654321',bankBranchCode:'001234',bankAccountType:'cheque'};
const oldBank='00123456789';
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,pat=false,person?:string):Promise<T>{
 const client=await pool.connect(),personId=person??fixture.u1.id,companyId=fixture.companyA;
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:personId,company_id:companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),companyId]);
  const token=pat?fixture.u1.tokens[0]:null;
  const result=await withControlRequest({client,userId:personId,companyId,claims},
   {personId,companyId,authMethod:token?'pat':'cookie',connectionId:token?.id,grantId:token?.id,
    grantedScopes:token?['write:contacts','write:beneficiaries']:null},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function legacy(name=`Synthetic legacy ${randomUUID()}`){
 const id=randomUUID();
 await pool.query(`INSERT INTO suppliers(id,company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type)
  VALUES($1,$2,$3,'Synthetic bank',$4,'001234','cheque')`,[id,fixture.companyA,name,oldBank]);return id;
}
async function stored(id:string){return(await pool.query('SELECT * FROM suppliers WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0];}
function response(){
 const state:{code:number;body:unknown}={code:0,body:null};
 const res={status:(code:number)=>{state.code=code;return res;},json:(body:unknown)=>{state.body=body;return res;},setHeader:vi.fn()};
 return{state,res:res as unknown as NextApiResponse};
}
it('banking create commits bankless contact, encrypted pending proposal and both material events',async()=>{
 const result=await actor(()=>createSupplier(fixture.companyA,{name:'Synthetic pending new',...bank}));
 const row=await stored(String(result.id));expect(row.bank_account_number).toBeNull();expect(result.bank_account_number).toBeUndefined();
 const review=result.beneficiary_review as {proposalId:string;status:string};expect(review.status).toBe('pending');
 const proposal=(await pool.query('SELECT * FROM control_beneficiary_proposals WHERE company_id=$1 AND id=$2',[fixture.companyA,review.proposalId])).rows[0];
 expect(proposal.evidence_refs).toEqual([]);expect(JSON.stringify(proposal)).not.toContain(bank.bankAccountNumber);
 await expect(actor(ctx=>verifyBeneficiaryChange(ctx,review.proposalId,[]),false,fixture.u2.id)).rejects.toThrow('EVIDENCE_REQUIRED');
 expect((await stored(String(result.id))).bank_account_number).toBeNull();
 const events=await pool.query('SELECT after_values FROM control_change_events WHERE company_id=$1 AND entity_id=ANY($2::text[])',[fixture.companyA,[String(result.id),review.proposalId]]);
 expect(events.rows).toHaveLength(2);expect(JSON.stringify(events.rows)).not.toContain(bank.bankAccountNumber);
});
it('contact-only grant preserves unchanged bank fields; changed banking refuses the complete contact save',async()=>{
 const id=await legacy(),token=fixture.u1.tokens[0]!;
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:contacts'] WHERE company_id=$1 AND id=$2",[fixture.companyA,token.id]);
 await actor(()=>updateSupplier(fixture.companyA,id,{name:'Allowed contact',bankAccountNumber:oldBank}),true);
 await expect(actor(()=>updateSupplier(fixture.companyA,id,{name:'Must rollback',...bank}),true)).rejects.toThrow('permissions');
 expect((await stored(id)).name).toBe('Allowed contact');expect((await stored(id)).bank_account_number).toBe(oldBank);
 const count=await pool.query('SELECT id FROM control_beneficiary_proposals WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,id]);expect(count.rows).toHaveLength(0);
});
it('import overwrite and creation use proposals, and unauthorized later row rolls the entire import back',async()=>{
 const name=`Import existing ${randomUUID()}`,id=await legacy(name),session=randomUUID();
 await pool.query("INSERT INTO migration_sessions(id,company_id,source_system,started_by) VALUES($1,$2,'csv',$3)",[session,fixture.companyA,fixture.u1.id]);
 const result=await actor(()=>importSuppliers(fixture.companyA,session,[{name,billingAddress:'Synthetic migration billing',...bank},{name:`New import ${randomUUID()}`,...bank}],'overwrite'));
 expect(result.imported).toBe(2);expect(result.beneficiaryReviews).toHaveLength(2);expect((await stored(id)).bank_account_number).toBe(oldBank);
 expect((await stored(id)).address).toBe('Synthetic migration billing');
 await pool.query("UPDATE personal_access_tokens SET scopes=ARRAY['write:contacts'] WHERE company_id=$1 AND id=$2",[fixture.companyA,fixture.u1.tokens[0]!.id]);
 const deniedName=`Denied import ${randomUUID()}`;
 await expect(actor(()=>importSuppliers(fixture.companyA,session,[{name:deniedName},{name:`Unauthorized ${randomUUID()}`,...bank}],'overwrite'),true)).rejects.toThrow('permissions');
 expect((await pool.query('SELECT id FROM suppliers WHERE company_id=$1 AND name=$2',[fixture.companyA,deniedName])).rows).toHaveLength(0);
});
it.each(['approved','processed'])('merge service and actual REST handler preserve %s payment identity',async status=>{
 const source=await legacy(),dest=await legacy(),payment=randomUUID();
 await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,created_by)
  VALUES($1,$2,$3,CURRENT_DATE,100,$4,$5)`,[payment,fixture.companyA,source,status,fixture.u1.id]);
 await expect(actor(()=>mergeEntities(fixture.companyA,'supplier',dest,source,fixture.u1.id))).rejects.toThrow('SUPPLIER_MERGE_REQUIRES_REVIEW');
 const{state,res}=response();
 await expect(actor(async()=>{await mergeHandler({method:'POST',body:{source_id:source,target_id:dest},companyId:fixture.companyA} as unknown as NextApiRequest,res);})).rejects.toThrow('evidence');
 expect(state.code).toBe(400);expect(JSON.stringify(state.body)).toContain('SUPPLIER_MERGE_REQUIRES_REVIEW');
 expect((await pool.query('SELECT supplier_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,payment])).rows[0].supplier_id).toBe(source);
 expect((await stored(source)).deleted_at).toBeNull();
});
it('unreferenced contact merge succeeds and increments only the changed contact material version',async()=>{
 const a=await actor(()=>createSupplier(fixture.companyA,{name:`Empty source ${randomUUID()}`}));
 const b=await actor(()=>createSupplier(fixture.companyA,{name:`Empty target ${randomUUID()}`}));
 await actor(()=>mergeEntities(fixture.companyA,'supplier',String(b.id),String(a.id),fixture.u1.id));
 expect((await stored(String(a.id))).deleted_at).toBeInstanceOf(Date);expect((await stored(String(b.id))).is_active).toBe(true);
 const version=await pool.query("SELECT version FROM control_entity_versions WHERE company_id=$1 AND entity_type='supplier' AND entity_id=$2",[fixture.companyA,String(a.id)]);
 expect(Number(version.rows[0].version)).toBe(2);
});
it('actual supplier REST creation exposes pending review metadata and no active banking',async()=>{
 const{state,res}=response();
 await actor(async()=>{await supplierHandler({method:'POST',body:{name:`REST pending ${randomUUID()}`,bank_name:bank.bankName,
  bank_account_number:bank.bankAccountNumber,bank_branch_code:bank.bankBranchCode,bank_account_type:bank.bankAccountType},companyId:fixture.companyA} as unknown as NextApiRequest,res);});
 expect(state.code).toBe(200);expect(JSON.stringify(state.body)).toContain('pending');expect(JSON.stringify(state.body)).not.toContain(bank.bankAccountNumber);
});
it('bank proposal versus empty merge serializes so only one can change the source state',async()=>{
 const source=await legacy(),dest=await legacy();
 const outcomes=await Promise.allSettled([
  actor(()=>updateSupplier(fixture.companyA,source,bank)),
  actor(()=>mergeEntities(fixture.companyA,'supplier',dest,source,fixture.u2.id),false,fixture.u2.id),
 ]);
 // A merge-first update returns not found; a proposal-first merge must refuse its hold.
 const row=await stored(source),proposals=await pool.query("SELECT id FROM control_beneficiary_proposals WHERE company_id=$1 AND entity_id=$2 AND status='pending'",[fixture.companyA,source]);
 expect(row.bank_account_number).toBe(oldBank);
 expect(row.deleted_at!==null && proposals.rows.length>0).toBe(false);
 expect(outcomes.some(o=>o.status==='fulfilled')).toBe(true);
});

it('an approval source binding blocks merge even before any payment exists',async()=>{
 const source=await legacy(),dest=await legacy();
 const binding={beneficiaries:[],sourceVersions:[{entityType:'supplier',entityId:source,version:1,fingerprint:'synthetic'}]};
 await pool.query(`INSERT INTO control_operation_approvals(company_id,operation_id,operation,entity_type,entity_id,
  requester_person_id,binding,binding_hash,status,expires_at,requester_auth_method)
  VALUES($1,$2,'supplier_payment.process','supplier_payment',$3,$4,$5::jsonb,$6,'pending',clock_timestamp()+interval '1 day','cookie')`,
  [fixture.companyA,randomUUID(),randomUUID(),fixture.u1.id,JSON.stringify(binding),'a'.repeat(64)]);
 await expect(actor(()=>mergeEntities(fixture.companyA,'supplier',dest,source,fixture.u1.id))).rejects.toThrow('SUPPLIER_MERGE_REQUIRES_REVIEW');
 expect((await stored(source)).deleted_at).toBeNull();
});
it.each(['purchase_order','supplier_credit_note'])('preserves a supplier with only a standalone %s dependency',async kind=>{
 const source=await legacy(),dest=await legacy(),document=randomUUID();
 if(kind==='purchase_order'){
  await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status,created_by)
   VALUES($1,$2,$3,$4,'approved',$5)`,[document,fixture.companyA,`SYN-${document}`,source,fixture.u1.id]);
  await pool.query(`INSERT INTO goods_received_notes(company_id,grn_number,purchase_order_id,received_by)
   VALUES($1,$2,$3,$4)`,[fixture.companyA,`SYN-GRN-${document}`,document,fixture.u1.id]);
 }else{
  await pool.query(`INSERT INTO credit_notes(id,company_id,type,supplier_id,supplier_invoice_id,credit_date,status,created_by)
   VALUES($1,$2,'supplier',$3,NULL,CURRENT_DATE,'approved',$4)`,[document,fixture.companyA,source,fixture.u1.id]);
 }
 await expect(actor(()=>mergeEntities(fixture.companyA,'supplier',dest,source,fixture.u1.id))).rejects.toThrow('SUPPLIER_MERGE_REQUIRES_REVIEW');
 expect((await stored(source)).deleted_at).toBeNull();expect((await stored(dest)).deleted_at).toBeNull();
 const row=kind==='purchase_order'
  ?await pool.query('SELECT supplier_id FROM purchase_orders WHERE company_id=$1 AND id=$2',[fixture.companyA,document])
  :await pool.query('SELECT supplier_id,supplier_invoice_id FROM credit_notes WHERE company_id=$1 AND id=$2',[fixture.companyA,document]);
 expect(row.rows[0].supplier_id).toBe(source);
 if(kind==='supplier_credit_note')expect(row.rows[0].supplier_invoice_id).toBeNull();
});
