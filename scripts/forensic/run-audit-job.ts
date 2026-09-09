#!/usr/bin/env node
import {decodeAuditProcessRequest,encodeAuditProcessReply} from '../../src/modules/accounting/services/controls/auditJobProcessProtocol';
import {AUDIT_PROCESS_LIMITS} from '../../src/modules/accounting/services/controls/auditJobProcessContract';
import type {AuditWorkerResult} from '../../src/modules/accounting/services/controls/auditJobRunner';
/** This executable is private. Its stdin carries identity only, never a principal, lease or business request. */
async function main(){
 const writeReply=process.stdout.write.bind(process.stdout),writeDiagnostic=process.stderr.write.bind(process.stderr);
 let diagnostics=0;
 // Domain logging may contain source facts. Keep it out of IPC while retaining sanitized diagnostic occurrence counts.
 const sanitizeWrite=((_chunk:unknown,encoding?:unknown,callback?:unknown)=>{
  const line='Audit child emitted a diagnostic; details withheld.\n';
  if(diagnostics+Buffer.byteLength(line)<=AUDIT_PROCESS_LIMITS.maxDiagnosticBytes){diagnostics+=Buffer.byteLength(line);writeDiagnostic(line);}
  const done=typeof encoding==='function'?encoding:callback;if(typeof done==='function')done();return true;
 }) as typeof process.stdout.write;
 process.stdout.write=sanitizeWrite;process.stderr.write=sanitizeWrite;
 const controller=new AbortController(),shutdown=()=>controller.abort(new Error('Audit child shutdown'));
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 let input=Buffer.alloc(0),delivered=false;
 let resolveEnd:()=>void=()=>undefined;
 const ended=new Promise<void>(resolve=>{resolveEnd=resolve;});
 const request=new Promise<ReturnType<typeof decodeAuditProcessRequest>>((resolve,reject)=>{
  process.stdin.on('data',(chunk:Buffer)=>{
   if(delivered||input.length+chunk.length>AUDIT_PROCESS_LIMITS.maxRequestBytes){controller.abort();reject(new Error('Audit child input invalid'));return;}
   input=Buffer.concat([input,chunk]);
   if(input.includes(10)){try{delivered=true;resolve(decodeAuditProcessRequest(input));}catch{reject(new Error('Audit child input invalid'));}}
  });
  process.stdin.once('end',()=>{resolveEnd();if(!delivered)reject(new Error('Audit child identity missing'));});
  process.stdin.once('error',()=>{controller.abort();reject(new Error('Audit child input unavailable'));});
 });
 let result:AuditWorkerResult={state:'failed',code:'WORKER_ERROR',failureRecorded:false};
 try{
  const identity=await request,connectionString=process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL;
  if(!connectionString)throw new Error('Private audit database configuration missing');
  controller.signal.throwIfAborted();process.env.DATABASE_URL=connectionString;
  const {Pool}=await import('pg'),pool=new Pool({connectionString,max:2,connectionTimeoutMillis:5000,application_name:`isaflow-audit:${identity.jobId}`,
   ssl:process.env.DATABASE_SSL==='disable'?false:process.env.DATABASE_SSL==='strict'?{rejectUnauthorized:true}:undefined});
  try{const {runAuditJob}=await import('../../src/modules/accounting/services/controls/auditJobRunner');
   result=await runAuditJob({companyId:identity.companyId,personId:identity.personId,jobId:identity.jobId},{pool,signal:controller.signal});
  }finally{await pool.end();}
 }catch{result={state:'failed',code:controller.signal.aborted?'CANCELLED':'WORKER_ERROR',failureRecorded:false};}
 finally{process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);}
 await new Promise<void>((resolve,reject)=>writeReply(encodeAuditProcessReply({version:1,result}),error=>error?reject(error):resolve()));
 // Parent samples the live unit's cgroup peak, then acknowledges by closing stdin. The hard service deadline still applies.
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([ended,new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);})]);}finally{clearTimeout(timer);process.stdin.destroy();}
}
// This one-job executable must not inherit the lifetime of incidental library handles.
void main().then(()=>process.exit(0),()=>process.exit(1));
