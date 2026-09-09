import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {apiResolver} from 'next/dist/server/api-utils/node/api-resolver';
import bankRoute from '../../../pages/api/accounting/bank-transactions-action';
import approvalRoute from '../../../pages/api/accounting/control-approvals';
import {transferReadFixture} from './bankTransferReadFixture';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
export async function transferRestFixture(){
 const f=await transferReadFixture(),csrf=randomBytes(32).toString('hex');
 const server=createServer((req,res)=>{const approvals=req.url==='/api/accounting/control-approvals';
  void apiResolver(req,res,{}, {default:approvals?approvalRoute:bankRoute},{previewModeId:'synthetic',previewModeEncryptionKey:'synthetic',previewModeSigningKey:'synthetic'},true,false,
   approvals?'/api/accounting/control-approvals':'/api/accounting/bank-transactions-action').catch(()=>{res.statusCode=500;res.end('Synthetic transfer route failure');});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic REST server unavailable');
 async function request(body:unknown,person:'u1'|'u2'|'u3'='u1',approvals=false,validCsrf=true){
  const user=f.f[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const path=approvals?'control-approvals':'bank-transactions-action';
  const response=await fetch(`http://127.0.0.1:${address.port}/api/accounting/${path}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:`sb-access-token=${token}; active_company_id=${user.companyId}; isaflow_csrf=${csrf}`,'x-csrf-token':validCsrf?csrf:'invalid'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  return{status:response.status,body:await response.json()};
 }
 async function approved(ref:OperationRef){
  const requirements=await request({action:'requirements',ref},'u1',true);
  if(requirements.status!==200||requirements.body.data.requiresApproval!==true)throw new Error('Actual mandatory approval requirements missing');
  const pending=await request({action:'request',ref},'u1',true);if(pending.status!==200)throw new Error('Actual approval request failed');
  const decision=await request({action:'decide',approvalId:pending.body.data.id,decision:'approved'},'u2',true);
  if(decision.status!==200)throw new Error('Actual independent decision failed');return pending.body.data.id as string;
 }
 async function postBank(bankTransactionId:string,counterpartyAccountId=f.to){
  const prepare=await request({action:'prepare_allocate',allocationType:'transfer',bankTransactionId,contraAccountId:counterpartyAccountId});
  if(prepare.status!==200)throw new Error(`Actual transfer prepare failed: ${JSON.stringify(prepare.body)}`);
  const approvalId=await approved(prepare.body.data.operation),execute=await request({action:'allocate',bankTransactionId,intent_id:prepare.body.data.intentId,approval_id:approvalId});
  if(execute.status!==200)throw new Error(`Actual transfer execute failed: ${JSON.stringify(execute.body)}`);
  return{intentId:prepare.body.data.intentId as string,approvalId,effect:execute.body.data};
 }
 async function posted(withOpposite=true){const bank=await f.bank(),opposite=withOpposite?await f.bank(f.to,'115.23'):null;return{bank,opposite,...await postBank(bank)};}
 async function foreignBank(){
  const account=randomUUID(),bank=randomUUID();
  await f.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active) VALUES($1,$2,left($1::uuid::text,12),'Synthetic foreign bank','asset','bank','debit',true)",[account,f.f.companyB]);
  await f.pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,amount,transaction_date,status) VALUES($1,$2,$3,115.23,'2026-09-09','imported')",[bank,f.f.companyB,account]);return bank;
 }
 const inverseRows=async()=>(await f.pool.query('SELECT * FROM control_bank_allocation_reversal_intents WHERE company_id=$1 ORDER BY id',[f.f.companyA])).rows;
 async function close(){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await f.close();}
 return{...f,request,approved,postBank,posted,foreignBank,inverseRows,close};
}
