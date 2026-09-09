import {randomUUID} from 'node:crypto';
import {als} from '@/lib/als';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlCheckResult,ControlTx} from './contracts';
import {assertExceptionReadPermission,runExceptionCheck} from './controlExceptionRecheck';
import {canFixException,exceptionCheckId,exceptionCheckSummary,exceptionView,parseExceptionAssignment,
 parseExceptionCheck,parseExceptionResolution,type ExceptionRow} from './controlExceptionTypes';
async function mutation<T>(ctx:ControlTx,fn:()=>Promise<T>):Promise<T>{
 try{assertControlTx(ctx);return await withSavepoint(`exception_${randomUUID().replaceAll('-','').slice(0,18)}`,fn);}
 catch(error){const store=als.getStore();if(store)store.controlWriteFailed=true;throw error;}
}
async function load(ctx:ControlTx,id:string,lock=false):Promise<ExceptionRow>{
 const rows=lock?await ctx.sql`SELECT * FROM control_exceptions WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE`
  :await ctx.sql`SELECT * FROM control_exceptions WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid`;
 if(rows.length!==1)throw new Error('Exception not found');return rows[0] as ExceptionRow;
}
async function decision(ctx:ControlTx,row:ExceptionRow,action:string,detail:unknown){
 await ctx.sql`INSERT INTO control_exception_decisions(company_id,id,exception_id,previous_version,new_version,action,person_id,decision)
 VALUES(${ctx.principal.companyId}::uuid,${randomUUID()}::uuid,${row.id}::uuid,${row.version},${row.version+1},${action},${ctx.principal.personId},${JSON.stringify(detail)}::jsonb)`;
}
/** Explicit bounded capture; callers must follow nextCursor to observe the rest of a finding population. */
export async function captureControlExceptions(ctx:ControlTx,input:unknown){
 return mutation(ctx,async()=>{
  const parsed=parseExceptionCheck(input),result=await runExceptionCheck(ctx,parsed),ids:string[]=[];
  for(const finding of [...result.findings].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)){
   const inserted=await ctx.sql`INSERT INTO control_exceptions(company_id,id,check_id,finding_key,cutoff,check_version,finding,severity,status,version,reporter_person_id,occurrence_count)
    VALUES(${ctx.principal.companyId}::uuid,${randomUUID()}::uuid,${result.checkId},${finding.key},${result.cutoff}::date,${result.checkVersion},
    ${JSON.stringify(finding)}::jsonb,${finding.severity},'open',1,${ctx.principal.personId},1)
    ON CONFLICT(company_id,check_id,finding_key) DO NOTHING RETURNING *` as ExceptionRow[];
   let current=inserted[0],previousVersion=0;
   if(!current){
    const locked=await ctx.sql`SELECT * FROM control_exceptions WHERE company_id=${ctx.principal.companyId}::uuid
     AND check_id=${result.checkId} AND finding_key=${finding.key} FOR UPDATE` as ExceptionRow[];
    const prior=locked[0];if(!prior)throw new Error('Exception disappeared during observation');previousVersion=prior.version;
    const rows=await ctx.sql`UPDATE control_exceptions SET cutoff=${result.cutoff}::date,check_version=${result.checkVersion},finding=${JSON.stringify(finding)}::jsonb,
     severity=CASE WHEN severity='high' THEN 'high' ELSE ${finding.severity} END,status='open',version=version+1,occurrence_count=occurrence_count+1,
     last_seen_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE company_id=${ctx.principal.companyId}::uuid AND id=${prior.id}::uuid AND version=${prior.version} RETURNING *` as ExceptionRow[];
    current=rows[0];if(!current)throw new Error('Exception version changed');
   }
   const observation={...exceptionCheckSummary(result),findings:[finding],sourceVersions:result.sourceVersions.filter(v=>finding.entities.some(e=>e.entityType===v.entityType&&e.entityId===v.entityId))};
   await ctx.sql`INSERT INTO control_exception_occurrences(company_id,id,exception_id,exception_version,check_result,person_id)
    VALUES(${ctx.principal.companyId}::uuid,${randomUUID()}::uuid,${current.id}::uuid,${current.version},${JSON.stringify(observation)}::jsonb,${ctx.principal.personId})`;
   await decision(ctx,{...current,version:previousVersion},'observed',{findingKey:finding.key,cutoff:result.cutoff,checkVersion:result.checkVersion,recurrence:previousVersion>0});ids.push(current.id);
  }
  return{exceptionIds:ids,observedCount:ids.length,findingCount:result.findingCount,nextCursor:result.nextCursor,
   pageComplete:result.nextCursor===null,check:exceptionCheckSummary(result)};
 });
}
/** Retained read only; check ID is required so domain permissions precede all returned evidence. */
export async function listControlExceptions(ctx:ControlTx,input:{checkId:string;status?:string;cursor?:string;limit?:number}){
 assertControlTx(ctx);
 if(!input||Object.keys(input).some(k=>!['checkId','status','cursor','limit'].includes(k)))throw new Error('Invalid exception list');
 const checkId=exceptionCheckId(input.checkId),limit=input.limit??20;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||(input.cursor!==undefined&&!UUID_RE.test(input.cursor))
  ||(input.status!==undefined&&!['open','fixed','accepted_risk'].includes(input.status)))throw new Error('Invalid exception list');
 await assertExceptionReadPermission(ctx,checkId);
 const rows=await ctx.sql`SELECT * FROM control_exceptions WHERE company_id=${ctx.principal.companyId}::uuid AND check_id=${checkId}
  AND (${input.status??null}::text IS NULL OR status=${input.status??null})
  AND (${input.cursor??null}::uuid IS NULL OR id>${input.cursor??null}::uuid) ORDER BY id LIMIT ${limit+1}` as ExceptionRow[];
 return{exceptions:rows.slice(0,limit).map(exceptionView),nextCursor:rows.length>limit?rows[limit-1]!.id:null};
}
async function transition(ctx:ControlTx,id:string,version:number){
 const initial=await load(ctx,id);await assertExceptionReadPermission(ctx,exceptionCheckId(initial.check_id));await assertEffectivePermission(ctx,'write:approvals');
 const row=await load(ctx,id,true);if(row.version!==version)throw new Error('Exception version changed');
 if(row.status==='fixed')throw new Error('Exception already fixed');return row;
}
export async function assignControlException(ctx:ControlTx,input:unknown){
 return mutation(ctx,async()=>{
  const parsed=parseExceptionAssignment(input),row=await transition(ctx,parsed.exceptionId,parsed.expectedVersion);
  const members=await ctx.sql`SELECT user_id FROM public.control_exception_owner(${ctx.principal.companyId}::uuid,${parsed.ownerPersonId}::text)`;
  if(members.length!==1)throw new Error('Exception owner unavailable');
  const rows=await ctx.sql`UPDATE control_exceptions SET owner_person_id=${parsed.ownerPersonId},due_at=${parsed.dueAt}::timestamptz,
   version=version+1,updated_at=clock_timestamp() WHERE company_id=${ctx.principal.companyId}::uuid AND id=${row.id}::uuid AND version=${row.version} RETURNING *` as ExceptionRow[];
  if(rows.length!==1)throw new Error('Exception version changed');
  await decision(ctx,row,'assigned',{previousOwnerPersonId:row.owner_person_id,ownerPersonId:parsed.ownerPersonId,dueAt:parsed.dueAt});
  return exceptionView(rows[0]!);
 });
}
async function recheck(ctx:ControlTx,row:ExceptionRow):Promise<ControlCheckResult>{
 try{return await withSavepoint(`recheck_${randomUUID().replaceAll('-','').slice(0,18)}`,()=>runExceptionCheck(ctx,{checkId:row.check_id,
  ...(row.cutoff===null?{}:{cutoff:new Date(row.cutoff).toISOString().slice(0,10)})}));}
 catch{return{checkId:row.check_id,checkVersion:row.check_version,status:'error',populationCount:0,excludedCount:0,findingCount:0,
  findings:[],amountTotals:{},nextCursor:null,coverage:[],missingSources:['recheck_execution_error'],capturedAt:new Date().toISOString(),
  cutoff:row.cutoff===null?null:new Date(row.cutoff).toISOString().slice(0,10),sourceVersions:[]};}
}
export async function resolveControlException(ctx:ControlTx,input:unknown){
 return mutation(ctx,async()=>{
  const parsed=parseExceptionResolution(input),row=await transition(ctx,parsed.exceptionId,parsed.expectedVersion),p=ctx.principal;
  if(row.severity==='high'&&(p.authMethod!=='cookie'||p.provenance!=='human'||p.personId===row.reporter_person_id||p.personId===row.owner_person_id))throw new Error('Independent permitted human reviewer required');
  const result=parsed.resolution==='fixed'?await recheck(ctx,row):null;
  const outcome=result&&!canFixException(result,row.check_id,row.check_version)?'recheck_blocked':parsed.resolution;
  const summary=result?exceptionCheckSummary(result):null;
  const rows=await ctx.sql`UPDATE control_exceptions SET status=${outcome==='recheck_blocked'?'open':parsed.resolution},version=version+1,
   reviewer_person_id=${p.personId},resolution_reason=${parsed.reason},risk_expires_at=${parsed.expiresAt??null}::timestamptz,
   last_recheck=COALESCE(${summary===null?null:JSON.stringify(summary)}::jsonb,last_recheck),updated_at=clock_timestamp()
   WHERE company_id=${p.companyId}::uuid AND id=${row.id}::uuid AND version=${row.version} RETURNING *` as ExceptionRow[];
  if(rows.length!==1)throw new Error('Exception version changed');
  await decision(ctx,row,outcome,{reason:parsed.reason,expiresAt:parsed.expiresAt??null,recheck:summary,previousStatus:row.status});
  return{outcome,exception:exceptionView(rows[0]!)};
 });
}
