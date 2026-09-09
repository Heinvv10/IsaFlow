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
import {withInvoiceMatchSourceLocks} from '@/modules/accounting/services/ap/invoiceMatchOverrideMaterial';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture;
beforeAll(()=>{process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');});
beforeEach(async()=>{fixture=await provisionForensicFixture(config);});
afterAll(()=>pool.end());
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
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
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id,raw_bytes,raw_bytes_sha256)
 VALUES($1,$2,'synthetic.pdf','pdf','matched',$3,$4,$5)`,[document,fixture.companyA,invoiceId,bytes,hash]);
 const match=await actor(ctx=>queryThreeWayMatch(ctx,{invoiceId}));
 return{...data,invoiceId,document,input:{invoiceId,expectedMatchFingerprint:match.materialFingerprint,reason:'Synthetic agreed price exception',
 evidenceRefs:[{store:'captured' as const,evidenceId:document,entityType:'supplier_invoice',entityId:invoiceId,version:null,hash}]}};
}
it('prepares immutable same-invoice evidence and refuses tampered bytes before a new intent',async()=>{
 const data=await overrideCase();const prepared=await actor(ctx=>prepareInvoiceMatchOverride(ctx,data.input));
 expect((await pool.query('SELECT invoice_id,reason FROM control_invoice_match_override_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0]).toEqual({invoice_id:data.invoiceId,reason:data.input.reason});
 await pool.query('UPDATE captured_documents SET raw_bytes=$1 WHERE company_id=$2 AND id=$3',[Buffer.from('tampered'),fixture.companyA,data.document]);
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
