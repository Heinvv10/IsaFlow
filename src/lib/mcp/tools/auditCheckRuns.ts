import {z} from 'zod';
import type {McpTool} from '../types';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {AUDIT_CHECK_RUN_IDS} from '@/modules/accounting/services/controls/auditCheckRunContract';
import {getAuditCheckRunPage,getAuditCheckRunSummary} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {AuditEnqueueQuotaError} from '@/modules/accounting/services/controls/auditEnqueueQuota';
import {ok,toolError} from './toolHelpers';
const uuid={type:'string',format:'uuid'},key={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$'};
const id=z.string().uuid(),retry=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
function writeInput(args:Record<string,unknown>,companyId:string){
 const {company_id,...input}=args;
 if(company_id!=null&&company_id!==companyId)throw new Error('Company assertion mismatch');
 return input;
}
function tool<T>(name:string,description:string,scope:'write:audit'|'read:reports',properties:Record<string,unknown>,required:string[],schema:z.ZodType<T>,run:(input:T)=>Promise<unknown>):McpTool{
 const write=scope==='write:audit';
 return{name,description,scope,write,inputSchema:{type:'object',additionalProperties:false,properties,required},handler:async(args,ctx)=>{
  const parsed=schema.safeParse(write?writeInput(args,ctx.companyId):args);if(!parsed.success)return toolError('Invalid check run arguments');
  // A refused rate is an answer the agent must read, not a failure that invites the retry the rate exists to stop.
  try{return ok(await run(parsed.data));}
  catch(error){if(error instanceof AuditEnqueueQuotaError)return toolError(error.message);throw error;}
 }};
}
const runChecks=tool('run_control_checks',
 'Enqueue one durable complete-population control check run per requested check. Returns a run group and its job IDs; no scan runs in this request. Requires the opt-in write:audit scope plus current report permissions, which the worker rechecks.',
 'write:audit',{cutoff:{type:'string',format:'date'},checks:{type:'array',items:{type:'string',enum:[...AUDIT_CHECK_RUN_IDS]},minItems:1,maxItems:6},idempotency_key:key},
 ['cutoff','checks','idempotency_key'],
 z.object({cutoff:z.string(),checks:z.array(z.enum(AUDIT_CHECK_RUN_IDS)).min(1).max(6),idempotency_key:retry}).strict(),
 async({idempotency_key,...request})=>enqueueAuditCheckRuns(requireControlTx(),{...request,idempotencyKey:idempotency_key}));
const checkRun=tool('control_check_run',
 'Read the sealed verdict of a completed control check run: status, complete population and finding counts, amount totals, coverage and missing sources. Read the findings themselves with control_check_run_findings.',
 'read:reports',{check_run_id:uuid},['check_run_id'],z.object({check_run_id:id}).strict(),
 async input=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:input.check_run_id}));
const checkRunFindings=tool('control_check_run_findings',
 'Read at most 100 authenticated findings of a completed control check run, in ordinal order, with the complete finding count and a continuation cursor. Every finding seal is verified against the published header.',
 'read:reports',{check_run_id:uuid,limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',pattern:'^(0|[1-9][0-9]{0,5})$'}},['check_run_id'],
 z.object({check_run_id:id,limit:z.number().int().min(1).max(100).optional(),cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()}).strict(),
 async({check_run_id,...options})=>getAuditCheckRunPage(requireControlTx(),{checkRunId:check_run_id,...options}));
runChecks.perUserIdempotency=true;
/**
 * No `authorize` hook. Enqueueing is a write gated on the opt-in `write:audit` scope: `assertCurrentToolAuthority`
 * checks it against CURRENT effective permissions before any handler runs, and `enqueueAuditCheckRuns` asserts
 * `write:audit` and every read permission its intents derive inside the transaction that writes them — which also
 * covers REST, where there is no tool boundary. A third copy here would be provable by no gate.
 */
export const auditCheckRunTools=[runChecks,checkRun,checkRunFindings] as const;
