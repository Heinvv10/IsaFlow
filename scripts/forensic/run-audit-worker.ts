#!/usr/bin/env bun
import {Pool} from 'pg';
import {log} from '../../src/lib/logger';
import {runAuditJobPoller} from '../../src/modules/accounting/services/controls/auditJobPoller';
import {createIsolatedAuditJobRunner} from '../../src/modules/accounting/services/controls/auditJobProcess';
import {AUDIT_WORKER_CLASS_KINDS} from '../../src/modules/accounting/services/controls/auditJobContract';
import {parseAuditWorkerArguments} from '../../src/modules/accounting/services/controls/auditWorkerArguments';
import {sanitizeAuditWorkerFailure} from './auditWorkerFailureLog';
/** Explicit private worker configuration only; never inherit a frontend database URL implicitly. */
async function main(){
 // One instance serves one class: its unit caps, its claimable kinds and the kinds its poller discovers.
 const {companyIds,once,intervalMs,batchSize,workerClass}=parseAuditWorkerArguments(process.argv.slice(2));
 const connectionString=process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL;
 if(!connectionString)throw new Error('Explicit audit worker database configuration required');
 const nodePath=process.env.ISAFLOW_AUDIT_WORKER_NODE_PATH,entryPath=process.env.ISAFLOW_AUDIT_WORKER_ENTRY_PATH;
 if(!nodePath||!entryPath)throw new Error('Explicit audit worker Node and built entry paths required');
 const runner=createIsolatedAuditJobRunner({nodePath,entryPath,workerClass});
 await runner.validateReadiness();
 const pool=new Pool({connectionString,max:3,connectionTimeoutMillis:5000});
 const controller=new AbortController(),shutdown=()=>controller.abort(new Error('Audit worker shutdown'));
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try{
  const result=await runAuditJobPoller({companyIds,once,kinds:[...AUDIT_WORKER_CLASS_KINDS[workerClass]],intervalMs,batchSize},{pool,signal:controller.signal,executeJob:async(identity,options)=>{
    const {result,observation}=await runner.runIsolatedAuditJob(identity,options);
    log.info('Audit isolated worker observed',observation,'audit-worker');
    return result;
   }});
  log.info('Audit queue worker stopped',result,'audit-worker');
 }finally{process.removeListener('SIGTERM',shutdown);process.removeListener('SIGINT',shutdown);await pool.end();}
}
if(import.meta.main)main().catch(error=>{
 // PostgreSQL/URL errors may carry credentials; log a sanitised cause, never the raw exception.
 log.error('Audit queue worker failed; verify explicit worker configuration and local logs',sanitizeAuditWorkerFailure(error),'audit-worker');process.exitCode=1;
});
