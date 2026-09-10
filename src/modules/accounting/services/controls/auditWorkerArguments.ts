import {parseArgs} from 'node:util';
import {UUID_RE} from '@/lib/validation';
import {isAuditWorkerClass,type AuditWorkerClass} from './auditJobContract';
export interface AuditWorkerArguments {companyIds:string[];once:boolean;intervalMs:number;batchSize:number;workerClass:AuditWorkerClass}
/**
 * Worker CLI arguments. A unit passes its company list as one `--companies=a,b` word, so an environment file can supply
 * ids but never options; any option given twice is refused, so a later value cannot switch the class or the mode.
 */
export function parseAuditWorkerArguments(argv:string[]):AuditWorkerArguments{
 const {values,tokens}=parseArgs({args:argv,strict:true,allowPositionals:false,tokens:true,options:{
  company:{type:'string',multiple:true},companies:{type:'string'},once:{type:'boolean',default:false},
  'interval-ms':{type:'string',default:'5000'},'batch-size':{type:'string',default:'10'},class:{type:'string',default:'audit'},
 }});
 const seen=new Set<string>();
 for(const token of tokens){
  if(token.kind!=='option'||token.name==='company')continue;
  if(seen.has(token.name))throw new Error(`Audit worker option repeated: --${token.name}`);
  seen.add(token.name);
 }
 if(values.company&&values.companies!==undefined)throw new Error('Use either --company or --companies');
 const companyIds=values.companies!==undefined?values.companies.split(','):values.company??[];
 if(values.companies!==undefined&&!companyIds.every(id=>UUID_RE.test(id)))throw new Error('Invalid audit worker company list');
 if(!isAuditWorkerClass(values.class))throw new Error('Unknown audit worker class');
 return{companyIds,once:values.once,intervalMs:Number(values['interval-ms']),batchSize:Number(values['batch-size']),workerClass:values.class};
}
