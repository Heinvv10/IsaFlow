import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
export async function glAccountHistoryHttpFixture(){
 const jwtKey=randomBytes(32).toString('hex');process.env.JWT_SECRET=jwtKey;
 const f=await operationalCheckHttpFixture(),csrf=randomBytes(32).toString('hex');
 let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){
  if(closed)return;closed=true;
  const results=await Promise.allSettled([Promise.resolve().then(()=>f.close()),Promise.resolve().then(()=>{
   if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(error=>error?reject(error):resolve());server!.closeAllConnections();});
  })]);
  const errors=results.filter((row):row is PromiseRejectedResult=>row.status==='rejected');if(errors.length)throw new AggregateError(errors.map(row=>row.reason),'Synthetic GL HTTP cleanup failed');
 }
 try{
  const chart=(await import('../../../pages/api/accounting/chart-of-accounts')).default;
  const detail=(await import('../../../pages/api/accounting/chart-of-accounts-detail')).default;
  server=createServer((req,res)=>{const url=new URL(req.url!,'http://127.0.0.1');
   void apiResolver(req,res,Object.fromEntries(url.searchParams),{default:url.pathname.endsWith('-detail')?detail:chart},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,url.pathname)
    .catch(()=>{res.statusCode=500;res.end('Synthetic GL route failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic GL listener unavailable');const port=address.port;
  async function rest(method:string,body:Record<string,unknown>,detail=false,validCsrf=true){
   const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(f.f.u1.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/chart-of-accounts${detail?'-detail':''}`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${f.f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},body:JSON.stringify(body)});
   return{status:response.status,body:await response.json()};
  }
  return{...f,rest,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic GL HTTP setup failed');}throw error;}
}
