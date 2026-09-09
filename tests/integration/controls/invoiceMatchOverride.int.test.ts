import {capturedStorage} from './capturedEvidenceTestStorage';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {finalizeRequestTransaction} from '@/lib/auth/transactionFinalization';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {checkThreeWayMatchExceptions} from '@/modules/accounting/services/controls/threeWayMatchChecks';
import {queryThreeWayMatch} from '@/modules/accounting/services/ap/threeWayMatchQueryService';
import {prepareInvoiceMatchOverride} from '@/modules/accounting/services/ap/invoiceMatchOverridePreparation';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {executeInvoiceMatchOverride} from '@/modules/accounting/services/ap/invoiceMatchOverrideEffect';
import {queryInvoiceMatchOverrides} from '@/modules/accounting/services/ap/invoiceMatchOverrideQuery';
import {performThreeWayMatch} from '@/modules/accounting/services/ap/supplierInvoiceThreeWayMatch';
import {withInvoiceMatchSourceLocks} from '@/modules/accounting/services/ap/invoiceMatchOverrideMaterial';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture;
beforeAll(()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');});
beforeEach(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',tokenIndex?:number){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:tokenIndex===undefined?'cookie':'pat',...(tokenIndex===undefined?{}:{connectionId:user.tokens[tokenIndex]!.id,grantId:user.tokens[tokenIndex]!.id,grantedScopes:['read:invoices','write:invoices','read:reports','write:approvals']})},()=>fn(requireControlTx()));
  await finalizeRequestTransaction(client,false);return result;
 }catch(error){await finalizeRequestTransaction(client,true);throw error;}finally{client.release();}
}

