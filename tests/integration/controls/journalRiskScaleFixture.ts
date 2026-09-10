import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
/**
 * Plan §3 fixture (a), built server-side so 100k journals seed in minutes rather than hours:
 *  - posted journals, 3-10 lines each, posted_at spread over SAST hours (a seventh at 20:00) and every weekday
 *    including weekends; about 1 in 13 has no posted_at (creation-time basis), 1 in 19 is backdated a day, and 1 in 20
 *    sits in a 2025 period that was closed and then locked in January 2026;
 *  - 0-20 amendment events per journal, and the period close/lock events that make those chronologies meaningful;
 *  - 10 active journal rules: 8 the detector can use, 2 at operator 'any', which it cannot (plan v7 A24 door 3).
 *
 * Seeding runs with session_replication_role = replica for THIS connection only: the per-line account-balance
 * trigger would otherwise update one gl_accounts row 650k times, and every FK here is satisfied by construction.
 * Nothing about the rows the check reads depends on those triggers. Never call this against the shared fixture.
 *
 * Profile `quiet` keeps the same per-row streaming cost (the same 3-10 lines and 0-20 amendments, which is where the
 * cursor spends its time) but posts every journal on a weekday in business hours on its own accounting date, so the
 * finding count stays far below maxFindings and a deadline measurement is not confounded by the findings bound.
 */
export interface ScaleCensus {journals:number;lines:number;changes:number;versions:number;rules:number;seedMs:number}
export const SCALE_CUTOFF='2026-09-09';
export type ScaleProfile='mixed'|'quiet';
export async function seedJournalRiskScale(pool:Pool,fixture:ForensicFixture,journals:number,profile:ScaleProfile='mixed'):Promise<ScaleCensus>{
 if(!Number.isSafeInteger(journals)||journals<1||journals>3200000)throw new Error('Bounded journal count required');
 const quiet=profile==='quiet';
 const started=Date.now(),company=fixture.companyA,creator=fixture.u1.id,account=randomUUID(),open=randomUUID(),closed=randomUUID(),evidence=randomUUID();
 const people=Array.from({length:50},()=>randomUUID()),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
  await client.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Scale','asset','debit')`,[account,company]);
  await client.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
   VALUES($1,$3,'Open 2026',1,2026,'2026-01-01','2026-12-31','open'),($2,$3,'Closed 2025',12,2025,'2025-01-01','2025-12-31','closed')`,[open,closed,company]);
  await client.query(`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext)
   VALUES($1,$2,'journal_entry','scale','current',1,'00')`,[company,evidence]);
  await client.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
   SELECT gen_random_uuid(),$1,'Scale '||r.n,'journal_entry','amount',r.op,r.amount*$2::numeric,'admin',true
   FROM (VALUES(1,'greater_than',70000),(2,'greater_equal',90000),(3,'greater_than',120000),(4,'greater_equal',150000),(5,'greater_than',200000),
    (6,'greater_equal',250000),(7,'greater_than',300000),(8,'greater_equal',400000),(9,'any',0),(10,'any',0)) AS r(n,op,amount)`,
   // Quiet rules sit far above any (day, person) total, so no threshold group splits; the rules still load and loop.
   [company,quiet?1000:1]);
  await client.query(`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,status,source,posted_at,posted_by,created_at,created_by)
   SELECT gen_random_uuid(),$1,'S'||g,d.entry,CASE WHEN NOT $7 AND g%20=0 THEN $3::uuid ELSE $2::uuid END,'posted','manual',
    CASE WHEN NOT $7 AND g%13=0 THEN NULL ELSE d.posted END,($4::uuid[])[1+g%50],d.posted,$5::uuid
   FROM generate_series(1,$6::int) g
   CROSS JOIN LATERAL(SELECT CASE WHEN $7 THEN date '2026-01-05'+((g%240)/5)*7+(g%240)%5 ELSE date '2026-01-01'+(g%240) END AS day) a
   CROSS JOIN LATERAL(SELECT CASE WHEN $7 THEN a.day WHEN g%20=0 THEN date '2025-12-15'+(g%10) WHEN g%19=0 THEN a.day-1 ELSE a.day END AS entry,
    ((a.day::timestamp+make_interval(hours=>CASE WHEN NOT $7 AND g%7=0 THEN 20 ELSE 8+g%9 END,mins=>g%60)) AT TIME ZONE 'Africa/Johannesburg') AS posted) d`,
   [company,open,closed,people,creator,journals,quiet]);
  await client.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit)
   SELECT $1,j.id,$2,CASE WHEN k%2=1 THEN 100+abs(hashtext(j.id::text||k))%1900 ELSE 0 END,CASE WHEN k%2=0 THEN 100+abs(hashtext(j.id::text||k))%1900 ELSE 0 END
   FROM gl_journal_entries j CROSS JOIN LATERAL generate_series(1,3+abs(hashtext(j.id::text))%8) k WHERE j.company_id=$1`,[company,account]);
  await client.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
   SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),'human','fiscal_period',$3::text,NULLIF(e.v-1,0),e.v,e.action,e.at,$4
   FROM (VALUES(1,'fiscal_period.close',timestamptz '2026-01-31 17:00+02'),(2,'fiscal_period.lock',timestamptz '2026-02-02 09:00+02')) AS e(v,action,at)`,[company,creator,closed,evidence]);
  await client.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
   SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),'human','journal_entry',j.id::text,NULLIF(k-1,0),k,'journal.amended',
    COALESCE(j.posted_at,j.created_at)+make_interval(mins=>k),$3
   FROM gl_journal_entries j CROSS JOIN LATERAL generate_series(1,abs(hashtext(j.id::text||'c'))%21) k WHERE j.company_id=$1`,[company,creator,evidence]);
  await client.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
   SELECT $1,'journal_entry',j.id::text,1,repeat('f',64) FROM gl_journal_entries j WHERE j.company_id=$1 AND abs(hashtext(j.id::text||'v'))%10<>0`,[company]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await pool.query('ANALYZE gl_journal_entries,gl_journal_lines,control_change_events,control_entity_versions');
 const [row]=(await pool.query(`SELECT (SELECT count(*)::int FROM gl_journal_entries WHERE company_id=$1) AS journals,
  (SELECT count(*)::int FROM gl_journal_lines WHERE company_id=$1) AS lines,
  (SELECT count(*)::int FROM control_change_events WHERE company_id=$1) AS changes,
  (SELECT count(*)::int FROM control_entity_versions WHERE company_id=$1) AS versions,
  (SELECT count(*)::int FROM approval_rules WHERE company_id=$1 AND document_type='journal_entry' AND is_active) AS rules`,[company])).rows;
 return{...row,seedMs:Date.now()-started} as ScaleCensus;
}
/**
 * The findings path's worst case (T2e review): every journal is a finding carrying the longest message the detector
 * can write — all six per-row signals plus a split under each of 100 usable rules whose versions are bigint's widest
 * (19 digits), about 8.7 KB of message per finding. Replica mode also lets `control_version` hold that width, which the
 * policy trigger would otherwise reset to 1. Groups of 500 journals per (Saturday, person) keep every slab small.
 */
