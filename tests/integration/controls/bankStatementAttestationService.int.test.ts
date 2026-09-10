import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {checkBankStatementCompleteness} from '@/modules/accounting/services/controls/bankStatementCompletenessChecks';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationEffect';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import {queryVerifiedBankStatements} from '@/modules/accounting/services/controls/bankStatementAttestationQuery';
import {prepareBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationPreparation';
import {materializeBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {insertCaseVariantReceipt} from './intentReceiptRows';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture,account:string,document:string,hash:string;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',tokenIndex?:number){
 const client=await pool.connect(),user=fixture[person];try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:tokenIndex===undefined?'cookie':'pat',...(tokenIndex===undefined?{}:{connectionId:user.tokens[tokenIndex]!.id,grantId:user.tokens[tokenIndex]!.id,grantedScopes:['read:bank-tx','write:bank-tx','read:reports','write:approvals']})},()=>fn(requireControlTx()));
  await finalizeRequestTransaction(client,false);return result;
 }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
}
beforeEach(async()=>{
 fixture=await provisionForensicFixture(config);account=randomUUID();document=randomUUID();
 const bytes=Buffer.from('Synthetic independent local statement, zero transactions');hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level)
 VALUES($1::uuid,$2,left($1::text,12),'Synthetic statement bank','asset','bank','debit',true,3)`,[account,fixture.companyA]);
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status) VALUES($1,$2,'synthetic-statement.pdf','pdf','matched')`,[document,fixture.companyA]);
 await capturedStorage().seed(pool,fixture.companyA,document,bytes);
});
afterAll(()=>pool.end());
const input=()=>({bankAccountId:account,sourceDocumentId:document,expectedSourceHash:hash,periodStart:'2026-09-01',periodEnd:'2026-09-30',
 sourceCount:0,openingBalance:'-10',closingBalance:'-10',currency:'ZAR'});
it('prepares owned actual statement bytes and stable zero-count material without journal effects',async()=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 const material=await actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation));
 expect(material.binding.operation).toBe('bank_statement.attest');expect(material.binding.currency).toBe('ZAR');
 expect(material.binding.sourceVersions).toHaveLength(1);
 expect((await actor(ctx=>queryVerifiedBankStatements(ctx,null))).populationCount).toBe(0);
 expect((await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows[0].n).toBe(0);
});
it('rejects foreign owner, forged hash and changed actual bytes even when stored hash remains unchanged',async()=>{
 await expect(actor(ctx=>prepareBankStatementAttestation(ctx,input()),'u3')).rejects.toThrow();
 await expect(actor(ctx=>prepareBankStatementAttestation(ctx,{...input(),expectedSourceHash:'a'.repeat(64)}))).rejects.toThrow();
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 capturedStorage().put(fixture.companyA,document,Buffer.from('Tampered'));
 await expect(actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation))).rejects.toThrow();
});
it.each(['account','currency'] as const)('invalidates prepared statement after current %s changes',async kind=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 if(kind==='account')await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);
 else await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA]);
 await expect(actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation))).rejects.toThrow();
});

