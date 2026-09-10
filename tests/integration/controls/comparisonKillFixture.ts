import {readdir,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {auditUnitProperties} from '@/modules/accounting/services/controls/auditJobSystemd';
/** Discover only a systemd-run child of THIS test process, and verify the exact artifact before signaling. */
export async function killOwnedComparisonWorker(entryPath:string){
 const matches:{unit:string;pid:number}[]=[];
 for(const pid of await readdir('/proc')){
  if(!/^\d+$/.test(pid))continue;
  let status:string,raw:Buffer;
  try{[status,raw]=await Promise.all([readFile(`/proc/${pid}/status`,'utf8'),readFile(`/proc/${pid}/cmdline`)]);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as NodeJS.ErrnoException).code==='EACCES')continue;throw error;}
  if(Number(status.match(/^PPid:\s+(\d+)$/m)?.[1])!==process.pid)continue;
  const args=raw.toString().split('\0');
  if(args[0]!=='/usr/bin/systemd-run'||!args.includes(entryPath))continue;
  const unit=args.find(arg=>/^--unit=isaflow-audit-[a-f0-9-]{36}\.service$/.test(arg))?.slice(7);
  if(unit)matches.push({unit,pid:Number(pid)});
 }
 if(matches.length!==1)throw new Error('Exactly one owned comparison subprocess required');
 const owned=matches[0]!;
 const properties=await auditUnitProperties(owned.unit).catch(error=>{throw new Error('Owned worker property lookup failed',{cause:error});}),pid=Number(properties.MainPID);
 if(properties.LoadState!=='loaded'||!Number.isSafeInteger(pid)||pid<1)throw new Error('Owned comparison unit not running');
 const args=(await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
 if(!args.includes(entryPath)||!args.includes('--max-old-space-size=4096'))throw new Error('Owned comparison executable identity changed');
 await promisify(execFile)('/usr/bin/systemctl',['--user','--no-pager','kill','--kill-whom=main','--signal=SIGKILL',owned.unit],{timeout:2000,maxBuffer:8192}).catch(error=>{throw new Error('Owned worker SIGKILL command failed: '+String(error.stderr),{cause:error});});
 return owned.unit;
}
