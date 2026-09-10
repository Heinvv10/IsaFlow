import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
/** The year-end route behind real cookie auth, CSRF and the flow meter, over HTTP. */
export async function yearEndRestFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([pool.end(),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic year-end REST cleanup failed');
 }
 try{
  const f=await provisionForensicFixture(config);
  const handler=(await import('../../../pages/api/accounting/year-end')).default;
  server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1');
   void apiResolver(req,res,{},{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
    .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic year-end REST failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic year-end REST listener missing');const port=address.port;
  async function post(body:Record<string,unknown>){
   const user=f.u1,token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/year-end`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body)});
   return{status:response.status,body:await response.json() as {success:boolean;data?:Record<string,unknown>;error?:{message?:string}}};
  }
  return{f,pool,post,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic year-end REST setup failed');}throw error;}
}
