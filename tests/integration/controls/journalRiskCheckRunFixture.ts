import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
/**
 * A live journal population for the check-run adapter and its sync-detector oracle. Deterministic (fixed-seed LCG),
 * so the differential compares two readings of the SAME rows rather than two random populations.
 *
 * Layout under CUTOFF, in cursor order (slab day, person, currency, id):
 *   930 filler rows on FILLER_DAY, each its own slab (unique posted_by) -> no findings, exercises the FETCH pages;
 *   STRADDLE_ROWS rows sharing one (day, person, currency) slab that spans the 1000-row FETCH boundary, each below
 *   the threshold and together above it, so a lost carry-over drops every one of their findings;
 *   the signal rows, which carry the backdating, out-of-hours, weekend, reversal, closed-period and >100 markers.
 * OVERFLOW_ROWS rows sit above CUTOFF in one slab, so a run at OVERFLOW_CUTOFF exceeds maxSlabRows.
 */
export const CUTOFF='2026-09-09',OVERFLOW_CUTOFF='2027-12-31';
export const FILLER_DAY='2026-03-02',STRADDLE_DAY='2026-03-03';
export const FILLER_ROWS=930,STRADDLE_ROWS=120,STRADDLE_AMOUNT='100',THRESHOLD_AMOUNT='10000',OVERFLOW_ROWS=1001;
export interface JournalRiskSeed {accountId:string;openPeriodId:string;closedPeriodId:string;thresholdId:string;straddlePerson:string}
const at=(day:string,hour:number,minute=0)=>new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+02:00`).toISOString();
/** Deterministic 32-bit LCG: the "randomised" fixture must reproduce byte for byte across both readings. */
function random(seed:number){let state=seed>>>0;return()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};}
async function evidence(pool:Pool,companyId:string):Promise<string>{
 const id=randomUUID();
 await pool.query(`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext)
  VALUES($1,$2,'journal_entry','fixture','current',1,'00')`,[companyId,id]);
 return id;
}
async function period(pool:Pool,companyId:string,name:string,number:number,start:string,end:string):Promise<string>{
 const id=randomUUID();
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$2,$3,$4,2026,$5,$6,'open')`,[id,companyId,name,number,start,end]);
 return id;
}
interface JournalSeed {id:string;entryDate:string;periodId:string;postedAt:string|null;postedBy:string|null;createdAt:string;amount:string;
 lines?:number;reversalOfId?:string|null;reversedAt?:string|null;version?:number|null}
