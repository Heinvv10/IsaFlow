// Real opening-balance browser/API/PostgreSQL acceptance on the guarded disposable host.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
const origin='http://127.0.0.1:33200';
const db=new URL(process.env.DATABASE_URL??'http://missing.invalid');
if(process.env.ISAFLOW_DISPOSABLE_AUTH_TEST!=='1'||db.hostname!=='127.0.0.1'||db.port!=='33140'||db.pathname!=='/isaflow_schema_fixture')throw new Error('Explicit disposable fixture required');
const pool=new Pool({connectionString:db.toString()});
const company=crypto.randomUUID(),user=crypto.randomUUID();
const debit=crypto.randomUUID(),credit=crypto.randomUUID(),period=crypto.randomUUID();
const browser=await chromium.launch({headless:true});
try{
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)',[company,'Opening browser fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'viewer',true)",[user,`${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')",[company,user]);
  await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Browser period',1,2026,'2026-01-01','2026-12-31','open')",[period,company]);
  await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active) VALUES($1,$3,'1100','Browser asset','asset','debit',3,true),($2,$3,'3300','Browser equity','equity','credit',3,true)",[debit,credit,company]);
  const jwt=await new SignJWT({sub:user,aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  // No browser request may leave the disposable host.
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addCookies(Object.entries({'sb-access-token':jwt,active_company_id:company,ff_onboarding_done:'1',isaflow_csrf:'disposable-browser-csrf-01234567890123456789'}).map(([name,value])=>({name,value,url:origin})));
  await context.addInitScript(({company})=>localStorage.setItem('isaflow_active_company',JSON.stringify({id:company,name:'Opening browser fixture'})),{company});
  const page=await context.newPage();
  page.on('pageerror',error=>process.stderr.write(`PAGE ERROR: ${error.message}\n`));
  await page.goto(origin+'/accounting/opening-balances',{waitUntil:'domcontentloaded',timeout:120000});
  const asset=page.getByRole('row').filter({hasText:'Browser asset'});
  await asset.waitFor({timeout:120000});
  await asset.getByRole('spinbutton').nth(0).fill('123.45');
  await page.getByRole('row').filter({hasText:'Browser equity'}).getByRole('spinbutton').nth(1).fill('123.45');
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/accounting/opening-balances')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Save Opening Balances',exact:true}).click();
  assert.equal((await saved).status(),200);
  await page.getByText('Opening balances saved as journal entry',{exact:true}).waitFor();
  const entries=(await pool.query('SELECT id,status,fiscal_period_id,source,reference FROM gl_journal_entries WHERE company_id=$1',[company])).rows;
  assert.equal(entries.length,1);assert.equal(entries[0].status,'posted');assert.equal(entries[0].fiscal_period_id,period);assert.equal(entries[0].source,'manual');
  const lines=(await pool.query('SELECT sum(debit)::text AS debit,sum(credit)::text AS credit FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[company,entries[0].id])).rows[0];
  assert.deepEqual(lines,{debit:'123.45',credit:'123.45'});
  const cached=(await pool.query('SELECT balance::text FROM gl_account_balances WHERE fiscal_period_id=$1 ORDER BY balance DESC',[period])).rows;
  assert.deepEqual(cached,[{balance:'123.45'},{balance:'-123.45'}]);
  await page.screenshot({path:'/tmp/isaflow-k006-browser.png',fullPage:true});
  process.stdout.write('PASS actual Opening Balances page -> authenticated POST -> posted native journal -> exact123.45 debit/credit lines -> reconciled account cache; all browser traffic restricted to disposable host.\n');
}finally{
  await browser.close();
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM gl_account_balances WHERE fiscal_period_id=$1',[period]);
  await pool.query('DELETE FROM gl_accounts WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM company_users WHERE company_id=$1',[company]);
  await pool.query('DELETE FROM companies WHERE id=$1',[company]);
  await pool.query('DELETE FROM users WHERE id=$1',[user]);
  await pool.end();
}
