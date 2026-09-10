import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget} from '../forensic-fixture';
import type {PlatformImportRequestCapability} from '@/lib/auth/platformImportAuthority';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
export type AuthorityProbe='escaped'|'identity'|'restore'|'revoke_after_gate'|'controlWriteFailed'|'criticalAuditFailed'|'txUnusable';
interface ProbeBody {companyId:string;probe:AuthorityProbe}
export async function platformImportAuthorityFixture(){
 const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
 const adminUrl=new URL(target.connectionString);adminUrl.searchParams.set('options','-c role=platform_admin');
 const jwtKey=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
 process.env.DATABASE_URL=target.connectionString;process.env.PLATFORM_ADMIN_DATABASE_URL=adminUrl.toString();
 process.env.DATABASE_SSL='disable';process.env.JWT_SECRET=jwtKey;
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
 const roleProbe=new Pool({connectionString:adminUrl.toString(),ssl:false,max:1,statement_timeout:5000});
 let server:ReturnType<typeof createServer>|undefined,closed=false;
 const finished=new Map<string,()=>void>();
 let retainedCapability:PlatformImportRequestCapability|undefined,retainedContext:ControlTx|undefined;
 let escaped:Promise<unknown>|undefined,releaseEscaped:(()=>void)|undefined,escapedQueryRefused=false;
 async function finishEscaped(){releaseEscaped?.();await escaped;return escapedQueryRefused;}
 async function close(){
  if(closed)return;closed=true;await finishEscaped();
  const results=await Promise.allSettled([pool.end(),roleProbe.end(),
   import('@/lib/auth/withPlatformAdmin.pools').then(async m=>{await Promise.all([m.getAppPool().end(),m.getPlatformAdminPool().end()]);}),
   import('@/lib/neon').then(m=>m.getPoolForTests().end()),
   Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(e=>e?reject(e):resolve());server!.closeAllConnections();});})]);
  const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'Platform authority fixture cleanup failed');
 }
 try{
  const role=(await roleProbe.query('SELECT current_user AS name,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(role?.name!=='platform_admin'||role.rolbypassrls!==true)throw new Error('Synthetic fixture requires existing platform_admin BYPASSRLS role');
  const f=await provisionForensicFixture(config),admin=randomUUID(),customer=randomUUID();
  await pool.query("INSERT INTO users(id,email,role,is_active,status) VALUES($1,$2,'super_admin',true,'active')",[admin,`${admin}@forensic.invalid`]);
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Authority witness')",[customer,f.companyA]);
  const {withAdmin}=await import('@/modules/admin/middleware/withAdmin');
  const {withCsrf}=await import('@/lib/auth/withCsrf');
  const {withPlatformImportTarget,readPlatformImportTarget}=await import('@/lib/auth/platformImportAuthority');
  const {assertControlTx}=await import('@/modules/accounting/services/controls/context');
  const {als}=await import('@/lib/als');
  const {sql}=await import('@/lib/neon');
  const handler=withAdmin(withCsrf(async(req,res)=>{
   const body=req.body as ProbeBody,parent=als.getStore()!;
   const [before]=await sql`SELECT pg_backend_pid() AS pid,current_user AS role,COALESCE(current_setting('app.current_company_id',true),'') AS company`;
   retainedCapability=req.platformImportCapability;
   if(body.probe==='escaped'){
    let written!:()=>void;const ready=new Promise<void>(resolve=>{written=resolve;});
    const resume=new Promise<void>(resolve=>{releaseEscaped=resolve;});
    escaped=withPlatformImportTarget(req.platformImportCapability,{action:'retain',companyId:body.companyId,sourceHash:'a'.repeat(64)},async ctx=>{
     await ctx.sql`UPDATE customers SET name='Escaped authority witness' WHERE company_id=${body.companyId}::uuid AND id=${customer}::uuid`;
     written();await resume;
     try{await ctx.sql`UPDATE customers SET name='Forbidden late witness' WHERE company_id=${body.companyId}::uuid AND id=${customer}::uuid`;}
     catch{escapedQueryRefused=true;}
    }).catch(error=>{written();if(!(error instanceof Error))throw error;});
    await ready;res.status(200).json({escaped:true});return;
   }
   if(body.probe==='revoke_after_gate'){
    // Separate committed transaction after the real cookie/role middleware gate, before target issuance.
    await pool.query("UPDATE users SET role='viewer' WHERE id=$1",[admin]);
   }
   let caught=false,result:unknown;
   try{
    result=await withPlatformImportTarget(req.platformImportCapability,{action:'retain',companyId:body.companyId,sourceHash:'a'.repeat(64)},async ctx=>{
     assertControlTx(ctx);retainedContext=ctx;
     const [active]=await ctx.sql`SELECT pg_backend_pid() AS pid,current_user AS role,app.current_company_id()::text AS company,auth.uid()::text AS person`;
     if(body.probe==='restore')throw new Error('Synthetic ordinary target error');
     if(['controlWriteFailed','criticalAuditFailed','txUnusable'].includes(body.probe)){
      await ctx.sql`UPDATE customers SET name='Uncommitted authority witness' WHERE company_id=${body.companyId}::uuid AND id=${customer}::uuid`;
      const child=als.getStore()!;
      if(body.probe==='txUnusable')child.txUnusable='Synthetic failed savepoint rollback';
      else if(body.probe==='criticalAuditFailed')child.criticalAuditFailed=true;
      else child.controlWriteFailed=true;
      throw new Error('Synthetic caught child failure');
     }
     return{active,before,sameClient:als.getStore()?.client===parent.client,principal:ctx.principal,target:readPlatformImportTarget(ctx)};
    });
   }catch(error){caught=true;result={message:error instanceof Error?error.message:String(error)};}
   // Poisoned connections are deliberately not queried again; the outer middleware must roll back.
   const poisoned=Boolean(parent.controlWriteFailed||parent.criticalAuditFailed||parent.txUnusable);
   const after=poisoned?null:(await sql`SELECT pg_backend_pid() AS pid,COALESCE(current_setting('app.current_company_id',true),'') AS company`)[0];
   res.status(200).json({caught,result,after,parentRestored:als.getStore()===parent&&!parent.companyId&&!parent.controlPrincipal,
    flags:{controlWriteFailed:parent.controlWriteFailed===true,criticalAuditFailed:parent.criticalAuditFailed===true,txUnusable:Boolean(parent.txUnusable)}});
  }));
  const defaultCommit=(await import('../../../pages/api/admin/migration/sage-commit')).default;
  server=createServer((req,res)=>{
   const id=String(req.headers['x-fixture-request']??'');
   const selected=req.url==='/api/admin/migration/sage-commit'?defaultCommit:handler;
   void apiResolver(req,res,{}, {default:selected},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
    .catch(()=>{if(!res.headersSent){res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'Synthetic authority request failed'}));}else if(!res.writableEnded)res.end();})
    .finally(()=>{finished.get(id)?.();finished.delete(id);});
  });
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Authority fixture listener unavailable');
  async function request(probe:AuthorityProbe='identity',options:{person?:string;companyId?:string;csrf?:boolean;adminHeader?:boolean;defaultRoute?:boolean;anonymous?:boolean}={}){
   const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(options.person??admin).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const id=randomUUID();let done!:()=>void;const completed=new Promise<void>(resolve=>{done=resolve;});finished.set(id,done);
   try{
    const companyId=options.companyId??f.companyA,path=options.defaultRoute?'/api/admin/migration/sage-commit':'/api/admin/forensic-authority-fixture';
    const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-fixture-request':id,
     cookie:`${options.anonymous?'':`sb-access-token=${token}; `}isaflow_csrf=${csrf}`,'x-csrf-token':options.csrf===false?'invalid':csrf,...(options.adminHeader===false?{}:{'x-admin-request':'true'})},
     body:JSON.stringify(options.defaultRoute?{companyId,pulled:{}}:{companyId,probe})});
    const body=await response.json();await completed;return{status:response.status,body};
   }finally{finished.delete(id);}
  }
  async function witness(){return(await pool.query('SELECT name FROM customers WHERE company_id=$1 AND id=$2',[f.companyA,customer])).rows[0]?.name;}
  return{f,pool,admin,customer,request,witness,close,finishEscaped,retained:()=>({capability:retainedCapability,context:retainedContext})};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Authority fixture setup failed');}throw error;}
}
