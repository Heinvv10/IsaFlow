import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {generateManagementPack} from '@/modules/accounting/services/afs/managementPackGeneratorService';
import {deliverPack} from '@/modules/accounting/services/afs/packDeliveryService';
import type {ManagementPackConfig} from '@/modules/accounting/services/afs/afsTypes';

// The model and outbound delivery are the boundaries replaced; the ledger reads and every row are real.
vi.mock('@/modules/accounting/services/afs/packAiSummaryService',()=>({
 generateExecutiveSummary:vi.fn(async()=>'Synthetic summary'),generateSectionCommentary:vi.fn(async()=>'Synthetic commentary')}));
vi.mock('@/modules/accounting/services/afs/packDeliveryService',()=>({deliverPack:vi.fn(async()=>undefined)}));

/**
 * A pack generated without review used to be marked signed_off with nobody named and delivered.
 * Until an unsigned publishing status exists it must not be generated at all; a pack that goes
 * to review is generated as a draft.
 */
describe('management pack generation gate: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 beforeEach(()=>{vi.mocked(deliverPack).mockClear();});
 const config=(reviewRequired:boolean):ManagementPackConfig=>({id:randomUUID(),companyId:h.f.companyA,enabled:true,generationDay:1,deliveryDay:5,reviewRequired,
  sectionsEnabled:{kpi_scorecard:true,income_statement:true},recipients:[],packStyle:'executive',comparisonMode:'prior_month',currencyDisplay:'full'});
 const packs=async(period:string)=>(await h.pool.query("SELECT id,status FROM afs_documents WHERE company_id=$1 AND document_type='management_pack' AND period=$2",[h.f.companyA,period])).rows;
 const run=(period:string,reviewRequired:boolean)=>h.member(h.f.u1.id,()=>generateManagementPack({companyId:h.f.companyA,period,config:config(reviewRequired),triggeredBy:'manual'}));

 it('refuses an unreviewed pack before writing anything or delivering it',async()=>{
  await expect(run('2031-01',false)).rejects.toThrow(/status that is not yet available/);
  expect(await packs('2031-01'),'an unreviewed pack was created').toEqual([]);
  expect(vi.mocked(deliverPack)).not.toHaveBeenCalled();
 });

 it('generates a pack that goes to review as a draft with its sections filled',async()=>{
  const result=await run('2031-02',true);
  expect(result).toMatchObject({status:'draft',deliveryScheduled:false});
  expect(await packs('2031-02')).toEqual([{id:result.documentId,status:'draft'}]);
  const sections=(await h.pool.query('SELECT status,content FROM afs_sections WHERE company_id=$1 AND document_id=$2',[h.f.companyA,result.documentId])).rows;
  expect(sections).toHaveLength(2);
  for(const section of sections)expect(section.content,'a section was left empty').not.toBeNull();
  expect(vi.mocked(deliverPack)).not.toHaveBeenCalled();
 });
});
