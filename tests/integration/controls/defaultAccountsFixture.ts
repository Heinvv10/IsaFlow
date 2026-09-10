import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {openProtectedChange} from '@/modules/accounting/services/controls/changeProtection';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
export async function defaultAccountsFixture(){
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
  const handler=(await import('../../../pages/api/accounting/default-accounts')).default;
  server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url)
   .catch(()=>{res.statusCode=500;res.end('Synthetic default route failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic GL listener unavailable');const port=address.port;
  async function rest(method:string,body:Record<string,unknown>,validCsrf=true){
   const token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(f.f.u1.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const response=await fetch(`http://127.0.0.1:${port}/api/accounting/default-accounts`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${f.f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},body:JSON.stringify(body)});
   return{status:response.status,body:await response.json()};
  }
  async function account(company=f.f.companyA,type='asset',subtype:string|null=null,system=false){
   const id=randomUUID();await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_system_account) VALUES($1,$2,left($1::uuid::text,12),'Synthetic default account',$3,'debit',$4,$5)",[id,company,type,subtype,system]);return id;
  }
  async function state(){
   return {accounts:(await f.pool.query("SELECT (to_jsonb(a)-'bank_opening_balance')||jsonb_build_object('bank_opening_balance',a.bank_opening_balance::text) AS row FROM gl_accounts a WHERE company_id=$1 ORDER BY id",[f.f.companyA])).rows.map(r=>r.row),
    settings:(await f.pool.query("SELECT to_jsonb(s) AS row FROM app_settings s WHERE company_id=$1 AND key='accounting_default_accounts'",[f.f.companyA])).rows[0]?.row??null};
  }
  async function changes(type:string,id:string){
   const rows=(await f.pool.query("SELECT e.*,p.key_id,p.envelope_version,p.ciphertext FROM control_change_events e JOIN control_protected_evidence p ON p.company_id=e.company_id AND p.id=e.protected_evidence_id AND p.entity_type=e.entity_type AND p.entity_id=e.entity_id WHERE e.company_id=$1 AND e.entity_type=$2 AND e.entity_id=$3 ORDER BY e.new_version",[f.f.companyA,type,id])).rows;
   return rows.map(row=>({...row,values:openProtectedChange({version:row.envelope_version,keyId:row.key_id,ciphertext:row.ciphertext})}));
  }
  return{...f,rest,account,state,changes,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Synthetic GL HTTP setup failed');}throw error;}
}
