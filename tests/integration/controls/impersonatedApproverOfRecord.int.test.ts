import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import type {NextApiRequest,NextApiResponse} from 'next';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {mintImpersonationProof} from '@/lib/auth/impersonationAssurance';
import {IMPERSONATION_PROOF_COOKIE} from '@/lib/auth/impersonation-cookies';
import {ACCESS_COOKIE,ACTIVE_COMPANY_COOKIE} from '@/lib/auth/cookies';
import supplierInvoiceRoute from '../../../pages/api/accounting/supplier-invoices-action';
import creditNoteRoute from '../../../pages/api/accounting/credit-notes-action';
import writeOffRoute from '../../../pages/api/accounting/write-offs-action';
import vatAdjustmentRoute from '../../../pages/api/accounting/vat-adjustments-action';
import expenseClaimRoute from '../../../pages/api/accounting/expense-claims/[id]/approve';
import commentaryRoute from '../../../pages/api/accounting/commentary/[id]/approve';
import commentaryRejectRoute from '../../../pages/api/accounting/commentary/[id]/reject';
import customerInvoiceRoute from '../../../pages/api/accounting/customer-invoices-detail';
import {generateDrafts} from '@/modules/accounting/services/commentary/commentaryService';
import type {CommentaryPackData} from '@/modules/accounting/services/commentary/commentaryDraft';

