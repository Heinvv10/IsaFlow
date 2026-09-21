import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import goodsReceived from '../../pages/api/accounting/goods-received';
import { assertDisposable,request,response } from './mfa-impersonation-postgres.helpers';
assertDisposable();
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const first=crypto.randomUUID(),second=crypto.randomUUID(),user=crypto.randomUUID();
const supplier=crypto.randomUUID(),foreignSupplier=crypto.randomUUID();
const po=crypto.randomUUID(),foreignPo=crypto.randomUUID(),item=crypto.randomUUID(),foreignItem=crypto.randomUUID();
const companies=[first,second];let token='';
beforeAll(async()=>{
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)',[first,'GRN fixture',second,'Foreign GRN fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin'),($3,$2,'admin')",[first,user,second]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3),($4,$5,$6)',[supplier,first,'Fixture supplier',foreignSupplier,second,'Foreign supplier']);
  await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status) VALUES($1,$2,'PO-fixture',$3,'approved'),($4,$5,'PO-foreign',$6,'approved')",[po,first,supplier,foreignPo,second,foreignSupplier]);
  await pool.query("INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Fixture goods',10,5,50),($3,$4,'Foreign goods',10,5,50)",[item,po,foreignItem,foreignPo]);
  token=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});
afterAll(async()=>{
  try{
    await pool.query('DELETE FROM goods_received_notes WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM purchase_orders WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM suppliers WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM company_users WHERE company_id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);
    await pool.query('DELETE FROM users WHERE id=$1',[user]);
  }finally{await pool.end();}
});
async function post(order=po,line=item,quantity:unknown=3,extra:Record<string,unknown>={}){
  const req=request({'sb-access-token':token,active_company_id:first},'POST');req.url='/api/accounting/goods-received';
  req.body={purchaseOrderId:order,receivedDate:'2026-09-08',receivedBy:'Fixture receiver',items:[{poItemId:line,quantityReceived:quantity,quantityRejected:0}],...extra};
  const result=response();await goodsReceived(req,result.res);return result;
}
it('records owned goods and reconciles receipt lines with PO quantity/status',async()=>{
  const result=await post();expect(result.state.statusCode).toBe(201);
  expect((await pool.query('SELECT status FROM purchase_orders WHERE company_id=$1 AND id=$2',[first,po])).rows[0].status).toBe('partially_received');
  expect(Number((await pool.query('SELECT pi.quantity_received::text FROM po_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE po.company_id=$1 AND pi.id=$2',[first,item])).rows[0].quantity_received)).toBe(3);
});
it('refuses a foreign PO even when the user belongs to both companies',async()=>{
  expect((await post(foreignPo,foreignItem)).state.statusCode).toBe(404);
  expect((await pool.query('SELECT id FROM goods_received_notes WHERE company_id=$1 AND purchase_order_id=$2',[first,foreignPo])).rows).toEqual([]);
});
it('refuses a line from another PO before recording a receipt',async()=>{
  expect((await post(po,foreignItem)).state.statusCode).toBe(400);
  expect(Number((await pool.query('SELECT quantity_received FROM po_items WHERE id=$1',[foreignItem])).rows[0].quantity_received)).toBe(0);
});

it.each([-1,'Infinity','NaN',0.001,0])('rejects invalid quantity %s without writes',async quantity=>{
  const before=(await pool.query('SELECT id FROM goods_received_notes WHERE company_id=$1',[first])).rows.length;
  expect((await post(po,item,quantity)).state.statusCode).toBe(400);
  expect((await pool.query('SELECT id FROM goods_received_notes WHERE company_id=$1',[first])).rows).toHaveLength(before);
});
it('rejects duplicate items, malformed date and overreceipt before writes',async()=>{
  const line={poItemId:item,quantityReceived:1,quantityRejected:0};
  expect((await post(po,item,1,{items:[line,line]})).state.statusCode).toBe(400);
  expect((await post(po,item,1,{receivedDate:'2026-02-30'})).state.statusCode).toBe(400);
  expect((await post(po,item,8)).state.statusCode).toBe(400);
});
it('missing PO/item and viewer access are refused',async()=>{
  expect((await post(crypto.randomUUID())).state.statusCode).toBe(404);
  expect((await post(po,crypto.randomUUID())).state.statusCode).toBe(400);
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[first,user]);
  try{expect((await post()).state.statusCode).toBe(403);}finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[first,user]);}
});
it.each(['draft','submitted','cancelled','received'])('refuses %s purchase orders',async status=>{
  await pool.query('UPDATE purchase_orders SET status=$1 WHERE company_id=$2 AND id=$3',[status,first,po]);
  try{expect((await post()).state.statusCode).toBe(400);}finally{await pool.query("UPDATE purchase_orders SET status='partially_received' WHERE company_id=$1 AND id=$2",[first,po]);}
});
it('concurrent receipts cannot exceed remaining quantity and totals reconcile',async()=>{
  const results=await Promise.all([post(po,item,5),post(po,item,5)]);
  expect(results.map(result=>result.state.statusCode).sort()).toEqual([201,400]);
  const received=(await pool.query('SELECT pi.quantity_received FROM po_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE po.company_id=$1 AND pi.id=$2',[first,item])).rows[0];
  expect(Number(received.quantity_received)).toBe(8);
  expect((await post(po,item,2,{receivedBy:null})).state.statusCode).toBe(201);
  expect((await pool.query('SELECT status FROM purchase_orders WHERE company_id=$1 AND id=$2',[first,po])).rows[0].status).toBe('received');
  const totals=(await pool.query('SELECT sum(gi.quantity_received) AS quantity FROM grn_items gi JOIN goods_received_notes g ON g.id=gi.grn_id WHERE g.company_id=$1 AND g.purchase_order_id=$2',[first,po])).rows[0];
  expect(Number(totals.quantity)).toBe(10);
  const receipts=(await pool.query('SELECT grn_number,received_by FROM goods_received_notes WHERE company_id=$1 ORDER BY grn_number',[first])).rows;
  expect(new Set(receipts.map(row=>row.grn_number)).size).toBe(3);expect(receipts[2].received_by).toBe(user);
});
it('a database failure after receipt and line creation rolls all receipt/PO changes back',async()=>{
  const extraPo=crypto.randomUUID(),extraItem=crypto.randomUUID();
  await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status) VALUES($1,$2,'PO-fault',$3,'approved')",[extraPo,first,supplier]);
  await pool.query("INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Fault goods',10,5,50)",[extraItem,extraPo]);
  // Disposable-only trigger: identifiers and argument are generated UUID hex, never user input.
  const name='k007_fault_'+crypto.randomUUID().replaceAll('-','');
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'Disposable receipt post-write fault'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION ${name}('${extraPo}')`);
  try{
    expect((await post(extraPo,extraItem,1)).state.statusCode).toBe(500);
    expect((await pool.query('SELECT id FROM goods_received_notes WHERE company_id=$1 AND purchase_order_id=$2',[first,extraPo])).rows).toEqual([]);
    expect(Number((await pool.query('SELECT pi.quantity_received FROM po_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE po.company_id=$1 AND pi.id=$2',[first,extraItem])).rows[0].quantity_received)).toBe(0);
    expect((await pool.query('SELECT status FROM purchase_orders WHERE company_id=$1 AND id=$2',[first,extraPo])).rows[0].status).toBe('approved');
  }finally{
    await pool.query(`DROP TRIGGER ${name} ON purchase_orders`);await pool.query(`DROP FUNCTION ${name}()`);
  }
});

it('scoped history inventory detects a privileged synthetic foreign-PO receipt',async()=>{
  const id=crypto.randomUUID();
  await pool.query("INSERT INTO goods_received_notes(id,company_id,grn_number,purchase_order_id,received_by) VALUES($1,$2,'LEGACY-bad',$3,'Synthetic control')",[id,first,foreignPo]);
  const query=readFileSync('docs/audits/remediation/K-007/historical-impact.sql','utf8');
  expect((await pool.query(query,[first])).rows.find(row=>row.id===id)).toMatchObject({unowned_purchase_order:true});
  expect((await pool.query(query,[second])).rows).toEqual([]);
  const req=request({'sb-access-token':token,active_company_id:first},'GET');
  const result=response();await goodsReceived(req,result.res);
  expect(result.state.statusCode).toBe(200);expect(JSON.stringify(result.state.body)).not.toContain('PO-foreign');
  expect(JSON.stringify(result.state.body)).not.toContain('Foreign supplier');
});
