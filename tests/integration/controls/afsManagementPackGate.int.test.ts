import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {generateManagementPack} from '@/modules/accounting/services/afs/managementPackGeneratorService';
import {runDailyScheduler} from '@/modules/accounting/services/afs/packSchedulerService';
import type {ManagementPackConfig} from '@/modules/accounting/services/afs/afsTypes';

// The model is the boundary replaced; the ledger reads and every row are real. Whether the pack
// is DELIVERED is proven through the real route in afsPackDeliveryGate.int.test.ts — asserting
// that this generator never calls deliverPack proves nothing, since no branch of it ever does.
vi.mock('@/modules/accounting/services/afs/packAiSummaryService',()=>({
 generateExecutiveSummary:vi.fn(async()=>'Synthetic summary'),generateSectionCommentary:vi.fn(async()=>'Synthetic commentary')}));

/**
 * A pack generated with review SKIPPED used to be marked signed_off — the status that LOCKS a
 * document — with nobody named, and delivered. Until a published status exists the pack is still
 * generated, as a draft a human can open, but it is NOT delivered, and both the caller and the
 * scheduler are told why.
 */
describe('management pack generation gate: actual PostgreSQL',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 const config=(reviewRequired:boolean):ManagementPackConfig=>({id:randomUUID(),companyId:h.f.companyA,enabled:true,generationDay:1,deliveryDay:5,reviewRequired,
  sectionsEnabled:{kpi_scorecard:true,income_statement:true},recipients:[],packStyle:'executive',comparisonMode:'prior_month',currencyDisplay:'full'});
 const packs=async(period:string)=>(await h.pool.query("SELECT id,status FROM afs_documents WHERE company_id=$1 AND document_type='management_pack' AND period=$2",[h.f.companyA,period])).rows;
 const run=(period:string,reviewRequired:boolean)=>h.member(h.f.u1.id,()=>generateManagementPack({companyId:h.f.companyA,period,config:config(reviewRequired),triggeredBy:'manual'}));

 it('generates an unreviewed pack as a draft, delivers nothing, and says why',async()=>{
  const result=await run('2031-01',false);
  expect(result).toMatchObject({status:'draft',deliveryScheduled:false});
  expect(result.deliveryWithheldReason,'nothing tells the caller why no pack arrived').toMatch(/status that is not yet available/);
  expect(await packs('2031-01')).toEqual([{id:result.documentId,status:'draft'}]);
 });

 it('reports the withheld delivery to the scheduler that runs it',async()=>{
  // generation_day is CHECKed to 1-28 (migration 337) — every month has a 28th, but not every
  // month has a 29th-31st, so a "today" that lands there must be clamped, not stored as-is.
  const today=new Date(),generationDay=Math.min(today.getDate(),28);
  await h.pool.query(`INSERT INTO management_pack_configs(company_id,enabled,generation_day,delivery_day,review_required,sections_enabled,recipients,pack_style,comparison_mode,currency_display)
   VALUES($1,true,$2,5,false,'{"kpi_scorecard":true}'::jsonb,'[]'::jsonb,'executive','prior_month','full')
   ON CONFLICT (company_id) DO UPDATE SET enabled=true,review_required=false,generation_day=$2`,[h.f.companyA,generationDay]);
  // Scheduler is told the same clamped day so it looks up companies scheduled for that day —
  // the real cron always sees the unclamped calendar day, so on the 29th-31st this test's
  // substitution intentionally diverges from production; runDailyScheduler's own dayOfMonth
  // is not exercised against 29-31 here, only the config/gate/withheld-reason plumbing.
  const asOf=new Date(today.getFullYear(),today.getMonth(),generationDay);
  const summary=await h.member(h.f.u1.id,()=>runDailyScheduler(asOf));
  const withheld=summary.deliveriesWithheld.find(row=>row.companyId===h.f.companyA);
  expect(withheld,'the scheduler reported nothing about the pack it did not deliver').toBeTruthy();
  expect(withheld?.reason).toMatch(/status that is not yet available/);
 });

 it('generates a pack that goes to review as a draft with its sections filled',async()=>{
  const result=await run('2031-02',true);
  expect(result.deliveryWithheldReason).toBeNull();
  expect(result).toMatchObject({status:'draft',deliveryScheduled:false});
  expect(await packs('2031-02')).toEqual([{id:result.documentId,status:'draft'}]);
  const sections=(await h.pool.query('SELECT status,content FROM afs_sections WHERE company_id=$1 AND document_id=$2',[h.f.companyA,result.documentId])).rows;
  expect(sections).toHaveLength(2);
  for(const section of sections)expect(section.content,'a section was left empty').not.toBeNull();
 });
});
