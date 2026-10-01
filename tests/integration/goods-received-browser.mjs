// Real goods-received browser/API/PostgreSQL acceptance on the guarded disposable host.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
const origin='http://127.0.0.1:33200';
const db=new URL(process.env.DATABASE_URL??'http://missing.invalid');
if(process.env.ISAFLOW_DISPOSABLE_AUTH_TEST!=='1'||db.hostname!=='127.0.0.1'||db.port!=='33140'||db.pathname!=='/isaflow_schema_fixture')throw new Error('Explicit disposable fixture required');
const pool=new Pool({connectionString:db.toString()});
const company=crypto.randomUUID(),user=crypto.randomUUID();
const supplier=crypto.randomUUID(),po=crypto.randomUUID(),item=crypto.randomUUID();
const browser=await chromium.launch({headless:true});
try{
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)',[company,'GRN browser fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[company,user]);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)',[supplier,company,'Browser supplier']);
  await pool.query("INSERT INTO purchase_orders(id,company_id,po_number,supplier_id,status) VALUES($1,$2,'PO-browser',$3,'approved')",[po,company,supplier]);
  await pool.query("INSERT INTO po_items(id,purchase_order_id,description,quantity,unit_price,line_total) VALUES($1,$2,'Browser goods',0.30,5,1.50)",[item,po]);
  const jwt=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  // No browser request may leave the disposable host.
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(Object.entries({'sb-access-token':jwt,active_company_id:company,ff_onboarding_done:'1',isaflow_csrf:'disposable-browser-csrf-01234567890123456789'}).map(([name,value])=>({name,value,url:origin})));
  await context.addInitScript(({company})=>localStorage.setItem('isaflow_active_company',JSON.stringify({id:company,name:'GRN browser fixture'})),{company});
  const page=await context.newPage();
  page.on('pageerror',error=>process.stderr.write(`PAGE ERROR: ${error.message}\n`));
  for(const quantity of [0.10,0.20]){
    await page.goto(origin+'/accounting/goods-received/new',{waitUntil:'domcontentloaded',timeout:120000});
    await page.locator('select[name="selectedPO"] option').filter({hasText:'PO-browser'}).waitFor({state:'attached',timeout:120000});
    await page.locator('select[name="selectedPO"]').selectOption(po);
    const row=page.getByRole('row').filter({hasText:'Browser goods'});
    await row.waitFor({timeout:15000});
    if(quantity===0.10) await row.getByRole('spinbutton').fill(String(quantity));
    const [saved]=await Promise.all([
      page.waitForResponse(response=>response.url().endsWith('/api/accounting/goods-received')&&response.request().method()==='POST'),
      page.getByRole('button',{name:'Create GRN',exact:true}).click(),
    ]);
    assert.equal(saved.status(),201);
    await page.waitForURL(origin+'/accounting/goods-received');
    await page.getByText('PO-browser',{exact:true}).first().waitFor();
  }
  const receipts=(await pool.query('SELECT id,received_by FROM goods_received_notes WHERE company_id=$1',[company])).rows;
  assert.equal(receipts.length,2);assert.ok(receipts.every(row=>row.received_by===user));
  assert.equal((await pool.query('SELECT status FROM purchase_orders WHERE company_id=$1 AND id=$2',[company,po])).rows[0].status,'received');
  const totals=(await pool.query('SELECT sum(gi.quantity_received)::text AS quantity FROM grn_items gi JOIN goods_received_notes g ON g.id=gi.grn_id WHERE g.company_id=$1',[company])).rows[0];
  assert.equal(Number(totals.quantity),0.30);
  assert.equal(Number((await pool.query('SELECT pi.quantity_received FROM po_items pi JOIN purchase_orders po ON po.id=pi.purchase_order_id WHERE po.company_id=$1 AND pi.id=$2',[company,item])).rows[0].quantity_received),0.30);
  await page.screenshot({path:'/tmp/isaflow-k007-browser.png',fullPage:true});
  process.stdout.write('PASS actual GRN form -> owned PO detail -> 0.10 receipt -> select same partially received PO -> default0.20 receipt -> list and SQL receipt/PO quantities agree; localhost only.\n');
}finally{
  await browser.close();
  await pool.query('DELETE FROM goods_received_notes WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM purchase_orders WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM suppliers WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM companies WHERE id=$1',[company]);
  await pool.query('DELETE FROM users WHERE id=$1',[user]);
  await pool.end();
}
