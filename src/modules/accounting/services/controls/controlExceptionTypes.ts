import {UUID_RE,isRealCalendarDate} from '@/lib/validation';
import type {ControlCheckResult,ControlFinding} from './contracts';
import {canonicalJson} from './canonical';
import {riskOptions,type RiskCheckOptions} from './invoiceRiskQueriesResult';
export const EXCEPTION_CHECK_VERSIONS={duplicate_invoice_checks:1,payment_risk_checks:1,three_way_match_exceptions:1,
 journal_risk_checks:1,bank_statement_completeness:1} as const;
export type ExceptionCheckId=keyof typeof EXCEPTION_CHECK_VERSIONS;
export type ExceptionStatus='open'|'fixed'|'accepted_risk';
export interface ExceptionCheckInput extends RiskCheckOptions {checkId:ExceptionCheckId}
export interface ExceptionResolution {exceptionId:string;expectedVersion:number;resolution:'fixed'|'accepted_risk';reason:string;expiresAt?:string}
export interface ExceptionAssignment {exceptionId:string;expectedVersion:number;ownerPersonId:string;dueAt:string|null}
export interface ExceptionRow {
 company_id:string;id:string;check_id:ExceptionCheckId;finding_key:string;cutoff:Date|string|null;check_version:number;
 finding:ControlFinding;severity:ControlFinding['severity'];status:ExceptionStatus;version:number;reporter_person_id:string;
 owner_person_id:string|null;due_at:Date|string|null;occurrence_count:number;first_seen_at:Date|string;last_seen_at:Date|string;
 reviewer_person_id:string|null;resolution_reason:string|null;risk_expires_at:Date|string|null;last_recheck:unknown;updated_at:Date|string;
}
function object(input:unknown,keys:readonly string[]):Record<string,unknown>{
 // Canonicalization validates descriptors before reading values, then detaches all caller state.
 const detached:unknown=JSON.parse(canonicalJson(input));
 if(!detached||typeof detached!=='object'||Array.isArray(detached)||Object.keys(detached).some(k=>!keys.includes(k)))throw new Error('Invalid exception input');
 return detached as Record<string,unknown>;
}
export function exceptionCheckId(value:unknown):ExceptionCheckId{
 if(typeof value!=='string'||!Object.hasOwn(EXCEPTION_CHECK_VERSIONS,value))throw new Error('Unsupported exception check');return value as ExceptionCheckId;
}
export function parseExceptionCheck(value:unknown):ExceptionCheckInput{
 const input=object(value,['checkId','cutoff','cursor','limit']),checkId=exceptionCheckId(input.checkId);
 const {checkId:_id,...options}=input;riskOptions(options as RiskCheckOptions);return{checkId,...options};
}
function versioned(input:Record<string,unknown>){
 if(typeof input.exceptionId!=='string'||!UUID_RE.test(input.exceptionId)||!Number.isSafeInteger(input.expectedVersion)||Number(input.expectedVersion)<1)throw new Error('Invalid exception version or ID');
 return{exceptionId:input.exceptionId,expectedVersion:Number(input.expectedVersion)};
}
function instant(value:unknown):string{
 if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!isRealCalendarDate(value.slice(0,10))||!Number.isFinite(Date.parse(value)))throw new Error('Invalid exception timestamp');
 return new Date(value).toISOString();
}
export function parseExceptionAssignment(value:unknown):ExceptionAssignment{
 const input=object(value,['exceptionId','expectedVersion','ownerPersonId','dueAt']),base=versioned(input);
 if(typeof input.ownerPersonId!=='string'||!input.ownerPersonId.trim()||input.ownerPersonId.length>200)throw new Error('Invalid exception owner');
 return{...base,ownerPersonId:input.ownerPersonId,dueAt:input.dueAt===null?null:instant(input.dueAt)};
}
export function parseExceptionResolution(value:unknown):ExceptionResolution{
 const input=object(value,['exceptionId','expectedVersion','resolution','reason','expiresAt']),base=versioned(input);
 if(!['fixed','accepted_risk'].includes(String(input.resolution))||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new Error('Exception resolution and reason required');
 const expiresAt=input.expiresAt===undefined?undefined:instant(input.expiresAt);
 if(input.resolution==='accepted_risk'&&(!expiresAt||Date.parse(expiresAt)<=Date.now()))throw new Error('Accepted risk needs future expiry');
 if(input.resolution==='fixed'&&expiresAt!==undefined)throw new Error('Fixed exception cannot expire');
 return{...base,resolution:input.resolution as ExceptionResolution['resolution'],reason:input.reason.trim(),...(expiresAt?{expiresAt}:{})};
}
/** Conservative whole-check gate: unrelated findings also block closure until target assurance exists. */
export function canFixException(result:ControlCheckResult,checkId:string,observedVersion:number):boolean{
 return Object.hasOwn(EXCEPTION_CHECK_VERSIONS,checkId)&&result.checkId===checkId
  &&result.checkVersion===EXCEPTION_CHECK_VERSIONS[checkId as ExceptionCheckId]&&result.checkVersion===observedVersion
  &&result.status==='pass'&&result.findingCount===0&&result.findings.length===0&&result.nextCursor===null&&result.missingSources.length===0;
}
export function exceptionCheckSummary(result:ControlCheckResult){
 const {findings:_findings,...summary}=result;
 // Preserve the exact source basis; reserve space below the 1 MiB JSONB storage bound.
 if(Buffer.byteLength(canonicalJson(summary),'utf8')>900*1024)throw new Error('Complete recheck evidence requires asynchronous retained evidence');
 return summary;
}
export function exceptionView(row:ExceptionRow){
 const date=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
 return{id:row.id,checkId:row.check_id,findingKey:row.finding_key,cutoff:row.cutoff===null?null:date(row.cutoff)!.slice(0,10),
  checkVersion:row.check_version,finding:row.finding,severity:row.severity,status:row.status,version:row.version,
  reporterPersonId:row.reporter_person_id,ownerPersonId:row.owner_person_id,dueAt:date(row.due_at),occurrenceCount:row.occurrence_count,
  firstSeenAt:date(row.first_seen_at),lastSeenAt:date(row.last_seen_at),reviewerPersonId:row.reviewer_person_id,
  resolutionReason:row.resolution_reason,riskExpiresAt:date(row.risk_expires_at),riskExpired:row.status==='accepted_risk'&&row.risk_expires_at!==null&&new Date(row.risk_expires_at).getTime()<=Date.now(),
  lastRecheck:row.last_recheck,updatedAt:date(row.updated_at)};
}

export function parseExceptionList(value:unknown){
 const input=object(value,['checkId','status','cursor','limit']),checkId=exceptionCheckId(input.checkId),limit=input.limit??20;
 if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>100
  ||(input.cursor!==undefined&&(typeof input.cursor!=='string'||!UUID_RE.test(input.cursor)))
  ||(input.status!==undefined&&(typeof input.status!=='string'||!['open','fixed','accepted_risk'].includes(input.status))))throw new Error('Invalid exception list');
 return{checkId,limit,cursor:input.cursor as string|undefined,status:input.status as ExceptionStatus|undefined};
}
