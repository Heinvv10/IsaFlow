import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {openAuditJobRequest,auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
import {auditJobRequestPermissions} from '@/modules/accounting/services/controls/auditJobDelegation';
import {AUDIT_JOB_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {AUDIT_CHECK_RUN_IDS,AUDIT_CHECK_RUN_LIMITS,AUDIT_CHECK_RUN_QUOTA,auditCheckRunGroupId,auditCheckRunIntents,
 parseAuditCheckRunRequest,parseStoredAuditCheckRunRequest} from '@/modules/accounting/services/controls/auditCheckRunContract';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
const company='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222',person='synthetic-person';
const input={cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:'run-1'};
function row(kind:string,request:unknown){
 const body={companyId:company,jobId:job,kind,request,authority:{personId:person,authMethod:'cookie',connectionId:null,grantId:null,grantedScopes:null,actingFirmId:null},delegationExpiresAt:'2026-09-10T20:00:00.000Z'};
 return{kind,company_id:company,id:job,requester_person_id:person,request_hash:auditRequestHash(request),protected_request:protectChangeValues('audit_job',null,body).protectedPayload};
}
it('publishes the shared kind list and the spike-measured journal limits',()=>{
 expect(AUDIT_JOB_KINDS).toEqual(['audit_snapshot','audit_export','audit_compare','audit_check_run']);
 expect(AUDIT_CHECK_RUN_IDS).toEqual(['journal_risk_checks']);
 expect(AUDIT_CHECK_RUN_LIMITS.journal_risk_checks).toEqual({maxRuntimeMs:300000,graceMs:30000,idleMs:15000,fetchRows:1000,maxSlabRows:1000,maxFindings:100000,workMem:'64MB'});
 expect(Object.isFrozen(AUDIT_CHECK_RUN_LIMITS)&&Object.isFrozen(AUDIT_CHECK_RUN_LIMITS.journal_risk_checks)).toBe(true);
 // A RATE, never an absolute count: the absolute cap turned the 101st run into a permanent lockout.
 expect(AUDIT_CHECK_RUN_QUOTA).toEqual({maxActiveJobs:6,maxJobsPerWindow:100,windowHours:24});
});
it('public input cannot choose tenant, authority, permissions, limits or a group identity',()=>{
 expect(parseAuditCheckRunRequest({...input,checks:['journal_risk_checks','journal_risk_checks']})).toEqual(input);
 for(const extra of [{companyId:company},{permissions:['read:reports']},{runGroupId:job},{personId:'other'},{limits:{maxRuntimeMs:1}}])
  expect(()=>parseAuditCheckRunRequest({...input,...extra})).toThrow();
 for(const changed of [{cutoff:'2026-02-30'},{checks:[]},{checks:['duplicate_invoice_checks']},{idempotencyKey:''},{idempotencyKey:'x'.repeat(101)},{idempotencyKey:'bad key'}])
  expect(()=>parseAuditCheckRunRequest({...input,...changed})).toThrow();
});
it('derives one intent per check with a bounded key and a stable group identity',()=>{
 const longest={...input,idempotencyKey:'k'.repeat(100)};
 const [intent]=auditCheckRunIntents(company,person,parseAuditCheckRunRequest(longest));
 expect(intent).toEqual({cutoff:'2026-09-09',checkId:'journal_risk_checks',checks:['journal_risk_checks'],userKey:'k'.repeat(100),
  idempotencyKey:`${'k'.repeat(100)}:journal_risk_checks`,runGroupId:auditCheckRunGroupId(company,person,'k'.repeat(100)),permissions:['read:reports']});
 expect(intent!.idempotencyKey.length).toBeLessThanOrEqual(128);
 expect(auditCheckRunGroupId(company,person,'run-1')).toBe(auditCheckRunGroupId(company,person,'run-1'));
 for(const other of [auditCheckRunGroupId(company,'other',input.idempotencyKey),auditCheckRunGroupId(job,person,input.idempotencyKey),auditCheckRunGroupId(company,person,'run-2')])
  expect(other).not.toBe(auditCheckRunGroupId(company,person,input.idempotencyKey));
 expect(auditCheckRunGroupId(company,person,'run-1')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
it('rejects stored requests whose derived fields were not derived from the rest',()=>{
 const [stored]=auditCheckRunIntents(company,person,parseAuditCheckRunRequest(input));
 expect(parseStoredAuditCheckRunRequest(stored)).toEqual(stored);
 for(const changed of [{idempotencyKey:'run-1:other'},{permissions:['read:invoices','read:reports']},{permissions:[]},{checks:[]},{checkId:'payment_risk_checks'},{runGroupId:'not-a-uuid'},{extra:true}])
  expect(()=>parseStoredAuditCheckRunRequest({...stored,...changed})).toThrow();
});
it('opens authenticated check-run intents, derives permissions from the check and refuses kind swaps',()=>{
 const [stored]=auditCheckRunIntents(company,person,parseAuditCheckRunRequest(input));
 const opened=openAuditJobRequest(row('audit_check_run',stored));
 expect(opened).toMatchObject({kind:'audit_check_run',request:stored});
 expect(auditJobRequestPermissions(opened)).toEqual(['read:reports']);
 expect(()=>openAuditJobRequest({...row('audit_check_run',stored),kind:'audit_snapshot'})).toThrow();
 expect(()=>openAuditJobRequest(row('audit_snapshot',stored))).toThrow();
 expect(()=>openAuditJobRequest(row('audit_check_run',{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:'snapshot-1'}))).toThrow();
 expect(()=>openAuditJobRequest(row('audit_unknown',stored))).toThrow();
});
