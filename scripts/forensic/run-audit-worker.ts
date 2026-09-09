#!/usr/bin/env bun
import {Pool} from 'pg';
import {parseArgs} from 'node:util';
import {log} from '../../src/lib/logger';
import {runAuditJobPoller} from '../../src/modules/accounting/services/controls/auditJobPoller';
/** Explicit private worker configuration only; never inherit a frontend database URL implicitly. */
async function main(){
 const {values}=parseArgs({args:process.argv.slice(2),strict:true,allowPositionals:false,options:{
  company:{type:'string',multiple:true},once:{type:'boolean',default:false},
  'interval-ms':{type:'string',default:'5000'},'batch-size':{type:'string',default:'10'},
 }});
 const connectionString=process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL;
 if(!connectionString)throw new Error('Explicit audit worker database configuration required');
 const pool=new Pool({connectionString,max:3,connectionTimeoutMillis:5000});
 const controller=new AbortController(),shutdown=()=>controller.abort(new Error('Audit worker shutdown'));
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try{
  const result=await runAuditJobPoller({companyIds:values.company??[],once:values.once,
   intervalMs:Number(values['interval-ms']),batchSize:Number(values['batch-size'])},{pool,signal:controller.signal});
  log.info('Audit queue worker stopped',result,'audit-worker');
 }finally{process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);await pool.end();}
}
if(import.meta.main)main().catch(()=>{
 // PostgreSQL/URL errors may carry credentials; never print raw worker exceptions.
 log.error('Audit queue worker failed; verify explicit worker configuration and local logs',{},'audit-worker');process.exitCode=1;
});