async function journals(pool:Pool,companyId:string,creator:string,accountId:string,rows:readonly JournalSeed[]):Promise<void>{
 const entries=rows.map(row=>[row.id,companyId,row.entryDate,row.periodId,row.postedAt,row.postedBy,row.createdAt,row.reversalOfId??null,row.reversedAt??null]);
 await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,status,posted_at,posted_by,created_at,created_by,reversal_of_id,reversed_at,entry_number)
  SELECT x.id,x.company_id,x.entry_date,x.period_id,'posted',x.posted_at,x.posted_by,x.created_at,$2::uuid,x.reversal_of_id,x.reversed_at,'JE-'||left(x.id::text,12)
  FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,company_id uuid,entry_date date,period_id uuid,posted_at timestamptz,posted_by uuid,created_at timestamptz,reversal_of_id uuid,reversed_at timestamptz)`,
 [JSON.stringify(entries.map(([id,company,entryDate,periodId,postedAt,postedBy,createdAt,reversalOfId,reversedAt])=>
  ({id,company_id:company,entry_date:entryDate,period_id:periodId,posted_at:postedAt,posted_by:postedBy,created_at:createdAt,reversal_of_id:reversalOfId,reversed_at:reversedAt}))),creator]);
 const lines=rows.flatMap(row=>Array.from({length:row.lines??1},(_unused,index)=>({id:randomUUID(),company_id:companyId,journal_entry_id:row.id,
  gl_account_id:accountId,debit:index===0?row.amount:'0',credit:'0'})));
 await pool.query(`INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
  SELECT x.id,x.company_id,x.journal_entry_id,x.gl_account_id,x.debit,x.credit
  FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,company_id uuid,journal_entry_id uuid,gl_account_id uuid,debit numeric,credit numeric)`,[JSON.stringify(lines)]);
 const versions=rows.filter(row=>row.version!==null&&row.version!==undefined)
  .map(row=>({company_id:companyId,entity_type:'journal_entry',entity_id:row.id,version:row.version,material_hash:'f'.repeat(64)}));
 if(versions.length)await pool.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
  SELECT x.company_id,x.entity_type,x.entity_id,x.version,x.material_hash
  FROM jsonb_to_recordset($1::jsonb) AS x(company_id uuid,entity_type text,entity_id text,version bigint,material_hash text)`,[JSON.stringify(versions)]);
}
interface ChangeSeed {entityType:string;entityId:string;action:string;occurredAt:string;version:number}
async function changes(pool:Pool,companyId:string,personId:string,evidenceId:string,rows:readonly ChangeSeed[]):Promise<void>{
 if(!rows.length)return;
 await pool.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
  SELECT $1::uuid,x.id,$2,gen_random_uuid(),gen_random_uuid(),'human',x.entity_type,x.entity_id,NULLIF(x.version-1,0),x.version,x.action,x.occurred_at,$3::uuid
  FROM jsonb_to_recordset($4::jsonb) AS x(id uuid,entity_type text,entity_id text,version bigint,action text,occurred_at timestamptz)`,
 [companyId,personId,evidenceId,JSON.stringify(rows.map(row=>({id:randomUUID(),entity_type:row.entityType,entity_id:row.entityId,version:row.version,action:row.action,occurred_at:row.occurredAt})))]);
}
/** Seeds companyA's population plus one unowned companyB reversal parent. Safe to call once per provisioned fixture. */
export async function seedJournalRiskPopulation(pool:Pool,fixture:ForensicFixture):Promise<JournalRiskSeed>{
 const companyId=fixture.companyA,creator=fixture.u1.id,accountId=randomUUID(),foreignAccount=randomUUID();
 for(const [id,company] of [[accountId,companyId],[foreignAccount,fixture.companyB]] as const)
  await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Fixture','asset','debit')`,[id,company]);
 const openPeriodId=await period(pool,companyId,'Open',1,'2026-01-01','2026-12-31'),closedPeriodId=await period(pool,companyId,'Closed',2,'2025-01-01','2025-12-31');
 const foreignPeriod=await period(pool,fixture.companyB,'Foreign',1,'2026-01-01','2026-12-31');
 const evidenceId=await evidence(pool,companyId);
 const thresholdId=randomUUID();
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
  VALUES($1,$2,'Journal threshold','journal_entry','amount','greater_than',$3,'admin',true)`,[thresholdId,companyId,THRESHOLD_AMOUNT]);
 // A day-window supplier rule is an approval policy the detector cannot honour, so both paths must report
 // unsupported_or_bounded_current_journal_policy. (The row trigger allows only window 1 by supplier.)
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active,aggregate_window_days,aggregate_by)
  VALUES(gen_random_uuid(),$1,'Windowed','journal_entry','amount','greater_than',5000,'admin',true,1,'supplier')`,[companyId]);
 const foreignParent=randomUUID();
 await journals(pool,fixture.companyB,fixture.u3.id,foreignAccount,[{id:foreignParent,entryDate:'2026-05-04',periodId:foreignPeriod,
  postedAt:at('2026-05-04',10),postedBy:fixture.u3.id,createdAt:at('2026-05-04',10),amount:'500'}]);
 const filler=Array.from({length:FILLER_ROWS},():JournalSeed=>({id:randomUUID(),entryDate:FILLER_DAY,periodId:openPeriodId,
  postedAt:at(FILLER_DAY,10),postedBy:randomUUID(),createdAt:at(FILLER_DAY,10),amount:'25',version:1}));
 const straddlePerson=randomUUID();
 const straddle=Array.from({length:STRADDLE_ROWS},():JournalSeed=>({id:randomUUID(),entryDate:STRADDLE_DAY,periodId:openPeriodId,
  postedAt:at(STRADDLE_DAY,11),postedBy:straddlePerson,createdAt:at(STRADDLE_DAY,11),amount:STRADDLE_AMOUNT,version:1}));
 const next=random(20260910),signals:JournalSeed[]=[],changeRows:ChangeSeed[]=[];
 const people=[fixture.u1.id,fixture.u2.id];
 for(let index=0;index<30;index++){
  const day=`2026-0${4+(index%5)}-${String(1+(index%27)).padStart(2,'0')}`,hour=Math.floor(next()*24);
  const posted=next()<0.15?null:at(day,hour,Math.floor(next()*60));
  signals.push({id:randomUUID(),entryDate:next()<0.4?'2026-01-15':day,periodId:openPeriodId,postedAt:posted,
   postedBy:posted?people[index%2]!:null,createdAt:at(day,hour),amount:String(500+Math.floor(next()*9000)),version:next()<0.3?null:1});
 }
 const reversal=randomUUID(),unowned=randomUUID(),closedWrite=randomUUID(),manyChanges=randomUUID(),manyLines=randomUUID(),amended=randomUUID();
 signals.push({id:reversal,entryDate:'2026-06-08',periodId:openPeriodId,postedAt:at('2026-06-08',9),postedBy:fixture.u1.id,createdAt:at('2026-06-08',9),amount:'750',reversedAt:at('2026-06-09',9),version:2});
 signals.push({id:unowned,entryDate:'2026-06-09',periodId:openPeriodId,postedAt:at('2026-06-09',9),postedBy:fixture.u1.id,createdAt:at('2026-06-09',9),amount:'500',reversalOfId:foreignParent,version:1});
 signals.push({id:closedWrite,entryDate:'2025-11-30',periodId:closedPeriodId,postedAt:at('2026-07-06',20),postedBy:fixture.u2.id,createdAt:at('2026-07-06',20),amount:'1200',version:1});
 signals.push({id:amended,entryDate:'2025-12-01',periodId:closedPeriodId,postedAt:at('2026-07-07',10),postedBy:fixture.u2.id,createdAt:at('2026-07-07',10),amount:'900',version:3});
 signals.push({id:manyChanges,entryDate:'2026-08-03',periodId:openPeriodId,postedAt:at('2026-08-03',10),postedBy:fixture.u1.id,createdAt:at('2026-08-03',10),amount:'640',version:1});
 signals.push({id:manyLines,entryDate:'2026-08-04',periodId:openPeriodId,postedAt:at('2026-08-04',10),postedBy:fixture.u1.id,createdAt:at('2026-08-04',10),amount:'810',lines:105,version:1});
 await journals(pool,companyId,creator,accountId,[...filler,...straddle,...signals]);
 changeRows.push({entityType:'fiscal_period',entityId:closedPeriodId,action:'fiscal_period.close',occurredAt:at('2026-01-31',17),version:1});
 changeRows.push({entityType:'fiscal_period',entityId:closedPeriodId,action:'fiscal_period.lock',occurredAt:at('2026-07-06',18),version:2});
 for(let index=0;index<105;index++)changeRows.push({entityType:'journal_entry',entityId:manyChanges,action:'journal.amended',occurredAt:at('2026-08-03',11,index%60),version:index+1});
 changeRows.push({entityType:'journal_entry',entityId:amended,action:'journal.amended',occurredAt:at('2026-07-08',10),version:1});
 await changes(pool,companyId,creator,evidenceId,changeRows);
 const overflowPerson=randomUUID();
 await journals(pool,companyId,creator,accountId,Array.from({length:OVERFLOW_ROWS},():JournalSeed=>({id:randomUUID(),entryDate:'2027-01-05',
  periodId:openPeriodId,postedAt:at('2027-01-05',10),postedBy:overflowPerson,createdAt:at('2027-01-05',10),amount:'40',version:1})));
 return{accountId,openPeriodId,closedPeriodId,thresholdId,straddlePerson};
}