async function flatCase(){
 const supplier=randomUUID(),po=randomUUID(),line=randomUUID(),invoices=[randomUUID(),randomUUID()];
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic three-way')",[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,order_date,status) VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','received')`,[po,fixture.companyA,supplier]);
 await pool.query(`INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,100,1000)`,[line,po]);
 for(const [index,qty] of [4,6].entries()){
  const grn=randomUUID();await pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
   VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'accepted')`,[grn,fixture.companyA,po,fixture.u1.id]);
  await pool.query(`INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected) VALUES($1,$2,$3,$4)`,[grn,line,qty,index===0?2:0]);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,grn_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
   VALUES($1::uuid,$2,$1::text,$3,$4,$5,'2026-09-09',$6,0,$6,'ZAR','approved',$7)`,[invoices[index],fixture.companyA,supplier,po,grn,qty*100,fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_invoice_items(id,supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
   VALUES($1,$2,$3,'Synthetic',$4,100,$5)`,[randomUUID(),invoices[index],line,qty,qty*100]);
 }
 return{supplier,po,line,invoices};
}
async function overrideCase(){
 const data=await flatCase(),invoiceId=data.invoices[0]!,document=randomUUID(),bytes=Buffer.from('Synthetic signed price exception');
 await pool.query('UPDATE supplier_invoice_items SET unit_price=103 WHERE supplier_invoice_id=$1',[invoiceId]);
 const hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic.pdf','pdf','matched',$3)`,[document,fixture.companyA,invoiceId]);
 await capturedStorage().seed(pool,fixture.companyA,document,bytes);
 const match=await actor(ctx=>queryThreeWayMatch(ctx,{invoiceId}));
 return{...data,invoiceId,document,input:{invoiceId,expectedMatchFingerprint:match.materialFingerprint,reason:'Synthetic agreed price exception',
 evidenceRefs:[{store:'captured' as const,evidenceId:document,entityType:'supplier_invoice',entityId:invoiceId,version:null,hash}]}};
}
it('prepares immutable same-invoice evidence and refuses tampered bytes before a new intent',async()=>{
 const data=await overrideCase();const prepared=await actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input));
 expect((await pool.query('SELECT invoice_id,reason FROM control_invoice_match_override_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0]).toEqual({invoice_id:data.invoiceId,reason:data.input.reason});
 capturedStorage().put(fixture.companyA,data.document,Buffer.from('tampered'));
 await expect(actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input))).rejects.toThrow('evidence bytes');
 expect((await pool.query('SELECT id FROM control_invoice_match_override_intents WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(1);
});
it('freezes uncooperative source writes and restores the caller lock timeout',async()=>{
 const data=await overrideCase();
 await actor(async ctx=>{
  await ctx.sql`SELECT set_config('lock_timeout','321ms',true)`;
  await withInvoiceMatchSourceLocks(ctx,async()=>{
   const writer=await pool.connect();try{await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
    await expect(writer.query('UPDATE po_items SET quantity=11 WHERE purchase_order_id=$1',[data.po])).rejects.toMatchObject({code:'55P03'});
   }finally{await writer.query('ROLLBACK');writer.release();}
  });
  const [setting]=await ctx.sql`SELECT current_setting('lock_timeout') AS value`;expect(setting!.value).toBe('321ms');
 });
});
it('refuses source lock contention and rolls back its timeout setting without poisoning a caught caller',async()=>{
 const writer=await pool.connect();try{
  await writer.query('BEGIN');await writer.query('LOCK TABLE control_entity_versions IN ROW EXCLUSIVE MODE');
  await actor(async ctx=>{
   await ctx.sql`SELECT set_config('lock_timeout','321ms',true)`;
   await expect(withInvoiceMatchSourceLocks(ctx,async()=>true)).rejects.toMatchObject({code:'55P03'});
   const [setting]=await ctx.sql`SELECT current_setting('lock_timeout') AS value`;expect(setting!.value).toBe('321ms');
  });
 }finally{await writer.query('ROLLBACK');writer.release();}
});

async function approvedOverride(tokenIndex?:number){
 const data=await overrideCase(),prepared=await actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input),'u1',tokenIndex);
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u1',tokenIndex);
 await actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u2');
 return{...data,...prepared,approvalId:approval.id};
}
it('refuses self approval through another token and proxy approval requests for another maker',async()=>{
 const data=await overrideCase(),prepared=await actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input),'u1',0);
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u1',0);
 await expect(actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'),'u1',1)).rejects.toThrow();
 await expect(actor(ctx=>decideOperationApproval(ctx,approval.id,'approved'))).rejects.toThrow('Self');
 await expect(actor(ctx=>requestOperationApproval(ctx,prepared.operation),'u2')).rejects.toThrow();
});
it('allows an independent invoice reader with approval authority to decide without invoice write authority',async()=>{
 const data=await overrideCase(),prepared=await actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input));
 const approval=await actor(ctx=>requestOperationApproval(ctx,prepared.operation));
 await pool.query(`INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write)
 VALUES($1,$2,'suppliers',true,false),($1,$2,'customers',true,false)`,[fixture.companyA,fixture.u2.id]);
 await actor(async ctx=>{
  const {assertEffectivePermission}=await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx,'read:invoices');await assertEffectivePermission(ctx,'write:approvals');
  await expect(assertEffectivePermission(ctx,'write:invoices')).rejects.toMatchObject({code:'CONTROL_FORBIDDEN'});
  expect((await decideOperationApproval(ctx,approval.id,'approved')).status).toBe('approved');
 },'u2');
});
it('requires independent approval then records only one annotation under concurrent retries without posting scope',async()=>{
 const data=await approvedOverride(0);
 const results=await Promise.all([1,2].map(()=>actor(ctx=>executeInvoiceMatchOverride(ctx,data.intentId,data.approvalId),'u1',0)));
 expect(results[0]).toEqual(results[1]);expect(results[0]?.status).toBe('annotated');
 expect(await actor(ctx=>executeInvoiceMatchOverride(ctx,data.intentId),'u1',0)).toEqual(results[0]);
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='invoice_match.override'",[fixture.companyA,data.intentId])).rows).toHaveLength(1);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('keeps numeric mismatches visible, ignores identical cache recomputation and marks changed source stale',async()=>{
 const data=await approvedOverride();await actor(()=>performThreeWayMatch(fixture.companyA,data.invoiceId));
 await actor(ctx=>executeInvoiceMatchOverride(ctx,data.intentId,data.approvalId));
 const active=await actor(ctx=>queryInvoiceMatchOverrides(ctx,data.invoiceId));expect(active.overrides[0]?.state).toBe('active');
 expect(active.matchResults[0]?.match?.priceMatch).toBe(false);expect((await actor(ctx=>checkThreeWayMatchExceptions(ctx,{}))).findingCount).toBe(1);
 expect((await actor(ctx=>queryInvoiceMatchOverrides(ctx,data.invoiceId),'u3')).overrides).toEqual([]);
 await pool.query('UPDATE po_items SET unit_price=99 WHERE id=$1',[data.line]);
 const stale=await actor(ctx=>queryInvoiceMatchOverrides(ctx,data.invoiceId));expect(stale.overrides[0]?.state).toBe('stale');
 await expect(actor(ctx=>executeInvoiceMatchOverride(ctx,data.intentId))).rejects.toThrow('stale');
});
it.each(['source','evidence','requester','approver'] as const)('refuses stale or revoked %s before annotation',async kind=>{
 const data=await approvedOverride(0);
 if(kind==='source')await pool.query('UPDATE po_items SET quantity=11 WHERE id=$1',[data.line]);
 if(kind==='evidence')capturedStorage().put(fixture.companyA,data.document,Buffer.from('Changed'));
 if(kind==='requester')await pool.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[fixture.u1.tokens[0]!.id]);
 if(kind==='approver')await pool.query('DELETE FROM company_users WHERE company_id=$1 AND user_id=$2',[fixture.companyA,fixture.u2.id]);
 await expect(actor(ctx=>executeInvoiceMatchOverride(ctx,data.intentId,data.approvalId),'u1',0)).rejects.toThrow();
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='invoice_match.override'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
});
it('rolls back annotation effect, approval consumption and committed audit together',async()=>{
 const data=await approvedOverride();
 await expect(actor(async ctx=>{await executeInvoiceMatchOverride(ctx,data.intentId,data.approvalId);throw new Error('Synthetic outer rollback');})).rejects.toThrow('Synthetic outer rollback');
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='invoice_match.override'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
 expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='invoice_match.override'",[fixture.companyA,data.intentId])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,data.approvalId])).rows[0].status).toBe('approved');
 expect((await actor(ctx=>queryInvoiceMatchOverrides(ctx,data.invoiceId))).overrides[0]?.state).toBe('pending');
});
