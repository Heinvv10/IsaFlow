import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {sendEmail} from '@/modules/accounting/services/core/emailService';
import {generateManagementPack} from '@/modules/accounting/services/afs/managementPackGeneratorService';
import {signOffDocument} from '@/modules/accounting/services/afs/afsReviewService';
import type {ManagementPackConfig} from '@/modules/accounting/services/afs/afsTypes';

// The mail transport and the model are the boundaries replaced. The delivery route, the
// delivery service, the gate and every row are real.
vi.mock('@/modules/accounting/services/core/emailService',()=>({sendEmail:vi.fn(async()=>({success:true}))}));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService',()=>({
 generateExecutiveSummary:vi.fn(async()=>'Synthetic summary'),generateSectionCommentary:vi.fn(async()=>'Synthetic commentary')}));

/**
 * A pack generated without review carries no signature and no reviewer. It is generated — a
 * person can open it — but it may not be DELIVERED until someone signs the document off. The
 * gate lives in deliverPack, the one place every caller passes through; the route's own check
 * is defence in depth.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
beforeAll(async()=>{h=await afsSectionHttpFixture();},30000);
afterAll(async()=>{await h?.close();});
beforeEach(()=>{vi.mocked(sendEmail).mockClear();});

const config=(reviewRequired:boolean):ManagementPackConfig=>({id:randomUUID(),companyId:h.f.companyA,enabled:true,generationDay:1,deliveryDay:5,reviewRequired,
 sectionsEnabled:{kpi_scorecard:true},recipients:[{email:'owner@forensic.invalid',role:'owner',receives:'both'}],
 packStyle:'executive',comparisonMode:'prior_month',currencyDisplay:'full'});

async function pack(period:string,reviewRequired:boolean){
 await h.pool.query(`INSERT INTO management_pack_configs(company_id,enabled,generation_day,delivery_day,review_required,sections_enabled,recipients)
  VALUES($1,true,1,5,$2,'{"kpi_scorecard":true}'::jsonb,'[{"email":"owner@forensic.invalid","role":"owner","receives":"both"}]'::jsonb)
  ON CONFLICT (company_id) DO UPDATE SET review_required=$2,recipients=EXCLUDED.recipients`,[h.f.companyA,reviewRequired]);
 return generateManagementPack({companyId:h.f.companyA,period,config:config(reviewRequired),triggeredBy:'manual'});
}
const deliver=(id:string)=>h.request('POST',`/api/accounting/afs/management-packs/${id}/deliver`,{});
const withheld=async(id:string)=>(await h.pool.query('SELECT delivery_withheld_reason FROM afs_documents WHERE company_id=$1 AND id=$2',[h.f.companyA,id])).rows[0]?.delivery_withheld_reason as string|null;

describe('delivering a management pack that skipped review',()=>{
 it('is refused by the delivery route, and nothing is emailed',async()=>{
  const result=await pack('2032-01',false);
  expect(await withheld(result.documentId),'nothing on the document records that it may not go out').toBeTruthy();
  const res=await deliver(result.documentId);
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect(vi.mocked(sendEmail),'an unreviewed pack was emailed to its recipients').not.toHaveBeenCalled();
 });

 it('goes out once a person has signed the document off, and the release is on the audit trail',async()=>{
  const result=await pack('2032-02',false);
  await h.pool.query("UPDATE afs_sections SET status='signed_off',signed_off_by=$3,signed_off_at=now() WHERE company_id=$1 AND document_id=$2",[h.f.companyA,result.documentId,h.f.u2.id]);
  await h.pool.query("UPDATE afs_documents SET status='partner_review' WHERE company_id=$1 AND id=$2",[h.f.companyA,result.documentId]);
  await signOffDocument(h.f.companyA,result.documentId,h.f.u2.id);
  expect(await withheld(result.documentId),'signing off did not release the pack').toBeNull();
  const audit=(await h.pool.query("SELECT action,entity_type,changes FROM audit_log WHERE company_id=$1 AND entity_id=$2",[h.f.companyA,result.documentId])).rows;
  expect(JSON.stringify(audit),'the release was not recorded anywhere a reviewer reads').toContain('delivery_withheld_reason');
  const res=await deliver(result.documentId);
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(vi.mocked(sendEmail),'the released pack never reached its recipients').toHaveBeenCalled();
 });

 it('delivers a pack that was generated for review without any release step',async()=>{
  const result=await pack('2032-03',true);
  expect(await withheld(result.documentId)).toBeNull();
  expect((await deliver(result.documentId)).status).toBe(200);
  expect(vi.mocked(sendEmail)).toHaveBeenCalled();
 });
});
