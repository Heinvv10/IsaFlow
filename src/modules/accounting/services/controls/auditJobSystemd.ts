import {execFile} from 'node:child_process';
import {access,stat,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {AuditProcessConfig} from './auditJobProcessContract';
export async function auditSystemctl(args:string[]):Promise<string>{
 return new Promise((resolve,reject)=>execFile('/usr/bin/systemctl',['--user','--no-pager',...args],{timeout:2000,maxBuffer:8192},(error,stdout)=>{
  if(error)reject(new Error('Audit process containment command failed'));else resolve(stdout);
 }));
}
export async function validateAuditProcessReadiness(config:AuditProcessConfig){
 for(const [path,mode] of [[config.nodePath,constants.X_OK],[config.entryPath,constants.R_OK]] as const){
  if(!isAbsolute(path)||(await stat(path)).isFile()!==true)throw new Error('Absolute audit process executable and artifact required');
  await access(path,mode);
 }
 if(process.platform!=='linux')throw new Error('Audit process requires Linux cgroup containment');
 const manager=await auditSystemctl(['show','--property=ControlGroup']);
 const group=manager.trim().split('=')[1];
 if(!group||!group.startsWith('/user.slice/')||group.includes('..'))throw new Error('Audit user cgroup manager unavailable');
 const controllers=await readFile(`/sys/fs/cgroup${group}/cgroup.controllers`,'utf8');
 if(!controllers.split(/\s+/).includes('memory'))throw new Error('Audit memory controller unavailable');
 return{ready:true as const};
}
export async function auditUnitProperties(unit:string){
 const output=await auditSystemctl(['show',unit,'--property=LoadState','--property=MemoryMax','--property=MemorySwapMax','--property=MemoryPeak',
  '--property=MainPID','--property=Result','--property=ExecMainCode','--property=ExecMainStatus','--property=ControlGroup']);
 return Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
}

/** Sample RSS only while this PID still belongs to the exact fresh service. */
export async function sampleAuditUnitRss(unit:string,pid:number):Promise<number|null>{
 if(!/^isaflow-audit-[a-f0-9-]{36}\.service$/.test(unit)||!Number.isSafeInteger(pid)||pid<1)return null;
 try{
  const group=await readFile(`/proc/${pid}/cgroup`,'utf8');
  if(!group.trim().endsWith('/'+unit))return null;
  const status=await readFile(`/proc/${pid}/status`,'utf8');
  if(await readFile(`/proc/${pid}/cgroup`,'utf8')!==group)return null;
  const match=/^VmRSS:\s+(\d+) kB$/m.exec(status);return match?Number(match[1])*1024:null;
 }catch{return null;}
}
