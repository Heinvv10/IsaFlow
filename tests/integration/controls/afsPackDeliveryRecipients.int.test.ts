import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {als} from '@/lib/als';
import {sendEmail} from '@/modules/accounting/services/core/emailService';
import {generateManagementPack} from '@/modules/accounting/services/afs/managementPackGeneratorService';
import type {ManagementPackConfig} from '@/modules/accounting/services/afs/afsTypes';

// The model is the boundary replaced. The mail service is REAL, with no SMTP configured, so every
// attempt takes the path that writes a 'failed' email_log row inside the request transaction.
vi.mock('@/modules/accounting/services/afs/packAiSummaryService',()=>({
 generateExecutiveSummary:vi.fn(async()=>'Synthetic summary'),generateSectionCommentary:vi.fn(async()=>'Synthetic commentary')}));

/**
 * A stored recipients entry that is a bare address instead of {email, role, receives} used to
 * reach sendEmail with no address. That email_log INSERT (recipient_email NOT NULL) failed on the
 * request's own connection, the transaction was aborted, and the delivery's next statement made
 * the whole request a 500 "An unexpected error occurred".
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
const realFetch=globalThis.fetch;
beforeAll(async()=>{
 for(const key of ['SMTP_HOST','SMTP_USER','SMTP_PASS'])delete process.env[key];
 h=await afsSectionHttpFixture();
 await h.brandProfile();
 process.env.WEASYPRINT_URL='http://weasyprint.synthetic.invalid';
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith(process.env.WEASYPRINT_URL!))return realFetch(input,init);
  return new Response(Buffer.from('synthetic pdf','utf8'),{status:200});
 });
},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});

const config:()=>ManagementPackConfig=()=>({id:randomUUID(),companyId:h.f.companyA,enabled:true,generationDay:1,deliveryDay:5,reviewRequired:true,
 sectionsEnabled:{kpi_scorecard:true},recipients:[],packStyle:'executive',comparisonMode:'prior_month',currencyDisplay:'full'});

describe('delivering a pack whose stored recipients include a malformed entry',()=>{
 it('skips and reports the malformed entry, still sends to the valid one, and answers 200',async()=>{
  await h.pool.query(`INSERT INTO management_pack_configs(company_id,enabled,generation_day,delivery_day,review_required,sections_enabled,recipients)
   VALUES($1,true,1,5,true,'{"kpi_scorecard":true}'::jsonb,'["cfo@forensic.invalid",{"email":"owner@forensic.invalid","role":"owner","receives":"both"}]'::jsonb)
   ON CONFLICT (company_id) DO UPDATE SET review_required=true,recipients=EXCLUDED.recipients`,[h.f.companyA]);
  const {documentId}=await generateManagementPack({companyId:h.f.companyA,period:'2033-01',config:config(),triggeredBy:'manual'});
  const before=(await h.pool.query('SELECT updated_at FROM afs_documents WHERE company_id=$1 AND id=$2',[h.f.companyA,documentId])).rows[0]!.updated_at as Date;

  const res=await h.request('POST',`/api/accounting/afs/management-packs/${documentId}/deliver`,{});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  // The actual problem, and the stored address: the operator's own company data, so they can find the entry.
  expect(res.body.data).toMatchObject({skippedRecipients:['recipients[0] (cfo@forensic.invalid): Invalid input: expected object, received string']});

  const logged=(await h.pool.query("SELECT recipient_email FROM email_log WHERE company_id=$1 AND subject LIKE '%2033-01%'",[h.f.companyA])).rows.map(r=>r.recipient_email);
  expect(logged,'the valid recipient was never attempted').toEqual(['owner@forensic.invalid']);
  const after=(await h.pool.query('SELECT updated_at FROM afs_documents WHERE company_id=$1 AND id=$2',[h.f.companyA,documentId])).rows[0]!.updated_at as Date;
  expect(after.getTime(),'the delivery did not commit').toBeGreaterThan(before.getTime());
 });

 it('still sends to a stored entry carrying a key the save schema no longer accepts (written before it was strict)',async()=>{
  await h.pool.query(`INSERT INTO management_pack_configs(company_id,enabled,generation_day,delivery_day,review_required,sections_enabled,recipients)
   VALUES($1,true,1,5,true,'{"kpi_scorecard":true}'::jsonb,'[{"email":"legacy@forensic.invalid","role":"owner","receives":"both","name":"Legacy Owner"}]'::jsonb)
   ON CONFLICT (company_id) DO UPDATE SET review_required=true,recipients=EXCLUDED.recipients`,[h.f.companyA]);
  const {documentId}=await generateManagementPack({companyId:h.f.companyA,period:'2033-02',config:config(),triggeredBy:'manual'});
  const res=await h.request('POST',`/api/accounting/afs/management-packs/${documentId}/deliver`,{});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(res.body.data?.skippedRecipients,'a well-formed legacy entry was skipped for an extra key').toEqual([]);
  const logged=(await h.pool.query("SELECT recipient_email FROM email_log WHERE company_id=$1 AND subject LIKE '%2033-02%'",[h.f.companyA])).rows.map(r=>r.recipient_email);
  expect(logged).toEqual(['legacy@forensic.invalid']);
 });

 it('a failing email_log write does not poison the request transaction',async()=>{
  const client=await h.pool.connect();
  try{
   await client.query('BEGIN');
   await als.run({client,userId:h.f.u1.id,companyId:h.f.companyA,claims:{}},async()=>{
    // No address at all: the email_log INSERT violates recipient_email NOT NULL.
    await sendEmail({to:undefined as unknown as string,subject:'poison probe',html:'<p>probe</p>',_log:{companyId:h.f.companyA,emailType:'other'}});
   });
   await new Promise(resolve=>setTimeout(resolve,100));
   await expect(client.query('SELECT 1 AS ok'),'the transaction was aborted by a best-effort log write').resolves.toMatchObject({rows:[{ok:1}]});
  }finally{await client.query('ROLLBACK');client.release();}
 });
});