export async function seedMaxMessageFindings(pool:Pool,fixture:ForensicFixture,journals:number):Promise<ScaleCensus>{
 if(!Number.isSafeInteger(journals)||journals<1||journals>100000)throw new Error('Bounded journal count required');
 const started=Date.now(),company=fixture.companyA,creator=fixture.u1.id,account=randomUUID(),closed=randomUUID(),evidence=randomUUID();
 const people=Array.from({length:50},()=>randomUUID()),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query("SET LOCAL session_replication_role='replica'");
  await client.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Worst','asset','debit')`,[account,company]);
  await client.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Closed 2025',12,2025,'2025-01-01','2025-12-31','closed')`,[closed,company]);
  await client.query(`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext) VALUES($1,$2,'journal_entry','worst','current',1,'00')`,[company,evidence]);
  await client.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active,control_version)
   SELECT gen_random_uuid(),$1,'Worst '||n,'journal_entry','amount','greater_than',1.5,'admin',true,9223372036854775807 FROM generate_series(1,100) n`,[company]);
  await client.query(`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,status,source,posted_at,posted_by,created_at,created_by,reversed_at)
   SELECT gen_random_uuid(),$1,'W'||g,date '2025-12-15',$2,'posted','manual',p.at,($3::uuid[])[1+g%50],p.at,$4,p.at+interval '1 day'
   FROM generate_series(1,$5::int) g CROSS JOIN LATERAL(SELECT ((date '2026-02-07'+7*(g%40))::timestamp+interval '20 hours') AT TIME ZONE 'Africa/Johannesburg' AS at) p`,
   [company,closed,people,creator,journals]);
  await client.query(`INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,id,$2,1,0 FROM gl_journal_entries WHERE company_id=$1`,[company,account]);
  await client.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
   SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),'human','fiscal_period',$3::text,NULL,1,'fiscal_period.close',timestamptz '2026-01-31 17:00+02',$4`,[company,creator,closed,evidence]);
  await client.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
   SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),'human','journal_entry',id::text,NULL,1,'journal.amended',posted_at+interval '1 minute',$3
   FROM gl_journal_entries WHERE company_id=$1`,[company,creator,evidence]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 await pool.query('ANALYZE gl_journal_entries,gl_journal_lines,control_change_events,approval_rules');
 return{journals,lines:journals,changes:journals+1,versions:0,rules:100,seedMs:Date.now()-started};
}
