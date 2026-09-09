import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {captureControlExceptions,listControlExceptions,assignControlException,resolveControlException} from '@/modules/accounting/services/controls/controlExceptionService';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
process.env.DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});let fixture:ForensicFixture;
const checkId='three_way_match_exceptions';
beforeEach(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1',rollback=false,bearer=false){
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const token=user.tokens[0]!;
  const identity=bearer?{personId:user.id,companyId:user.companyId,authMethod:'pat' as const,connectionId:token.id,grantId:token.id,grantedScopes:['read:reports','read:invoices','write:approvals']}
   :{personId:user.id,companyId:user.companyId,authMethod:'cookie' as const};
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},identity,()=>fn(requireControlTx()));
  await client.query(rollback?'ROLLBACK':'COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function seed(){
 const supplier=randomUUID(),po=randomUUID(),line=randomUUID(),invoice=randomUUID(),grn=randomUUID();
 await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic exception supplier')",[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,order_date,status) VALUES($1::uuid,$2,$1::text,$3,'2026-09-09','received')`,[po,fixture.companyA,supplier]);
 await pool.query(`INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,100,1000)`,[line,po]);
 await pool.query(`INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_date,received_by,status)
 VALUES($1::uuid,$2,$1::text,$3,'2026-09-09',$4,'accepted')`,[grn,fixture.companyA,po,fixture.u1.id]);
 await pool.query(`INSERT INTO grn_items(grn_id,po_item_id,quantity_received,quantity_rejected) VALUES($1,$2,10,0)`,[grn,line]);
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,invoice_number,supplier_id,purchase_order_id,grn_id,invoice_date,subtotal,tax_amount,total_amount,currency,status,created_by)
 VALUES($1::uuid,$2,$1::text,$3,$4,$5,'2026-09-09',1030,0,1030,'ZAR','approved',$6)`,[invoice,fixture.companyA,supplier,po,grn,fixture.u1.id]);
 await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Synthetic',10,103,1030)`,[invoice,line]);
 await pool.query(`INSERT INTO control_entity_versions(company_id,entity_type,entity_id,version,material_hash) VALUES($1,'supplier_invoice',$2,1,'synthetic')`,[fixture.companyA,invoice]);
 return{invoice,po,line};
}
async function observed(){await seed();const captured=await actor(ctx=>captureControlExceptions(ctx,{checkId,cutoff:'2026-09-09'}));expect(captured.findingCount).toBe(1);return captured.exceptionIds[0]!;}
const accept=(id:string,expectedVersion=1)=>({exceptionId:id,expectedVersion,resolution:'accepted_risk',reason:'Time-bounded synthetic acceptance',expiresAt:'2099-01-01T00:00:00Z'});
it('persists real findings and accepted risk, then reopens the same identity across cutoffs',async()=>{
 const id=await observed();const accepted=await actor(ctx=>resolveControlException(ctx,accept(id)),'u2');
 expect(accepted.outcome).toBe('accepted_risk');expect(accepted.exception.reviewerPersonId).toBe(fixture.u2.id);
 expect(accepted.exception.resolutionReason).toBe('Time-bounded synthetic acceptance');expect(accepted.exception.riskExpiresAt).toContain('2099-01-01');
 const second=await actor(ctx=>captureControlExceptions(ctx,{checkId,cutoff:'2026-09-10'}));expect(second.exceptionIds).toEqual([id]);
 const result=await actor(ctx=>listControlExceptions(ctx,{checkId}));expect(result.exceptions).toHaveLength(1);
 expect(result.exceptions[0]).toMatchObject({status:'open',occurrenceCount:2,version:3,cutoff:'2026-09-10'});
 const history=await pool.query('SELECT check_result FROM control_exception_occurrences WHERE company_id=$1 AND exception_id=$2 ORDER BY exception_version',[fixture.companyA,id]);
 expect(history.rows.map(r=>r.check_result.cutoff)).toEqual(['2026-09-09','2026-09-10']);
});
it('failed real recheck remains open with retained decision and evidence',async()=>{
 const id=await observed();const result=await actor(ctx=>resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Attempted correction'}),'u2');
 expect(result.outcome).toBe('recheck_blocked');expect(result.exception.status).toBe('open');expect(result.exception.lastRecheck).toMatchObject({status:'fail',findingCount:1});
 const history=await pool.query('SELECT action,decision FROM control_exception_decisions WHERE company_id=$1 AND exception_id=$2 ORDER BY new_version',[fixture.companyA,id]);
 expect(history.rows.map(r=>r.action)).toEqual(['observed','recheck_blocked']);
});
it('actual source correction allows independent fixed resolution once the real complete check passes',async()=>{
 const data=await seed();const captured=await actor(ctx=>captureControlExceptions(ctx,{checkId}));
 await pool.query('UPDATE supplier_invoice_items SET unit_price=100,line_total=1000 WHERE supplier_invoice_id=$1',[data.invoice]);
 const result=await actor(ctx=>resolveControlException(ctx,{exceptionId:captured.exceptionIds[0],expectedVersion:1,resolution:'fixed',reason:'Corrected exact PO price'}),'u2');
 expect(result.outcome).toBe('fixed');expect(result.exception.status).toBe('fixed');expect(result.exception.lastRecheck).toMatchObject({status:'pass',findingCount:0,sourceVersions:[{entityType:'supplier_invoice',entityId:data.invoice,version:1,fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)}]});
 const retained=await pool.query("SELECT decision->'recheck' AS recheck FROM control_exception_decisions WHERE company_id=$1 AND exception_id=$2 AND action='fixed'",[fixture.companyA,captured.exceptionIds[0]]);
 expect(retained.rows[0].recheck).toEqual(result.exception.lastRecheck);
 await pool.query('UPDATE supplier_invoice_items SET unit_price=103,line_total=1030 WHERE supplier_invoice_id=$1',[data.invoice]);
 const recurring=await actor(ctx=>captureControlExceptions(ctx,{checkId}));expect(recurring.exceptionIds).toEqual(captured.exceptionIds);
 expect((await actor(ctx=>listControlExceptions(ctx,{checkId}))).exceptions[0]).toMatchObject({status:'open',occurrenceCount:2});
});
it('refuses owner and reporter self review, bearer review and revoked human permission',async()=>{
 const id=await observed();await expect(actor(ctx=>resolveControlException(ctx,accept(id)))).rejects.toThrow(/Independent/);
 await expect(actor(ctx=>resolveControlException(ctx,accept(id)),'u2',false,true)).rejects.toThrow(/Independent/);
 await actor(ctx=>assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId:fixture.u2.id,dueAt:null}));
 await expect(actor(ctx=>resolveControlException(ctx,accept(id,2)),'u2')).rejects.toThrow(/Independent/);
 await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
 await expect(actor(ctx=>resolveControlException(ctx,accept(id,2)),'u2')).rejects.toThrow(/permissions/);
});
it('scopes listing, assignment, owners and immutable evidence to the authenticated company',async()=>{
 const id=await observed();expect((await actor(ctx=>listControlExceptions(ctx,{checkId}),'u3')).exceptions).toEqual([]);
 await expect(actor(ctx=>assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId:fixture.u1.id,dueAt:null}),'u3')).rejects.toThrow(/not found/);
 await expect(actor(ctx=>assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId:fixture.u3.id,dueAt:null}))).rejects.toThrow(/unavailable/);
 expect(await actor(ctx=>ctx.sql`SELECT id FROM control_exception_occurrences WHERE company_id=${fixture.companyA}::uuid AND exception_id=${id}::uuid`,'u3')).toEqual([]);
 await expect(actor(ctx=>ctx.sql`UPDATE control_exception_decisions SET action='fixed' WHERE company_id=${fixture.companyA}::uuid AND exception_id=${id}::uuid`)).rejects.toThrow();
 await expect(actor(ctx=>ctx.sql`DELETE FROM control_exception_occurrences WHERE company_id=${fixture.companyA}::uuid AND exception_id=${id}::uuid`)).rejects.toThrow();
});
it('serializes same-version assignments and retains exactly one winning decision',async()=>{
 const id=await observed();const outcomes=await Promise.allSettled([fixture.u1.id,fixture.u2.id].map(ownerPersonId=>actor(ctx=>assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId,dueAt:'2026-10-01T00:00:00Z'}))));
 expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
 const history=await pool.query('SELECT action FROM control_exception_decisions WHERE company_id=$1 AND exception_id=$2',[fixture.companyA,id]);expect(history.rows).toHaveLength(2);
});
it('rolls back observations and immutable histories with the caller transaction',async()=>{
 await seed();const result=await actor(ctx=>captureControlExceptions(ctx,{checkId}),'u1',true);
 for(const table of ['control_exceptions','control_exception_decisions','control_exception_occurrences']){
  // Static allowlisted fixture tables; production service uses tagged SQL exclusively.
  const rows=await pool.query(`SELECT id FROM ${table} WHERE company_id=$1`,[fixture.companyA]);expect(rows.rows).toEqual([]);
 }
 expect(result.observedCount).toBe(1);
});
it('a failed decision insert rolls back assignment even when caller catches the error',async()=>{
 const id=await observed(),constraint=`synthetic_exception_${randomUUID().replaceAll('-','')}`;
 await pool.query(`ALTER TABLE control_exception_decisions ADD CONSTRAINT ${constraint} CHECK(exception_id<>'${id}'::uuid OR action<>'assigned') NOT VALID`);
 try{
  await expect(actor(async ctx=>{try{await assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId:fixture.u1.id,dueAt:null});}catch(error){expect(String(error)).toContain(constraint);}})).rejects.toThrow(/evidence/);
  const listed=await actor(ctx=>listControlExceptions(ctx,{checkId}));expect(listed.exceptions[0]).toMatchObject({version:1,ownerPersonId:null});
 }finally{await pool.query(`ALTER TABLE control_exception_decisions DROP CONSTRAINT ${constraint}`);}
});
it('captures every finding through explicit bounded pages and lists without creating observations',async()=>{
 const data=await seed();
 await pool.query(`WITH added AS (INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total)
 SELECT gen_random_uuid(),$1,'Additional synthetic exception',1,100,100 FROM generate_series(1,100) RETURNING id)
 INSERT INTO supplier_invoice_items(supplier_invoice_id,po_item_id,description,quantity,unit_price,line_total)
 SELECT $2,id,'Additional synthetic exception',1,103,103 FROM added`,[data.po,data.invoice]);
 const first=await actor(ctx=>captureControlExceptions(ctx,{checkId,limit:100}));expect(first.findingCount).toBe(101);expect(first.observedCount).toBe(100);expect(first.pageComplete).toBe(false);
 const second=await actor(ctx=>captureControlExceptions(ctx,{checkId,limit:100,cursor:first.nextCursor!}));expect(second.observedCount).toBe(1);expect(second.pageComplete).toBe(true);
 const page=await actor(ctx=>listControlExceptions(ctx,{checkId,limit:100}));expect(page.exceptions).toHaveLength(100);
 const tail=await actor(ctx=>listControlExceptions(ctx,{checkId,limit:100,cursor:page.nextCursor!}));expect(tail.exceptions).toHaveLength(1);
 const count=await pool.query('SELECT count(*)::int AS count FROM control_exception_occurrences WHERE company_id=$1',[fixture.companyA]);expect(count.rows[0].count).toBe(101);
});
it('captures with report/source read authority without granting the ability to decide',async()=>{
 await seed();await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);
 const result=await actor(ctx=>captureControlExceptions(ctx,{checkId}));expect(result.observedCount).toBe(1);
 await expect(actor(ctx=>assignControlException(ctx,{exceptionId:result.exceptionIds[0],expectedVersion:1,ownerPersonId:fixture.u1.id,dueAt:null}))).rejects.toThrow(/permissions/);
});
it('keeps fixed blocked when the observed rule differs from the current server checker',async()=>{
 const data=await seed();const captured=await actor(ctx=>captureControlExceptions(ctx,{checkId}));const id=captured.exceptionIds[0]!;
 await pool.query('UPDATE supplier_invoice_items SET unit_price=100,line_total=1000 WHERE supplier_invoice_id=$1',[data.invoice]);
 await pool.query('UPDATE control_exceptions SET check_version=2 WHERE company_id=$1 AND id=$2',[fixture.companyA,id]);
 const result=await actor(ctx=>resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Source corrected but rule changed'}),'u2');
 expect(result.outcome).toBe('recheck_blocked');expect(result.exception.lastRecheck).toMatchObject({status:'pass',checkVersion:1});expect(result.exception.status).toBe('open');
});
it('shows expired accepted risk explicitly and preserves its reason and reviewer on reads',async()=>{
 const id=await observed();await actor(ctx=>resolveControlException(ctx,accept(id)),'u2');
 await pool.query("UPDATE control_exceptions SET risk_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND id=$2",[fixture.companyA,id]);
 const result=await actor(ctx=>listControlExceptions(ctx,{checkId,status:'accepted_risk'}));
 expect(result.exceptions[0]).toMatchObject({status:'accepted_risk',riskExpired:true,reviewerPersonId:fixture.u2.id,resolutionReason:'Time-bounded synthetic acceptance'});
});
it('refuses assignment to a suspended same-company owner without changing the exception',async()=>{
 const id=await observed();await pool.query('UPDATE users u SET suspended_at=clock_timestamp() FROM company_users cu WHERE cu.company_id=$1 AND cu.user_id=u.id AND u.id=$2',[fixture.companyA,fixture.u2.id]);
 await expect(actor(ctx=>assignControlException(ctx,{exceptionId:id,expectedVersion:1,ownerPersonId:fixture.u2.id,dueAt:null}))).rejects.toThrow(/unavailable/);
 expect((await actor(ctx=>listControlExceptions(ctx,{checkId}))).exceptions[0]).toMatchObject({version:1,ownerPersonId:null});
});
