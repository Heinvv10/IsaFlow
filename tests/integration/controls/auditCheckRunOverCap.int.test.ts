import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {collectSnapshotCheckPages} from '@/modules/accounting/services/controls/auditSnapshotCheckCapture';
import {getAuditCheckRunPage} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import type {ControlFinding} from '@/modules/accounting/services/controls/contracts';
/**
 * Plan v6 A5/A14 + A20 over the sync cap. 10 001 posted journals — one past the synchronous detector's 10 000 — on
 * weekdays in business hours, except one in forty posted at 20:00, so there are well over 100 findings and paging is
 * real on both sides. One of them carries 150 amendment events, past the 101 change facts either path reads. The
 * oracle is the unmodified detector with ONLY its source page raised (sourceFetch 200 001) through the A14 seam.
 */
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
const JOURNALS=10001,CHANGES=150,CUTOFF='2026-09-09';
let fixture:ForensicFixture,manyChanges:string;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 const company=fixture.companyA,account=randomUUID(),evidence=randomUUID();manyChanges=randomUUID();
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Over cap','asset','debit')`,[account,company]);
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
  VALUES(gen_random_uuid(),$1,'Over cap rule','journal_entry','amount','greater_than',10000,'admin',true)`,[company]);
 await pool.query(`INSERT INTO control_protected_evidence(company_id,id,entity_type,entity_id,key_id,envelope_version,ciphertext) VALUES($1,$2,'journal_entry','over-cap','current',1,'00')`,[company,evidence]);
 // Day d in 0..149 maps to Monday 2026-02-02 plus whole weeks and a weekday offset: never a weekend.
 await pool.query(`WITH src AS (
   SELECT CASE WHEN g=1 THEN $4::uuid ELSE gen_random_uuid() END AS id,g,
    date '2026-02-02'+((g%150)/5)*7+(g%150)%5 AS day FROM generate_series(1,$5::int) g),
  entries AS (INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,posted_at,posted_by,created_at,created_by)
   SELECT id,$1,'OC'||g,day,'posted','manual',
    ((day::timestamp+make_interval(hours=>CASE WHEN g%40=0 THEN 20 ELSE 9+g%8 END)) AT TIME ZONE 'Africa/Johannesburg'),
    ($6::uuid[])[1+g%20],((day::timestamp+interval '9 hours') AT TIME ZONE 'Africa/Johannesburg'),$3 FROM src RETURNING id)
  INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,e.id,$2,100,0 FROM entries e`,
 [company,account,fixture.u1.id,manyChanges,JOURNALS,Array.from({length:20},()=>randomUUID())]);
 // Every journal carries a version, so sourceVersions counts exactly the rows each path analysed.
 await pool.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash)
  SELECT $1,'journal_entry',id::text,1,repeat('f',64) FROM gl_journal_entries WHERE company_id=$1`,[company]);
 await pool.query(`INSERT INTO control_change_events(company_id,id,person_id,request_id,operation_id,provenance,entity_type,entity_id,previous_version,new_version,action,occurred_at,protected_evidence_id)
  SELECT $1,gen_random_uuid(),$2,gen_random_uuid(),gen_random_uuid(),'human','journal_entry',$3::text,NULLIF(k-1,0),k,'journal.amended',timestamptz '2026-02-03 10:00+02'+make_interval(mins=>k),$4
  FROM generate_series(1,$5::int) k`,[company,fixture.u1.id,manyChanges,evidence,CHANGES]);
},180000);
afterAll(()=>pool.end());
const who=()=>({companyId:fixture.companyA,personId:fixture.u1.id});
const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{...who(),jobId:randomUUID()},'read committed',Date.now()+240000,undefined,
 store=>withControlRequest(store,{...who(),authMethod:'cookie'},work));
const byKey=(findings:readonly ControlFinding[])=>new Map(findings.map(finding=>[finding.key,
 canonicalJson({kind:finding.kind,severity:finding.severity,classification:finding.classification,entities:finding.entities,message:finding.message,evidence:finding.evidence})]));
it('the sync detector at its default limits truncates to 10 000 rows and says so',async()=>{
 const page=await actor(()=>checkJournalRisks(requireControlTx(),{cutoff:CUTOFF,limit:100}));
 expect(page.missingSources).toContain('async_scan_required:journal_population_exceeds_10000');
 expect(page.populationCount,'the population count is the window COUNT over every row, not the 10 000 analysed').toBe(JOURNALS);
 expect(page.sourceVersions,'the default path did not analyse exactly its 10 000 rows').toHaveLength(JOURNALS-1);
 expect(page.missingSources).toContain('journal_change_history_exceeds_100');
},240000);
it('the raised-limit oracle reads every row, and the published run equals it on every A20 field',async()=>{
 const oracle=await actor(()=>collectSnapshotCheckPages(cursor=>checkJournalRisks(requireControlTx(),{cutoff:CUTOFF,limit:100,...(cursor?{cursor}:{})},{sourceFetch:200001}),()=>undefined));
 expect(oracle.missingSources,'the oracle still truncated at 10 000').not.toContain('async_scan_required:journal_population_exceeds_10000');
 expect(oracle.findingCount,'too few findings to page on the oracle side').toBeGreaterThan(100);
 expect(oracle.sourceVersions,'the oracle did not read every row').toHaveLength(JOURNALS);
 const run=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:CUTOFF,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const jobId=run.jobs[0]!.id;
 expect(await runAuditJob({...who(),jobId},{pool,workerClass:'check_run'})).toMatchObject({state:'succeeded',checkRunId:jobId});
 const first=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100}));
 const findings=[...first.findings];let cursor=first.nextCursor,pages=1;
 while(cursor){const page=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100,cursor}));findings.push(...page.findings);cursor=page.nextCursor;pages++;}
 expect(pages,'the run was not genuinely paged').toBeGreaterThan(1);
 for(const field of ['checkId','checkVersion','cutoff','status','populationCount','excludedCount','findingCount','amountTotals','coverage','missingSources'] as const)
  expect(canonicalJson(first[field]),`run.${field} differs from the raised-limit oracle`).toBe(canonicalJson(oracle[field]));
 expect(first.populationCount).toBe(JOURNALS);
 expect(first.missingSources).toContain('journal_change_history_exceeds_100');
 const [mine,theirs]=[byKey(findings),byKey(oracle.findings)];
 expect([...mine.keys()].sort(),'finding keys differ from the raised-limit oracle').toEqual([...theirs.keys()].sort());
 for(const [key,value] of mine)expect(value,`finding ${key} differs from the raised-limit oracle`).toBe(theirs.get(key));
},240000);