const csrf='approver-of-record-csrf-01234567890123456';
type Route=(req:NextApiRequest,res:NextApiResponse)=>Promise<unknown>|unknown;
function response(){
 const headers=new Map<string,unknown>();
 return {statusCode:200,body:undefined as unknown,headersSent:false,finished:false,
  status(code:number){this.statusCode=code;return this;},
  setHeader(name:string,value:unknown){headers.set(name.toLowerCase(),value);return this;},
  getHeader(name:string){return headers.get(name.toLowerCase());},
  json(body:unknown){this.body=body;return this.end();},
  end(){this.headersSent=true;this.finished=true;return this;}};
}
async function post(route:Route,url:string,body:unknown,cookies:Record<string,string>,query:Record<string,string>={}){
 const jar={...cookies,isaflow_csrf:csrf};
 const req={method:'POST',url,query,cookies:jar,body,
  headers:{cookie:Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; '),'x-csrf-token':csrf},
  socket:{remoteAddress:'127.0.0.92'}} as unknown as NextApiRequest;
 const res=response();
 await route(req,res as unknown as NextApiResponse);
 return {status:res.statusCode,body:res.body as {success?:boolean;message?:string;error?:{message?:string;details?:unknown};data?:unknown}};
}

describe('approver-of-record workflows under an actual impersonated session',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 let target:string,customer:string,employee:string;
 const secret=randomBytes(32).toString('hex');
 const session=(person:string,sessionId:string,aal:'aal1'|'aal2')=>
  new SignJWT({sub:person,session_id:sessionId,aal,role:'authenticated',aud:'authenticated',email:`${person}@forensic.invalid`})
   .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 /** A live impersonation: the stash row the admin route writes, plus its cookies. */
 async function impersonated(){
  const sessionId=`impersonation-${randomUUID()}`,now=Math.floor(Date.now()/1000);
  const stashId=(await h.pool.query(`INSERT INTO admin_impersonation_stash(admin_user_id,admin_access_token,admin_refresh_token,target_user_id,expires_at)
   VALUES($1,'ciphertext','ciphertext',$2,NOW()+interval '1 hour') RETURNING stash_id`,[h.admin,target])).rows[0].stash_id;
  return {[ACCESS_COOKIE]:await session(target,sessionId,'aal1'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA,
   [IMPERSONATION_PROOF_COOKIE]:await mintImpersonationProof({actorUserId:h.admin,targetUserId:target,
    targetSessionId:sessionId,stashId,actorExpiresAt:now+3600,stashExpiresAt:now+3600})};
 }
 const ordinary=async()=>({[ACCESS_COOKIE]:await session(target,`ordinary-${randomUUID()}`,'aal2'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA});
 const REFUSAL='An impersonated session cannot record an independent review';
 /** These routes mask the cause in production; development detail is the only way to prove WHICH refusal fired. */
 async function refusedWithDetail(route:Route,url:string,body:unknown,query:Record<string,string>={}){
  vi.stubEnv('NODE_ENV','development');
  try{return await post(route,url,body,await impersonated(),query);}finally{vi.unstubAllEnvs();}
 }
 const state=async(table:string,id:string)=>(await h.pool.query(
  `SELECT status::text,approved_by::text FROM ${table} WHERE company_id=$1 AND id=$2`,[h.f.companyA,id])).rows[0];

 beforeAll(async()=>{
  h=await platformImportApprovalFixture();target=h.f.u2.id;
  process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;
  process.env.JWT_SECRET=secret;process.env.SENTRY_ENABLED='false';
  customer=randomUUID();employee=randomUUID();
  await h.pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Approver of record customer')",[customer,h.f.companyA]);
  await h.pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date)
   VALUES($1,$2,$3,'Approver','Record','2023-01-01')`,[employee,h.f.companyA,`AOR-${employee.slice(0,8)}`]);
  await h.pool.query("UPDATE companies SET vat_period='2_monthly',vat_system_type='invoice' WHERE id=$1",[h.f.companyA]);
 },40000);
 afterAll(async()=>{await h?.close();});

 it('refuses a supplier invoice approval recorded through an impersonated session',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,subtotal,tax_amount,total_amount,status,created_by)
   VALUES($1,$2,$3,$4,'2024-03-01',1000,150,1150,'draft',$5)`,[id,h.f.companyA,`AOR-SI-${id.slice(0,8)}`,h.supplier,h.f.u1.id]);
  const refused=await post(supplierInvoiceRoute as Route,'/api/accounting/supplier-invoices-action',{action:'approve',invoiceId:id},await impersonated());
  expect(refused.status).toBe(400);
  expect(refused.body.error?.message).toBe(REFUSAL);
  expect(await state('supplier_invoices',id)).toEqual({status:'draft',approved_by:null});
 });

 it('refuses a credit note approval recorded through an impersonated session',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO credit_notes(id,company_id,credit_note_number,type,client_id,credit_date,subtotal,tax_amount,total_amount,status,created_by)
   VALUES($1,$2,$3,'customer',$4,'2024-03-01',1000,150,1150,'draft',$5)`,[id,h.f.companyA,`AOR-CN-${id.slice(0,8)}`,customer,h.f.u1.id]);
  const refused=await post(creditNoteRoute as Route,'/api/accounting/credit-notes-action',{action:'approve',creditNoteId:id},await impersonated());
  expect(refused.status).toBe(400);
  expect(refused.body.error?.message).toBe(REFUSAL);
  expect(await state('credit_notes',id)).toEqual({status:'draft',approved_by:null});
 });

 it('refuses a customer write-off approval recorded through an impersonated session',async()=>{
  const invoice=randomUUID(),id=randomUUID();
  await h.pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,created_by,invoice_date,subtotal,tax_amount,total_amount)
   VALUES($1,$2,$3,$4,$5,'2024-03-01',1000,150,1150)`,[invoice,h.f.companyA,`AOR-CI-${invoice.slice(0,8)}`,customer,h.f.u1.id]);
  await h.pool.query(`INSERT INTO customer_write_offs(id,company_id,write_off_number,client_id,invoice_id,amount,reason,status,created_by)
   VALUES($1,$2,$3,$4,$5,100,'Bad debt','draft',$6)`,[id,h.f.companyA,`AOR-WO-${id.slice(0,8)}`,customer,invoice,h.f.u1.id]);
  const refused=await refusedWithDetail(writeOffRoute as Route,'/api/accounting/write-offs-action',{action:'approve',id});
  expect(refused.status).toBe(400);
  expect(refused.body.error?.details).toEqual({originalMessage:REFUSAL});
  expect(await state('customer_write_offs',id)).toEqual({status:'draft',approved_by:null});
 });

 it('refuses a VAT adjustment approval recorded through an impersonated session',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO vat_adjustments(id,company_id,adjustment_number,adjustment_type,amount,reason,status,created_by,adjustment_date)
   VALUES($1,$2,$3,'input',150,'Prior period','draft',$4,'2024-03-01')`,[id,h.f.companyA,`AOR-VA-${id.slice(0,8)}`,h.f.u1.id]);
  const refused=await refusedWithDetail(vatAdjustmentRoute as Route,'/api/accounting/vat-adjustments-action',{action:'approve',id});
  expect(refused.status).toBe(400);
  expect(refused.body.error?.details).toEqual({originalMessage:REFUSAL});
  expect(await state('vat_adjustments',id)).toEqual({status:'draft',approved_by:null});
 });

 it('refuses an expense claim approval through an impersonated session and allows the ordinary one',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO expense_claims(id,company_id,employee_id,claim_number,claim_date,status,total_amount,created_by)
   VALUES($1,$2,$3,$4,'2024-03-01','submitted',500,$5)`,[id,h.f.companyA,employee,`AOR-EC-${id.slice(0,8)}`,h.f.u1.id]);
  const refused=await refusedWithDetail(expenseClaimRoute as Route,'/api/accounting/expense-claims/[id]/approve',{decision:'approve'},{id});
  expect(refused.status).toBe(400);
  expect(refused.body.error?.details).toEqual({originalMessage:REFUSAL});
  expect(await state('expense_claims',id)).toEqual({status:'submitted',approved_by:null});
  const allowed=await post(expenseClaimRoute as Route,'/api/accounting/expense-claims/[id]/approve',{decision:'approve'},await ordinary(),{id});
  expect(allowed.status).toBe(200);
  expect(await state('expense_claims',id)).toEqual({status:'approved',approved_by:target});
 });

 it('refuses a customer invoice approval recorded through an impersonated session',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,created_by,invoice_date,subtotal,tax_amount,total_amount,status)
   VALUES($1,$2,$3,$4,$5,'2024-03-01',1000,150,1150,'draft')`,[id,h.f.companyA,`AOR-AR-${id.slice(0,8)}`,customer,h.f.u1.id]);
  // This route rethrows anything it does not model, so the refusal arrives as a 500.
  const refused=await post(customerInvoiceRoute as Route,'/api/accounting/customer-invoices-detail',{id,action:'approve'},await impersonated());
  expect(refused.status).toBe(500);
  expect(refused.body.message).toBe(REFUSAL);
  expect(await state('customer_invoices',id)).toMatchObject({status:'draft'});
 });

 it('refuses a supplier invoice approval when only the recorded session identifies the actor',async()=>{
  const id=randomUUID(),sessionId=`impersonation-${randomUUID()}`;
  await h.pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,invoice_date,subtotal,tax_amount,total_amount,status,created_by)
   VALUES($1,$2,$3,$4,'2024-03-01',1000,150,1150,'draft',$5)`,[id,h.f.companyA,`AOR-SD-${id.slice(0,8)}`,h.supplier,h.f.u1.id]);
  await h.pool.query(`INSERT INTO admin_audit_log(admin_user_id,action,target_type,target_id,details)
   VALUES($1::uuid,'impersonation_start','user',$2::uuid,$3::jsonb)`,[h.admin,target,JSON.stringify({target_session_id:sessionId})]);
  // The delegation proof is dropped: only control_session_impersonator() can still see this.
  const cookies={[ACCESS_COOKIE]:await session(target,sessionId,'aal2'),[ACTIVE_COMPANY_COOKIE]:h.f.companyA};
  const refused=await post(supplierInvoiceRoute as Route,'/api/accounting/supplier-invoices-action',{action:'approve',invoiceId:id},cookies);
  expect(refused.status).toBe(400);
  expect(refused.body.error?.message).toBe(REFUSAL);
  expect(await state('supplier_invoices',id)).toEqual({status:'draft',approved_by:null});
 });

 it('records the actor on a commentary rejection and a withdrawn approval',async()=>{
  const id=randomUUID();
  await h.pool.query(`INSERT INTO report_commentary(id,company_id,report_kind,params_hash,period_start,period_end,section_ref,row_ref,draft_text,generated_by,status)
   VALUES($1,$2,'pack',$3,'2024-03-01','2024-03-31','balance_sheet','equity','Commentary awaiting a decision',$4,'draft')`,
   [id,h.f.companyA,randomUUID().replaceAll('-',''),h.f.u1.id]);
  const rejected=await post(commentaryRejectRoute as Route,'/api/accounting/commentary/[id]/reject',{},await impersonated(),{id});
  expect(rejected.status).toBe(200);
  expect((await h.pool.query('SELECT status,rejected_by::text,rejected_by_impersonator::text FROM report_commentary WHERE company_id=$1 AND id=$2',
   [h.f.companyA,id])).rows[0]).toEqual({status:'rejected',rejected_by:target,rejected_by_impersonator:h.admin});
 });

 it('records the actor who withdrew an approval by regenerating the pack',async()=>{
  const params={from:'2024-03-01',to:'2024-03-31'} as Parameters<typeof generateDrafts>[0]['params'];
  const data={priorPeriod:null,ratios:{grossMargin:50,netMargin:20},
   incomeStatement:{revenue:0,netProfit:0},
   balanceSheet:{currentRatio:2,debtEquityRatio:null,equity:0,
    debtEquityUnavailableReason:'Debt-to-equity is not meaningful for this balance sheet'}} as unknown as CommentaryPackData;
  await h.member(target,()=>generateDrafts({companyId:h.f.companyA,userId:target,params,data}),false,null);
  const row=(await h.pool.query("SELECT id FROM report_commentary WHERE company_id=$1 AND section_ref='balance_sheet' AND row_ref='equity' AND status='draft' ORDER BY created_at DESC LIMIT 1",[h.f.companyA])).rows[0];
  await post(commentaryRoute as Route,'/api/accounting/commentary/[id]/approve',{},await ordinary(),{id:row.id});
  await h.member(target,()=>generateDrafts({companyId:h.f.companyA,userId:target,params,data,replace:true}),false,h.admin);
  expect((await h.pool.query('SELECT status,withdrawn_by::text,withdrawn_by_impersonator::text FROM report_commentary WHERE company_id=$1 AND id=$2',
   [h.f.companyA,row.id])).rows[0]).toEqual({status:'draft',withdrawn_by:target,withdrawn_by_impersonator:h.admin});
 });

 it('records the impersonating actor on a commentary sign-off instead of blocking it',async()=>{
  const insert=async()=>{
   const id=randomUUID();
   await h.pool.query(`INSERT INTO report_commentary(id,company_id,report_kind,params_hash,period_start,period_end,section_ref,draft_text,generated_by,status)
    VALUES($1,$2,'trial_balance',$3,'2024-03-01','2024-03-31','summary','Commentary awaiting sign-off',$4,'draft')`,
    [id,h.f.companyA,id.replaceAll('-',''),h.f.u1.id]);
   return id;
  };
  const signed=await insert();
  const underImpersonation=await post(commentaryRoute as Route,'/api/accounting/commentary/[id]/approve',{},await impersonated(),{id:signed});
  expect(underImpersonation.status).toBe(200);
  expect((underImpersonation.body.data as {commentary?:{approvedByImpersonator?:string|null}}).commentary?.approvedByImpersonator).toBe(h.admin);
  expect((await h.pool.query('SELECT status,approved_by::text,approved_by_impersonator::text FROM report_commentary WHERE company_id=$1 AND id=$2',
   [h.f.companyA,signed])).rows[0]).toEqual({status:'approved',approved_by:target,approved_by_impersonator:h.admin});
  const own=await insert();
  const unimpersonated=await post(commentaryRoute as Route,'/api/accounting/commentary/[id]/approve',{},await ordinary(),{id:own});
  expect(unimpersonated.status).toBe(200);
  expect((await h.pool.query('SELECT approved_by::text,approved_by_impersonator::text FROM report_commentary WHERE company_id=$1 AND id=$2',
   [h.f.companyA,own])).rows[0]).toEqual({approved_by:target,approved_by_impersonator:null});
 });
});