async function approvedStatement(tokenIndex?:number){
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()),'u1',tokenIndex);
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u1',tokenIndex);
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');return{...prepared,approvalId:approval.id};
}
it('refuses self approval through a second token and proxy requester identity',async()=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()),'u1',0);
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u1',0);
 await expect(actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u1',1)).rejects.toThrow();
 await expect(actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u2')).rejects.toThrow();
});
it('accepts an independent bank reader with approval authority without bank write authority',async()=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation));
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',true,false)",[fixture.companyA,fixture.u2.id]);
 await actor(async ctx=>{
  const {assertEffectivePermission}=await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx,'read:bank-tx');await expect(assertEffectivePermission(ctx,'write:bank-tx')).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
  expect((await decideOperationApproval(ctx,approval.id,'approved')).status).toBe('approved');
 },'u2');
});
it('commits one independently reviewed annotation under concurrency and replays without posting authority',async()=>{
 const data=await approvedStatement(0);
 const results=await Promise.all([1,2].map(()=>actor(ctx=>executeBankStatementAttestation(ctx,data.intentId,data.approvalId),'u1',0)));
 expect(results[0]).toEqual(results[1]);expect(results[0]?.status).toBe('locally_reviewed');
 expect(await actor(ctx=>executeBankStatementAttestation(ctx,data.intentId),'u1',0)).toEqual(results[0]);
 const verified=await actor(ctx=>queryVerifiedBankStatements(ctx,null));expect(verified.rows).toHaveLength(1);expect(verified.rows[0]?.active).toBe(true);
 expect((await actor(ctx=>queryVerifiedBankStatements(ctx,null),'u3')).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it.each(['bytes','requester','approver','expiry'] as const)('rejects changed or revoked %s before annotation',async kind=>{
 const data=await approvedStatement(0);
 if(kind==='bytes')capturedStorage().put(fixture.companyA,document,Buffer.from('Changed'));
 if(kind==='requester')await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[fixture.u1.tokens[0]!.id]);
 if(kind==='approver')await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u2.id]);
 if(kind==='expiry')await pool.query("UPDATE control_operation_approvals SET expires_at=requested_at+interval '1 microsecond' WHERE company_id=$1 AND id=$2",[fixture.companyA,data.approvalId]);
 await expect(actor(ctx=>executeBankStatementAttestation(ctx,data.intentId,data.approvalId),'u1',0)).rejects.toThrow();
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_statement.attest'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
});
it('rolls back annotation, approval consumption and audit if the surrounding transaction fails',async()=>{
 const data=await approvedStatement();
 await expect(actor(async ctx=>{await executeBankStatementAttestation(ctx,data.intentId,data.approvalId);throw new Error('Synthetic outer rollback');})).rejects.toThrow('Synthetic outer rollback');
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_statement.attest'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
 expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='bank_statement.attest'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,data.approvalId])).rows[0].status).toBe('approved');
});
it('restores lock timeout and transaction usability after a caught source-lock refusal',async()=>{
 const writer=await pool.connect();try{
  await writer.query('BEGIN');await writer.query('SELECT id FROM gl_accounts WHERE company_id=$1 AND id=$2 FOR UPDATE',[fixture.companyA,account]);
  await actor(async ctx=>{
   await ctx.sql`SELECT set_config('lock_timeout','321ms',true)`;
   await expect(prepareBankStatementAttestation(ctx,input())).rejects.toMatchObject({code:'55P03'});
   const [setting]=await ctx.sql`SELECT current_setting('lock_timeout') AS value`;expect(setting!.value).toBe('321ms');
  });
 }finally{await writer.query('ROLLBACK');writer.release();}
});
it('passes a current independently reviewed quiet statement locally without claiming external bank confirmation',async()=>{
 const data=await approvedStatement();await actor(ctx=>executeBankStatementAttestation(ctx,data.intentId,data.approvalId));
 const result=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(result.status).toBe('pass');
 expect(result.populationCount).toBe(1);expect(result.findingCount).toBe(0);expect(result.missingSources).toEqual([]);
 expect(result.coverage).toContain('external_bank_confirmation_not_performed');
 await pool.query(`INSERT INTO bank_statement_imports(company_id,bank_account_id,source_document_id,period_start,period_end,row_count,opening_balance,closing_balance,status)
 VALUES($1,$2,$3,'2026-09-01','2026-09-30',99,-10,100,'committed')`,[fixture.companyA,account,document]);
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{}))).status).toBe('pass');
 const outside=randomUUID();await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
 VALUES($1,$2,$3,'2026-10-01',10,'Synthetic outside statement period','imported')`,[outside,fixture.companyA,account]);
 const uncovered=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(uncovered.status).toBe('unknown');
 expect(uncovered.missingSources).toContain('imported_transactions_outside_source_statement_periods');
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{cutoff:'2026-09-30'}))).status).toBe('pass');
 await pool.query('DELETE FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,outside]);
 const tx=randomUUID();await pool.query(`INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
 VALUES($1,$2,$3,'2026-09-09',10,'Synthetic statement divergence','imported')`,[tx,fixture.companyA,account]);
 const discrepancy=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));expect(discrepancy.status).toBe('fail');
 expect(discrepancy.findingCount).toBe(1);expect(discrepancy.amountTotals).toEqual({ZAR:'10'});
 expect(discrepancy.findings[0]?.classification).toBe('candidate');
 await pool.query('DELETE FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx]);
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{cutoff:'2026-09-29'}))).status).toBe('unknown');
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{}),'u3')).populationCount).toBe(0);

 capturedStorage().put(fixture.companyA,document,Buffer.from('Changed after review'));
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{}))).status).toBe('unknown');
});
it('a twin receipt of a reviewed statement is a second execution: the check fails and names both receipts',async()=>{
 const data=await approvedStatement();await actor(ctx=>executeBankStatementAttestation(ctx,data.intentId,data.approvalId));
 expect((await actor(ctx=>checkBankStatementCompleteness(ctx,{}))).status).toBe('pass');
 const [first]=(await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_statement.attest'",[fixture.companyA,data.intentId])).rows as {id:string}[];
 const twin=await insertCaseVariantReceipt(pool,{id:fixture.u1.id,companyId:fixture.companyA},first!.id);
 const result=await actor(ctx=>checkBankStatementCompleteness(ctx,{}));
 expect(result.status,'a statement attested twice cannot pass').toBe('fail');
 const finding=result.findings.find(row=>row.kind==='control_receipt_twinned');
 expect(finding,'the second execution is reported as a finding').toBeDefined();
 expect(finding!.entities).toEqual(expect.arrayContaining([{entityType:'control_operation_effect',entityId:first!.id},{entityType:'control_operation_effect',entityId:twin.id}]));
 expect(finding!.message).toContain(first!.id);expect(finding!.message).toContain(twin.id);
});

it('commits an independently approved local statement effect once through central dispatch',async()=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 await expect(actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u2')).rejects.toThrow('Original intent requester');
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation));
 await expect(actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow(/Self/);
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 const result=await actor(ctx=>executeBankStatementAttestation(ctx,prepared.intentId,approval.id));
 expect(result.status).toBe('locally_reviewed');
 expect(await actor(ctx=>executeBankStatementAttestation(ctx,prepared.intentId))).toEqual(result);
 expect((await actor(ctx=>queryVerifiedBankStatements(ctx,null))).populationCount).toBe(1);
 expect((await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows[0].n).toBe(0);
});
