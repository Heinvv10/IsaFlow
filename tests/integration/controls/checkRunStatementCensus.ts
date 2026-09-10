import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
/**
 * Plan v6 A17, counted rather than reasoned: every statement PostgreSQL executed for one worker backend, read from the
 * disposable container's own statement log (log_statement=all, log_line_prefix '%m|%a|%p|', bind parameters not
 * logged). The worker's pool sets application_name `isaflow-audit:<jobId>`, so the census is exactly its statements —
 * nothing inferred from code. Only counts and statement verbs leave this function; no statement text is kept.
 */
export interface StatementCensus {total:number;byVerb:Record<string,number>;mentioning:Record<string,number>}
const START=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \w+\|([^|]*)\|\d+\|(\w+):\s+(?:statement|execute [^:]*): (.*)$/;
const ANY_START=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \w+\|/;
export async function statementCensus(container:string,sinceIso:string,applicationName:string,tables:readonly string[]):Promise<StatementCensus>{
 if(!/^isaflow-t2e-[a-z0-9-]+$/.test(container))throw new Error('Only the owned disposable T2e container may be read');
 if(!/^isaflow-audit:[0-9a-f-]{36}$/.test(applicationName))throw new Error('Worker application name required');
 const {stdout,stderr}=await promisify(execFile)('docker',['logs','--since',sinceIso,container],{maxBuffer:512*1024*1024});
 // A statement is one prefixed line plus the unprefixed lines that continue it (multi-line SQL).
 const messages:string[]=[];let ours=false;
 for(const line of `${stdout}\n${stderr}`.split('\n')){
  const start=START.exec(line);
  if(start){ours=start[1]===applicationName;if(ours)messages.push(start[3]!);continue;}
  if(ANY_START.test(line)){ours=false;continue;}
  if(ours)messages[messages.length-1]+=`\n${line}`;
 }
 const byVerb:Record<string,number>={},mentioning:Record<string,number>=Object.fromEntries(tables.map(table=>[table,0]));
 for(const message of messages){
  const verb=(message.trim().split(/\s+/)[0]??'').toUpperCase();byVerb[verb]=(byVerb[verb]??0)+1;
  for(const table of tables)if(new RegExp(`\\b${table}\\b`).test(message))mentioning[table]!++;
 }
 return{total:messages.length,byVerb,mentioning};
}
