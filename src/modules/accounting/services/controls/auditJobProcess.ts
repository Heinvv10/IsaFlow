import {spawn} from 'node:child_process';
import {constants as osConstants} from 'node:os';
import {randomUUID} from 'node:crypto';
import {als} from '@/lib/als';
import type {AuditWorkerIdentity} from './auditWorkerTransaction';
import type {AuditWorkerResult} from './auditJobRunner';
import {AUDIT_PROCESS_LIMITS as limits,type AuditProcessConfig,type AuditProcessObservation} from './auditJobProcessContract';
import {AUDIT_PROCESS_ENV,auditProcessArguments,encodeAuditProcessRequest,decodeAuditProcessReply} from './auditJobProcessProtocol';
import {auditSystemctl,auditUnitProperties,sampleAuditUnitRss,validateAuditProcessReadiness} from './auditJobSystemd';
export {validateAuditProcessReadiness} from './auditJobSystemd';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Server factory only: caller identities cannot choose programs, resource limits or environment. */
export function createIsolatedAuditJobRunner(input:AuditProcessConfig){
 const config=Object.freeze({...input});
 return{validateReadiness:()=>validateAuditProcessReadiness(config),async runIsolatedAuditJob(identity:AuditWorkerIdentity,options:{signal?:AbortSignal}={}){
  if(als.getStore())throw new Error('Audit subprocess requires a cold server boundary');
  const request=encodeAuditProcessRequest({version:1,...identity});options.signal?.throwIfAborted();
  await validateAuditProcessReadiness(config);options.signal?.throwIfAborted();
  if(!process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL)throw new Error('Explicit private audit worker database required');
  const unitName=`isaflow-audit-${randomUUID()}.service`,started=Date.now();
  const env:NodeJS.ProcessEnv={NODE_ENV:'production'};
  for(const name of [...AUDIT_PROCESS_ENV,'XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','HOME','USER','LANG'])if(process.env[name]!==undefined)env[name]=process.env[name];
  const child=spawn('/usr/bin/systemd-run',auditProcessArguments(config,unitName),{env,stdio:['pipe','pipe','pipe']});
  let output=Buffer.alloc(0),diagnosticBytes=0,invalid=false,timedOut=false,finished=false,memoryPeakBytes:number|null=null,peakRssBytes:number|null=null,oomKilled=false;
  let reply:AuditWorkerResult|undefined,properties:Record<string,string>={};
  const observe=async()=>{try{
   properties=await auditUnitProperties(unitName);const peak=Number(properties.MemoryPeak);
   if(Number.isSafeInteger(peak)&&peak>=0)memoryPeakBytes=Math.max(memoryPeakBytes??0,peak);
   oomKilled ||= properties.Result==='oom-kill';
  }catch{return;/* A successful transient unit can disappear after exit; the live reply handshake records its peak first. */}};
  let sampling=false;
  const sample=async()=>{if(sampling)return;sampling=true;try{
   const rss=await sampleAuditUnitRss(unitName,Number(properties.MainPID));if(rss!==null)peakRssBytes=Math.max(peakRssBytes??0,rss);
  }finally{sampling=false;}};
  const sampler=setInterval(()=>{void sample();},100);
  const terminate=()=>{void auditSystemctl(['kill','--kill-whom=all','--signal=SIGTERM',unitName]).catch(()=>{child.kill('SIGTERM');});};
  const abort=()=>terminate();options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;terminate();},limits.maxRuntimeMs);
  const hard=setTimeout(()=>{timedOut=true;void auditSystemctl(['kill','--kill-whom=all','--signal=SIGKILL',unitName]).catch(()=>undefined);child.kill('SIGKILL');},limits.maxRuntimeMs+limits.killGraceMs);
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
   child.once('error',()=>{invalid=true;resolve({code:null,signal:null});});
   child.once('close',(code,signal)=>{finished=true;resolve({code,signal});});
  });
  child.stdin.on('error',()=>{if(!finished)invalid=true;});
  child.stderr.on('data',(chunk:Buffer)=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>limits.maxDiagnosticBytes){invalid=true;terminate();}});
  child.stdout.on('data',(chunk:Buffer)=>{
   if(output.length+chunk.length>limits.maxReplyBytes){invalid=true;terminate();return;}
   output=Buffer.concat([output,chunk]);
   if(output.includes(10)){
    try{reply=decodeAuditProcessReply(output).result;}catch{invalid=true;terminate();return;}
    void observe().finally(()=>child.stdin.end());
   }
  });
  try{
   // Verify the new unit's actual cgroup caps before releasing an identity to the worker.
   for(let tries=0;tries<25&&!finished;tries++){
    await observe();if(properties.LoadState==='loaded'&&Number(properties.MemoryMax)===limits.memoryMaxBytes&&properties.MemorySwapMax==='0'&&Number(properties.MainPID)>0)break;
    await pause(100);
   }
   if(finished||Number(properties.MemoryMax)!==limits.memoryMaxBytes||properties.MemorySwapMax!=='0'){
    invalid=true;terminate();
   }else if(options.signal?.aborted){terminate();}else child.stdin.write(request);
   const exit=await exited;await observe();await sample();
   if(!invalid&&reply){try{decodeAuditProcessReply(output);}catch{invalid=true;}}
   const result:AuditWorkerResult=options.signal?.aborted?{state:'failed',code:'CANCELLED',failureRecorded:reply?.state==='failed'&&reply.failureRecorded}
    :timedOut||oomKilled||properties.Result==='timeout'?{state:'failed',code:'RESOURCE_LIMIT',failureRecorded:false}
    :invalid||exit.code!==0||!reply?{state:'failed',code:'WORKER_ERROR',failureRecorded:false}:reply;
   const mainCode=Number(properties.ExecMainCode),mainStatus=Number(properties.ExecMainStatus);
   const signal=[2,3].includes(mainCode)?Object.entries(osConstants.signals).find(([,value])=>value===mainStatus)?.[0]??exit.signal:exit.signal;
   const observation:AuditProcessObservation={unitName,exitCode:mainCode===1?mainStatus:exit.code,signal,elapsedMs:Date.now()-started,memoryPeakBytes,peakRssBytes,oomKilled};
   return{result,observation};
  }finally{
   clearTimeout(timer);clearTimeout(hard);clearInterval(sampler);options.signal?.removeEventListener('abort',abort);child.stdin.destroy();
   // Only the exact freshly allocated unit is stopped/reset; never touch a shared service or cgroup.
   await auditSystemctl(['stop',unitName]).catch(()=>undefined);await auditSystemctl(['reset-failed',unitName]).catch(()=>undefined);
  }
 }};
}
