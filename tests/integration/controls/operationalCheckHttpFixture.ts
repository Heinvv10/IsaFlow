import {createServer} from 'node:http';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {transferControlFixture} from './bankTransferControlFixture';
import {mcpHttpClient} from '../mcp-http/client';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
export async function operationalCheckHttpFixture(){
 process.env.DATABASE_URL=validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString;process.env.DATABASE_SSL='disable';
 const f=await transferControlFixture();let server:ReturnType<typeof createServer>|undefined,closed=false;
 async function close(){
  if(closed)return;closed=true;
  const results=await Promise.allSettled([
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(error=>error?reject(error):resolve());server!.closeAllConnections();});}),
   Promise.resolve().then(()=>f.close()),
   import('@/lib/mcp/invocationStore').then(module=>module.closeInvocationPool()),
   import('@/lib/auth/authPool').then(module=>module.getAuthPool().end()),
   import('@/lib/neon').then(module=>module.getPoolForTests().end()),
  ]);
  const failures=results.filter((row):row is PromiseRejectedResult=>row.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(row=>row.reason),'Synthetic detective cleanup failed');
 }
 try{
 await f.pool.query("INSERT INTO feature_flags(code,name,is_global) VALUES('mcp_connector','Synthetic MCP',false) ON CONFLICT(code) DO NOTHING");
 for(const [company,person] of [[f.f.companyA,f.f.u1.id],[f.f.companyB,f.f.u3.id]])await f.pool.query("INSERT INTO company_feature_overrides(company_id,feature_id,enabled,set_by) SELECT $1,id,true,$2 FROM feature_flags WHERE code='mcp_connector' ON CONFLICT(company_id,feature_id) DO UPDATE SET enabled=true",[company,person]);
 const handler=(await import('../../../pages/api/mcp/index')).default;
 server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
  .catch(()=>{res.statusCode=500;res.end('Synthetic detective HTTP failure');});});
 await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic server unavailable');
 const client=mcpHttpClient(`http://127.0.0.1:${address.port}`);
 const call=(name:string,args:Record<string,unknown>={},person:'u1'|'u3'='u1')=>client.rpc(f.f[person].tokens[0]!.raw,'tools/call',{name,arguments:args});
 return{...f,client,call,close};
 }catch(error){
  try{await close();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Synthetic detective setup and cleanup failed');}
  throw error;
 }
}
