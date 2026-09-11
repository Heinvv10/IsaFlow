import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankTransferRestFixture} from './bankTransferRestFixture';

/**
 * Every refusal a caller of POST /api/accounting/bank-transfers can meet is a 4xx that says what to do, and the
 * refused request commits nothing. Over real HTTP, so the answer is the one withAuth and withErrorHandler send.
 */
let h:Awaited<ReturnType<typeof bankTransferRestFixture>>;
beforeAll(async()=>{h=await bankTransferRestFixture();},60000);
afterAll(async()=>{await h?.close();});

const prepare=(overrides:Record<string,unknown>={},person:'u1'|'u2'|'u3'='u1')=>
 h.request({fromAccountId:h.from,toAccountId:h.to,amount:'10',transferDate:'2026-09-09',...overrides},person);
const execute=(intentId:string,approvalId?:string,person:'u1'|'u2'|'u3'='u1')=>
 h.request({action:'execute',intentId,...(approvalId?{approvalId}:{})},person);
const intents=async()=>Number((await h.pool.query('SELECT count(*)::int AS n FROM control_bank_transfer_intents WHERE company_id=$1',[h.f.companyA])).rows[0].n);
const transferJournals=async()=>Number((await h.pool.query("SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND source='auto_bank_transfer'",[h.f.companyA])).rows[0].n);
async function prepared(date='2026-09-09'){
 const res=await prepare({transferDate:date});
 expect(res.status,JSON.stringify(res.body)).toBe(200);
 return res.body.data as {intentId:string;operation:{entityType:string;entityId:string;operation:'bank_transfer.post'}};
}

