import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';

/**
 * POST /api/accounting/journal-entries-action served over real HTTP through withAuth, withCsrf and withWriteAccess,
 * so a lockdown or closed-period refusal is answered the way the wrapper actually answers it (a request whose
 * controlWriteFailed flag was set inside the controlled write is overridden to 500 CONTROL_INTEGRITY_FAILED by
 * withAuth regardless of what the route itself tries to send), not the way the service function throws in isolation.
 */
export async function journalEntryActionRouteFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env)),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY??=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY??=randomBytes(32).toString('hex');
 const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:target.connectionString,ssl:false,max:3,statement_timeout:7000});
 let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([pool.end(),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic journal-action REST cleanup failed');
 }
 try{
  const f=await provisionForensicFixture(config),periodId=randomUUID(),accounts=[randomUUID(),randomUUID()];
  await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false,lockdown_date=null WHERE id=$1",[f.companyA]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic journal-action September',9,2026,'2026-09-01','2026-09-30','open')",[periodId,f.companyA]);
  for(const [i,account] of accounts.entries())await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$2,$3,$4,$5,$6,3,true)",[account,f.companyA,account.slice(0,12),`Synthetic journal-action account ${i}`,i?'liability':'asset',i?'credit':'debit']);
  async function journal(date='2026-09-09',source='manual'){
   const id=randomUUID();
   await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,source,status,created_by) VALUES($1,$2,$3::date,$4,$5,'draft',$6)",[id,f.companyA,date,periodId,source,f.u1.id]);
   await pool.query('INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit) VALUES($1,$2,$3,100.00,0),($1,$2,$4,0,100.00)',[id,f.companyA,...accounts]);
   return id;
  }
  const state=async(id:string)=>(await pool.query('SELECT status,reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[f.companyA,id])).rows[0] as {status:string;reversed_at:Date|null}|undefined;
  const status=async(id:string)=>(await state(id))?.status;
  const lockdown=(enabled:boolean,date:string|null=null)=>pool.query('UPDATE companies SET lockdown_enabled=$1,lockdown_date=$2 WHERE id=$3',[enabled,date,f.companyA]);
  const period=(statusValue:string)=>pool.query('UPDATE fiscal_periods SET status=$1 WHERE company_id=$2 AND id=$3',[statusValue,f.companyA,periodId]);
  const handler=(await import('../../../pages/api/accounting/journal-entries-action')).default;
  server=createServer((req,res)=>{void apiResolver(req,res,{},{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
   .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic journal-action REST failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic journal-action REST listener missing');const port=address.port;
  async function request(body:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1'){
   const user=f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/journal-entries-action`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body)});
   return{status:response.status,body:await response.json() as {success?:boolean;data?:Record<string,unknown>|null;error?:{code?:string;message?:string};message?:string;code?:string}};
  }
  return{f,pool,periodId,accounts,journal,status,state,lockdown,period,request,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic journal-action REST setup failed');}throw error;}
}
