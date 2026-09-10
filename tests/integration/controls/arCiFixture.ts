import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import {operationalCheckHttpFixture} from './operationalCheckHttpFixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {PAT_SCOPES} from '@/lib/auth/patScopes';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
export async function arCiFixture(){
 const jwtKey=randomBytes(32).toString('hex');process.env.JWT_SECRET=jwtKey;
 const base=await operationalCheckHttpFixture(),{f,pool}=base,customer=randomUUID(),oauthApp=randomUUID(),oauthGrant=randomUUID(),csrf=randomBytes(32).toString('hex');
 let server:ReturnType<typeof createServer>|undefined;
 async function close(){const results=await Promise.allSettled([base.close(),Promise.resolve().then(()=>{if(!server?.listening)return;return new Promise<void>((resolve,reject)=>{server!.close(error=>error?reject(error):resolve());server!.closeAllConnections();});})]);const errors=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');if(errors.length)throw new AggregateError(errors.map(r=>r.reason),'AR fixture cleanup failed');}
 try{
  await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic AR CI customer')",[customer,f.companyA]);
  await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'AR July',7,2026,'2026-07-01','2026-07-31','open')",[f.companyA]);
  await pool.query("INSERT INTO oauth_apps(id,name,redirect_uris,client_id,client_secret_hash,client_secret_prefix,owner_user_id) VALUES($1,'Synthetic AR OAuth',$2,$1::uuid::text,$1::uuid::text,'synthetic',$3)",[oauthApp,['https://forensic.invalid/callback'],f.u1.id]);
  await pool.query("INSERT INTO oauth_authorisations(id,oauth_app_id,user_id,company_id,scopes,access_token_expires_at,refresh_token_hash,refresh_token_prefix,refresh_token_expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day',$1::uuid::text,'synthetic',now()+interval '1 day')",[oauthGrant,oauthApp,f.u1.id,f.companyA,PAT_SCOPES]);
  const accounts:Record<string,string>={};
  for(const [role,type] of Object.entries({receivable:'asset',default_revenue:'revenue',vat_output:'liability',bank:'asset',payable:'liability',default_expense:'expense',vat_input:'asset'})){
   const id=randomUUID();accounts[role]=id;await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,12),$3,$4,$5,$6,true,true)",[id,f.companyA,`AR CI ${role}`,type,role,['liability','revenue'].includes(type)?'credit':'debit']);
  }
  async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',pat:boolean|'oauth'=false){
   const user=f[person],client=await pool.connect(),token=user.tokens[0]!;
   try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
    const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:pat==='oauth'?'oauth':pat?'pat':'cookie',...(pat?{connectionId:pat==='oauth'?oauthApp:token.id,grantId:pat==='oauth'?oauthGrant:token.id,grantedScopes:PAT_SCOPES}:{})},()=>fn(requireControlTx()));
    await client.query('COMMIT');return result;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async function invoice(subtotal=100,status='draft'){
   const id=randomUUID(),total=subtotal*1.15;
   await pool.query("INSERT INTO customer_invoices(id,company_id,client_id,customer_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by,status) VALUES($1,$2,$3,$3,$1::uuid::text,'2026-07-05',$4,$5,$6,'ZAR',1,$6,$7,$8)",[id,f.companyA,customer,subtotal,subtotal*.15,total,f.u1.id,status]);
   await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'AR CI service',1,$2,$2,15)",[id,subtotal]);return id;
  }
  async function approval(ref:OperationRef,pat=false){const request=await actor(ctx=>requestOperationApproval(ctx,ref),'u1',pat);if(request.status==='pending')await actor(ctx=>decideOperationApproval(ctx,request.id,'approved'),'u2');return request.id;}
  async function state(){return Promise.all(['customer_invoices','customer_payments','credit_notes','gl_journal_entries','gl_journal_lines','control_operation_effects'].map(async table=>(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE company_id=$1 ORDER BY id`,[f.companyA])).rows));}
  const handler=(await import('../../../pages/api/accounting/customer-invoices-detail')).default;
  server=createServer((req,res)=>{void apiResolver(req,res,{}, {default:handler},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,req.url).catch(()=>{res.statusCode=500;res.end('Synthetic AR route failure');});});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',()=>{server!.removeListener('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw new Error('AR listener unavailable');const port=address.port;
  async function rest(body:Record<string,unknown>){const jwt=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(f.u1.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(jwtKey));
   const result=await fetch(`http://127.0.0.1:${port}/api/accounting/customer-invoices-detail`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',cookie:`sb-access-token=${jwt}; active_company_id=${f.companyA}; isaflow_csrf=${csrf}`,'x-csrf-token':csrf},body:JSON.stringify(body)});return{status:result.status,body:await result.json()};}
  return{f,pool,customer,oauthGrant,accounts,actor,invoice,approval,state,rest,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'AR setup failed');}throw error;}
}
