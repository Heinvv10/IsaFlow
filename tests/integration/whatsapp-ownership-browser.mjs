// Run only against the task's disposable server with outbound Twilio credentials unset.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import twilio from 'twilio';
const origin='http://127.0.0.1:33200';
const db=new URL(process.env.DATABASE_URL??'http://missing.invalid');
if(process.env.ISAFLOW_DISPOSABLE_AUTH_TEST!=='1'||db.hostname!=='127.0.0.1'||db.port!=='33140'||db.pathname!=='/isaflow_schema_fixture')throw new Error('Explicit disposable fixture required');
const pool=new Pool({connectionString:db.toString()});
const company=crypto.randomUUID(),user=crypto.randomUUID();
const browser=await chromium.launch({headless:true});
try{
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)',[company,'WhatsApp browser fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[company,user]);
  const jwt=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  // No browser request may leave the disposable host.
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(Object.entries({'sb-access-token':jwt,active_company_id:company,ff_onboarding_done:'1',isaflow_csrf:'disposable-browser-csrf-01234567890123456789'}).map(([name,value])=>({name,value,url:origin})));
  await context.addInitScript(({company})=>localStorage.setItem('isaflow_active_company',JSON.stringify({id:company,name:'WhatsApp browser fixture'})),{company});
  const page=await context.newPage();
  page.on('pageerror',error=>process.stderr.write(`PAGE ERROR: ${error.message}\n`));
  await page.goto(origin+'/accounting/capture/settings',{waitUntil:'domcontentloaded',timeout:120000});
  const input=page.getByRole('textbox',{name:'WhatsApp Business number'});
  await input.waitFor({timeout:120000});
  await input.fill('+27820003001');
  await page.getByRole('button',{name:'Start verification',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Pending verification:'}).waitFor();
  assert.equal((await pool.query("SELECT id FROM capture_inboxes WHERE company_id=$1 AND channel='whatsapp'",[company])).rows.length,0);
  const verificationUrl=await page.locator('code').filter({hasText:'/api/accounting/capture/inbound/whatsapp?token='}).innerText();
  const body={From:'whatsapp:+27821111111',To:'whatsapp:+27820003001',Body:'verification',NumMedia:'0',MessageSid:crypto.randomUUID()};
  const response=await context.request.post(verificationUrl,{form:body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature('disposable-whatsapp-signature-fixture',verificationUrl,body)}});
  assert.equal(response.status(),200);assert.equal((await response.json()).data.companyId,company);
  await page.getByRole('button',{name:'Check verification status'}).click();
  await page.getByText('Verified number:').waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'Pending verification:'}).count(),0);
  await input.fill('+27820003002');
  await page.getByRole('button',{name:'Start verification',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Pending verification:'}).waitFor();
  assert.match(await page.getByText('Verified number:').innerText(),/27820003001/);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByText('The verification URL is shown only when you start.',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Restart verification',exact:true}).click();
  await page.locator('code').filter({hasText:'?token='}).waitFor();
  await page.screenshot({path:'/tmp/isaflow-r003-browser.png',fullPage:true});
  process.stdout.write('PASS actual Capture Settings -> authenticated POST -> pending SQL -> signed HTTP callback -> verified SQL -> Check status -> pending rotation -> reload/restart; no external browser traffic or outbound messages.\n');
}finally{
  await browser.close();
  await pool.query('DELETE FROM capture_events WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM capture_whatsapp_claims WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM capture_inboxes WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM companies WHERE id=$1',[company]);
  await pool.query('DELETE FROM users WHERE id=$1',[user]);
  await pool.end();
}
