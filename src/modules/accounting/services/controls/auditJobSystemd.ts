import {execFile} from 'node:child_process';
import {access,stat,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import type {AuditClassLimits,AuditProcessConfig} from './auditJobProcessContract';
const UNIT=/^isaflow-audit-[a-f0-9-]{36}\.service$/;
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
  '--property=MainPID','--property=Result','--property=ExecMainCode','--property=ExecMainStatus','--property=ControlGroup','--property=RuntimeMaxUSec']);
 return Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
}

/** Sample RSS only while this PID still belongs to the exact fresh service. */
export async function sampleAuditUnitRss(unit:string,pid:number):Promise<number|null>{
 if(!UNIT.test(unit)||!Number.isSafeInteger(pid)||pid<1)return null;
 try{
  const group=await readFile(`/proc/${pid}/cgroup`,'utf8');
  if(!group.trim().endsWith('/'+unit))return null;
  const status=await readFile(`/proc/${pid}/status`,'utf8');
  if(await readFile(`/proc/${pid}/cgroup`,'utf8')!==group)return null;
  const match=/^VmRSS:\s+(\d+) kB$/m.exec(status);return match?Number(match[1])*1024:null;
 }catch{return null;}
}

const SPAN_UNITS:Readonly<Record<string,bigint>>={us:1n,usec:1n,ms:1000n,msec:1000n,s:1000000n,sec:1000000n,min:60000000n,h:3600000000n,hr:3600000000n,
 d:86400000000n,w:604800000000n,M:2629800000000n,y:31557600000000n};
/** Fallback for `systemctl show` human spans ("5min 40s", "2h 3min 4.500000s"); null for infinity or anything unparsed. */
export function parseSystemdTimeSpan(text:string):number|null{
 const parts=text.trim().split(' ');let total=0n;
 for(const part of parts){
  const match=/^(\d+)(?:\.(\d{1,6}))?(us|usec|ms|msec|s|sec|min|h|hr|d|w|M|y)$/.exec(part);
  if(!match)return null;
  const scale=SPAN_UNITS[match[3]!]!,fraction=(match[2]??'').padEnd(6,'0');
  total+=BigInt(match[1]!)*scale+BigInt(fraction)*scale/1000000n;
 }
 return total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):null;
}
/** Raw `busctl get-property` reply for a uint64 property: `t <integer>`; UINT64_MAX (infinity) is not a cap. */
export function parseBusctlUint64(text:string):number|null{
 const match=/^t (\d{1,20})\n?$/.exec(text);if(!match)return null;
 const value=BigInt(match[1]!);return value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):null;
}
export function auditUnitObjectPath(unit:string):string{
 if(!UNIT.test(unit))throw new Error('Invalid dedicated audit unit');
 return '/org/freedesktop/systemd1/unit/'+[...unit].map(char=>/[A-Za-z0-9]/.test(char)?char:'_'+char.charCodeAt(0).toString(16).padStart(2,'0')).join('');
}
async function busctlRuntimeMaxUSec(unit:string):Promise<number|null>{
 const output=await new Promise<string>((resolve,reject)=>execFile('/usr/bin/busctl',['--user','get-property','org.freedesktop.systemd1',auditUnitObjectPath(unit),
  'org.freedesktop.systemd1.Service','RuntimeMaxUSec'],{timeout:2000,maxBuffer:1024},(error,stdout)=>{if(error)reject(new Error('Audit unit runtime read failed'));else resolve(stdout);}));
 return parseBusctlUint64(output);
}
export interface AuditUnitCaps {runtimeMaxUSec:number|null;memoryMax:string;memorySwapMax:string}
/** The unit's real caps: runtime over D-Bus (falling back to the parsed span), memory as systemctl's byte integers. */
export async function readAuditUnitCaps(unit:string,known?:Record<string,string>):Promise<AuditUnitCaps&{properties:Record<string,string>}>{
 const properties=known??await auditUnitProperties(unit);let runtimeMaxUSec:number|null;
 try{runtimeMaxUSec=await busctlRuntimeMaxUSec(unit);}
 catch{runtimeMaxUSec=parseSystemdTimeSpan(properties.RuntimeMaxUSec??'');}
 return{runtimeMaxUSec,memoryMax:properties.MemoryMax??'',memorySwapMax:properties.MemorySwapMax??'',properties};
}
export function auditUnitCapsMatch(caps:AuditUnitCaps,limits:AuditClassLimits):boolean{
 return caps.runtimeMaxUSec===limits.runtimeMaxSec*1000000&&caps.memoryMax===String(limits.memoryMaxBytes)&&caps.memorySwapMax==='0';
}