describe('POST /api/accounting/bank-transfers',()=>{
 it('prepares, and posts with an independent approval',async()=>{
  const p=await prepared(),approval=await h.approve(p.operation as never);
  const posted=await execute(p.intentId,approval);
  expect(posted.status,JSON.stringify(posted.body)).toBe(200);
  expect(posted.body.data).toMatchObject({status:'posted',intentId:p.intentId});
 });

 it('refuses an absent account and another tenant\'s account alike with a 422, before writing an intent',async()=>{
  const foreign=randomUUID(),absent=randomUUID();
  await h.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,'B-BANK','Tenant B bank','asset','bank','debit',true,3)",[foreign,h.f.companyB]);
  const before=await intents();
  for(const id of [absent,foreign]){
   const res=await prepare({toAccountId:id});
   expect(res.status,JSON.stringify(res.body)).toBe(422);
   expect(res.body.error).toMatchObject({code:'BUSINESS_RULE_VIOLATION',message:`Cannot transfer between these accounts: account ${id} was not found in this company.`});
  }
  expect(await intents(),'a refused preparation left an intent behind').toBe(before);
 });

 it('refuses to post without an approval while a policy binds the transfer: 409 saying how to get one',async()=>{
  const p=await prepared(),journals=await transferJournals();
  const res=await execute(p.intentId);
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.code).toBe('CONFLICT');
  expect(res.body.error?.message).toBe('This transfer needs an independent approval under the company\'s approval policy, so nothing was posted. '
   +'Request an approval for it, have another authorised person approve it, then post again with that approval id.');
  expect(await transferJournals()).toBe(journals);
 });

 it('refuses an approval id it cannot use — unknown, or requested but undecided — with a 409 naming why',async()=>{
  const p=await prepared(),journals=await transferJournals();
  const unknown=await execute(p.intentId,randomUUID());
  expect(unknown.status,JSON.stringify(unknown.body)).toBe(409);
  expect(unknown.body.error?.message).toMatch(/^The approval supplied for this transfer cannot be used \(.+\)\. Nothing was posted\. Request an approval for this transfer and post again with its approval id\.$/);
  const {requestOperationApproval}=await import('@/modules/accounting/services/controls/approvalRequestService');
  const undecided=await h.actor(ctx=>requestOperationApproval(ctx,p.operation as never));
  const pending=await execute(p.intentId,undecided.id);
  expect(pending.status,JSON.stringify(pending.body)).toBe(409);
  expect(pending.body.error?.message).toMatch(/^The approval supplied for this transfer cannot be used/);
  expect(await transferJournals()).toBe(journals);
 });

 it('refuses an approval whose material moved on (the period closed after it was given) with a 409, not a 500',async()=>{
  await h.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic transfer November',11,2026,'2026-11-01','2026-11-30','open')",[randomUUID(),h.f.companyA]);
  const p=await prepared('2026-11-09'),approval=await h.approve(p.operation as never),journals=await transferJournals();
  await h.pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND start_date='2026-11-01'",[h.f.companyA]);
  const res=await execute(p.intentId,approval);
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.message).toBe('The approval supplied for this transfer cannot be used (Approval material changed). Nothing was posted. '
   +'Request an approval for this transfer and post again with its approval id.');
  expect(await transferJournals()).toBe(journals);
 });

 it('answers an absent intent and another person\'s or tenant\'s intent with the same 404',async()=>{
  const p=await prepared();
  const answers=[await execute(randomUUID()),await execute(p.intentId,undefined,'u2'),await execute(p.intentId,undefined,'u3')];
  for(const res of answers){
   expect(res.status,JSON.stringify(res.body)).toBe(404);
   expect(res.body.error).toMatchObject({code:'NOT_FOUND',message:'Transfer intent not found'});
  }
 });

 it('refuses to post into a closed fiscal period with a 422 naming the period, and posts nothing',async()=>{
  await h.pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic transfer October',10,2026,'2026-10-01','2026-10-31','closed')",[randomUUID(),h.f.companyA]);
  const p=await prepared('2026-10-09'),approval=await h.approve(p.operation as never),journals=await transferJournals();
  const res=await execute(p.intentId,approval);
  expect(res.status,JSON.stringify(res.body)).toBe(422);
  expect(res.body.error).toMatchObject({code:'BUSINESS_RULE_VIOLATION',
   message:'Cannot post this transfer dated 2026-10-09: its fiscal period (2026-10-01 to 2026-10-31) is closed.'});
  expect(await transferJournals()).toBe(journals);
 });

 it('refuses to post inside the company lockdown with a 422 naming the lockdown date, and posts nothing',async()=>{
  await h.pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2026-09-15' WHERE id=$1",[h.f.companyA]);
  try{
   const p=await prepared('2026-09-09'),approval=await h.approve(p.operation as never),journals=await transferJournals();
   const res=await execute(p.intentId,approval);
   expect(res.status,JSON.stringify(res.body)).toBe(422);
   expect(res.body.error).toMatchObject({code:'BUSINESS_RULE_VIOLATION',
    message:'Cannot post this transfer dated 2026-09-09: the company is locked down up to 2026-09-15.'});
   expect(await transferJournals()).toBe(journals);
  }finally{await h.pool.query('UPDATE companies SET lockdown_enabled=false,lockdown_date=NULL WHERE id=$1',[h.f.companyA]);}
 });

 it('names only the account with duplicate bank records, even when its records would crowd the other out',async()=>{
  const dup=randomUUID(),other=randomUUID();
  for(const [id,code] of [[dup,'DUP-FROM'],[other,'DUP-TO']]){
   await h.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,$3,'Synthetic duplicate bank','asset','bank','debit',true,3)",[id,h.f.companyA,code]);
  }
  // Three records for one account whose ids sort before the other account's single record.
  // Fresh ids every run (the fixture database persists), forced to sort low for the duplicates and high for the single.
  const sorted=(prefix:string)=>`${prefix}${randomUUID().slice(8)}`;
  for(let n=0;n<3;n++)await h.pool.query("INSERT INTO bank_accounts(id,company_id,account_name,gl_account_id,currency,is_active) VALUES($1,$2,'Synthetic duplicate',$3,'ZAR',true)",[sorted('00000000'),h.f.companyA,dup]);
  await h.pool.query("INSERT INTO bank_accounts(id,company_id,account_name,gl_account_id,currency,is_active) VALUES($1,$2,'Synthetic single',$3,'ZAR',true)",[sorted('ffffffff'),h.f.companyA,other]);
  const res=await prepare({fromAccountId:dup,toAccountId:other});
  expect(res.status,JSON.stringify(res.body)).toBe(422);
  expect(res.body.error?.message).toBe('Cannot transfer between these bank accounts: DUP-FROM Synthetic duplicate bank has more than one bank account record. Both must have the ledger currency (ZAR).');
 });

 it('is not blocked by a filed VAT period: a bank-to-bank transfer has no VAT lines',async()=>{
  await h.pool.query(`INSERT INTO vat_period_locks(company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type)
   VALUES($1,'2026-09-01','2026-09-30',0,0,0,now(),$2,'human') ON CONFLICT DO NOTHING`,[h.f.companyA,h.f.u1.id]);
  const p=await prepared(),approval=await h.approve(p.operation as never);
  const res=await execute(p.intentId,approval);
  expect(res.status,JSON.stringify(res.body)).toBe(200);
 });
});
