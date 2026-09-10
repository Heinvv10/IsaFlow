import {spawn,type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {AUDIT_PROCESS_ENV,AUDIT_WORKER_CLASS_ENV,AUDIT_WORKER_STARTED_AT_ENV,decodeAuditProcessReply,encodeAuditProcessRequest} from '@/modules/accounting/services/controls/auditJobProcessProtocol';
import type {AuditWorkerResult} from '@/modules/accounting/services/controls/auditJobRunner';
import type {AuditWorkerIdentity} from '@/modules/accounting/services/controls/auditWorkerTransaction';
/**
 * The REAL check-run worker executable (`scripts/forensic/build-audit-job.ts` output) as a DIRECT child of this test.
 * `createIsolatedAuditJobRunner` wraps the same artifact in `systemd-run`; this harness deliberately does not, so it
 * starts no systemd unit. What that gives up is recorded, not hidden: no RuntimeMaxSec/MemoryMax wall and no unit
 * readback. What it keeps: the same artifact, the same class heap, the same literal class and spawn-time variables,
 * the same environment allow-list, the same stdin identity protocol, and a PID this process owns outright — so a
 * SIGKILL targets exactly the worker and nothing else.
 */
export interface WorkerChild {pid:number;child:ChildProcess;result:Promise<WorkerOutcome>;peakRssBytes:()=>number}
export interface WorkerOutcome {reply:AuditWorkerResult|null;code:number|null;signal:NodeJS.Signals|null;elapsedMs:number;peakRssBytes:number;hwmBytes:number}
async function status(pid:number):Promise<{rss:number;hwm:number}|null>{
 try{
  const text=await readFile(`/proc/${pid}/status`,'utf8'),field=(name:string)=>Number(text.match(new RegExp(`^${name}:\\s+(\\d+) kB`,'m'))?.[1]??NaN)*1024;
  return{rss:field('VmRSS'),hwm:field('VmHWM')};
 }catch{return null;/* The process has exited; the last sample stands. */}
}
/** `nodePath` is the Node binary the worker runs on; a harness running under bun must pass one, as production runs Node. */
export function startCheckRunWorker(artifact:string,identity:AuditWorkerIdentity,nodePath=process.execPath):WorkerChild{
 if(!artifact.startsWith('/')||!nodePath.startsWith('/'))throw new Error('Absolute worker artifact and node binary required');
 if(!process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL)throw new Error('Explicit private audit worker database required');
 const env:NodeJS.ProcessEnv={NODE_ENV:'production'};
 for(const name of [...AUDIT_PROCESS_ENV,'HOME','USER','LANG','PATH'])if(process.env[name]!==undefined)env[name]=process.env[name];
 const started=Date.now();env[AUDIT_WORKER_CLASS_ENV]='check_run';env[AUDIT_WORKER_STARTED_AT_ENV]=String(started);
 const child=spawn(nodePath,[`--max-old-space-size=${AUDIT_PROCESS_LIMITS.check_run.maxOldSpaceMb}`,artifact],{env,stdio:['pipe','pipe','pipe']});
 if(!child.pid)throw new Error('Worker child did not start');
 const pid=child.pid;let output=Buffer.alloc(0),peak=0,hwm=0,sampling=false;
 const sampler=setInterval(()=>{if(sampling)return;sampling=true;
  void status(pid).then(read=>{if(read){if(Number.isFinite(read.rss))peak=Math.max(peak,read.rss);if(Number.isFinite(read.hwm))hwm=Math.max(hwm,read.hwm);}}).finally(()=>{sampling=false;});},200);
 child.stdout!.on('data',(chunk:Buffer)=>{output=Buffer.concat([output,chunk]);
  // The child waits for the parent to close stdin after its reply; do so as soon as the newline-framed reply lands.
  if(output.includes(10))child.stdin!.end();});
 child.stderr!.resume();
 child.stdin!.write(encodeAuditProcessRequest({version:1,...identity}));
 const result=new Promise<WorkerOutcome>(resolve=>{
  child.once('close',(code,signal)=>{clearInterval(sampler);
   let reply:AuditWorkerResult|null=null;
   try{if(output.length)reply=decodeAuditProcessReply(output).result;}catch{reply=null;/* A killed child replies nothing; null is the outcome. */}
   resolve({reply,code,signal,elapsedMs:Date.now()-started,peakRssBytes:peak,hwmBytes:hwm});});
 });
 return{pid,child,result,peakRssBytes:()=>peak};
}
