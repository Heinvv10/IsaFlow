import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {transferControlFixture} from './bankTransferControlFixture';

/**
 * POST /api/accounting/bank-transfers served over real HTTP through withAuth, withCsrf, withWriteAccess and the
 * request transaction, over the transfer control fixture (two ZAR bank accounts in company A, an open September
 * 2026 period, and a policy that binds every transfer). Approvals go through the real request/decide path.
 */
export async function bankTransferRouteFixture(){
 const target=validateFixtureTarget(fixtureConfigFromEnv(process.env)),jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 const t=await transferControlFixture();let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){if(closed)return;closed=true;
  const results=await Promise.allSettled([t.close(),import('@/lib/auth/authPool').then(m=>m.getAuthPool().end()),import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Synthetic transfer REST cleanup failed');
 }
 try{
  const handler=(await import('../../../pages/api/accounting/bank-transfers')).default;
  server=createServer((req,res)=>{void apiResolver(req,res,{},{default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
   .catch(()=>{if(!res.headersSent)res.statusCode=500;res.end('Synthetic transfer REST failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic transfer REST listener missing');const port=address.port;
  async function request(body:Record<string,unknown>,person:'u1'|'u2'|'u3'='u1'){
   const user=t.f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/bank-transfers`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body)});
   return{status:response.status,body:await response.json() as {success?:boolean;data?:Record<string,unknown>|null;error?:{code?:string;message?:string};message?:string}};
  }
  return{...t,request,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic transfer REST setup failed');}throw error;}
}
