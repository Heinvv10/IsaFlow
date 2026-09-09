import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {chromium,expect,type Page,type BrowserContext} from '@playwright/test';
import {SignJWT} from 'jose';
import {bankBrowserFixture} from '../../tests/integration/controls/bankBrowserFixture';
import {prepareBrowserSupplier} from '../../tests/integration/controls/bankBrowserSupplierFixture';
const supplied=process.env.ISAFLOW_FORENSIC_UI_ORIGIN;
if(!supplied)throw new Error('Explicit local browser origin required');
const target=new URL(supplied);
if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/'||target.search||target.hash)throw new Error('Browser origin must be an explicit loopback HTTP port');
const origin=target.origin,key=process.env.JWT_SECRET;
if(!key||key.length<32)throw new Error('Synthetic browser JWT key required');
const f=await bankBrowserFixture(),browser=await chromium.launch({headless:true}).catch(async error=>{await f.close();throw error;});
const artifacts=`/tmp/isaflow-bank-ui-${f.fixture.runId}`,proof:Array<Record<string,unknown>>=[];
await mkdir(artifacts,{recursive:true});
async function context(person:'u1'|'u2'|'u3'):Promise<BrowserContext>{
 const user=f.fixture[person],token=await new SignJWT({role:'authenticated',aal:'aal2'}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('30m').sign(new TextEncoder().encode(key));
 const result=await browser.newContext({viewport:{width:1500,height:1100}});
 await result.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await result.addCookies(Object.entries({'sb-access-token':token,active_company_id:user.companyId,isaflow_csrf:randomBytes(32).toString('hex'),ff_onboarding_done:'1'}).map(([name,value])=>({name,value,url:origin})));
 await result.addInitScript(({company})=>{localStorage.setItem('isaflow_active_company',JSON.stringify({id:company,name:'Synthetic browser company'}));localStorage.setItem('isaflow-tour-dismissed','true');},{company:user.companyId});
 return result;
}
async function action(page:Page,name:string,actionName:string){
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/accounting/bank-transactions-action')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action===actionName,{timeout:30000}),page.getByRole('button',{name,exact:true}).click()]);
 const body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));return body.data;
}
async function approvalCycle(maker:Page,reviewer:Page,bankId:string,intentId:string,reverse=false,changeSource?:()=>Promise<void>,split=false){
 const saved=`${origin}/accounting/bank-transactions?bankControlBank=${bankId}&bankControlIntent=${intentId}&account_id=${f.bank}`;
 await maker.getByRole('button',{name:'Request approval',exact:true}).click();
 await expect(maker.getByText('Awaiting independent approval',{exact:true})).toBeVisible({timeout:30000});
 const approvalLink=await maker.getByRole('link',{name:'Open approval',exact:true}).getAttribute('href');assert.ok(approvalLink);
 await expect(maker).toHaveURL(new RegExp(`bankControlIntent=${intentId}`));
 await maker.reload({waitUntil:'domcontentloaded'});await expect(maker.getByText('Awaiting independent approval',{exact:true})).toBeVisible({timeout:30000});
 await maker.goto(origin+approvalLink,{waitUntil:'domcontentloaded'});await expect(maker.getByRole('button',{name:'Approve instruction',exact:true})).toBeDisabled({timeout:30000});
 await reviewer.goto(origin+approvalLink,{waitUntil:'domcontentloaded'});await expect(reviewer.getByRole('button',{name:'Approve instruction',exact:true})).toBeEnabled({timeout:30000});
 const [decision]=await Promise.all([reviewer.waitForResponse(r=>r.url().endsWith('/api/accounting/control-approvals')&&r.request().method()==='POST'&&r.request().postDataJSON()?.action==='decide'),reviewer.getByRole('button',{name:'Approve instruction',exact:true}).click()]);
 assert.equal(decision.status(),200,JSON.stringify(await decision.json()));
 await expect(reviewer.getByText('approved',{exact:true})).toBeVisible();
 if(changeSource)await changeSource();
 await maker.goto(saved,{waitUntil:'domcontentloaded'});await expect(maker.getByRole('button',{name:reverse?'Execute approved reversal':'Execute approved allocation',exact:true})).toBeVisible({timeout:30000});
 if(changeSource){
  const [refusal]=await Promise.all([maker.waitForResponse(r=>r.url().endsWith('/api/accounting/bank-transactions-action')&&r.request().postDataJSON()?.action==='allocate'),maker.getByRole('button',{name:'Execute approved allocation',exact:true}).click()]);
  assert.equal(refusal.status(),400);await expect(maker.getByRole('dialog').getByRole('alert')).toContainText(/refused|changed|stale/i);
  assert.equal((await f.pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_allocation_intent' AND entity_id=$2",[f.fixture.companyA,intentId])).rowCount,0);
  proof.push({bankId,intentId,independentDecision:true,staleSourceRefused:true});return null;
 }
 const result=await action(maker,reverse?'Execute approved reversal':'Execute approved allocation',reverse?'reverse':split?'split_allocate':'allocate');
 const approvalId=new URL(origin+approvalLink).searchParams.get('approvalId');
 const row=(await f.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[f.fixture.companyA,approvalId])).rows[0];assert.equal(row.status,'consumed');
 proof.push({bankId,intentId,approvalId,independentDecision:true,refreshResumed:true,result});return result;
}
try{
 const makerContext=await context('u1'),reviewerContext=await context('u2'),foreignContext=await context('u3');
 const maker=await makerContext.newPage(),reviewer=await reviewerContext.newPage(),foreign=await foreignContext.newPage();
 const bankId=await f.source('Browser controlled VAT account','-115.23');
 await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
 const row=maker.getByRole('row').filter({hasText:'Browser controlled VAT account'});await expect(row).toBeVisible({timeout:120000});
 await row.getByTitle('Accept',{exact:true}).click();const prepared=await action(maker,'Prepare allocation','prepare_allocate');
 assert.equal((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.fixture.companyA,bankId])).rowCount,0);
 const posted=await approvalCycle(maker,reviewer,bankId,prepared.intentId);
 assert.ok(posted);
 const lines=(await f.pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,posted.journalEntryId])).rows;
 assert.equal(lines.length,3);assert.equal(Number(lines.find(l=>l.gl_account_id===f.vat)?.debit),15.03);
 await maker.getByRole('button',{name:'New Transactions',exact:true}).click();const reviewed=maker.getByRole('row').filter({hasText:'Browser controlled VAT account'});await expect(reviewed).toBeVisible();await reviewed.getByTitle('Undo allocation',{exact:true}).click();
 await maker.getByLabel('Reversal date').fill('2026-09-10');await maker.getByLabel('Reason for reversal').fill('Synthetic browser correction');
 const inverse=await action(maker,'Prepare reversal','prepare_reverse');await approvalCycle(maker,reviewer,bankId,inverse.intentId,true);
 assert.equal((await f.pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[f.fixture.companyA,bankId])).rows[0].status,'imported');
 for(const [kind,amount]of [['supplier','115.23'],['customer','-115.23']] as const){
  const label=`Browser ${kind} refund`,refundId=await f.source(label,amount,kind);
  await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
  const refundRow=maker.getByRole('row').filter({hasText:label});await expect(refundRow).toBeVisible();await refundRow.getByTitle('Accept',{exact:true}).click();
  const refundPrepared=await action(maker,'Prepare allocation','prepare_allocate'),refund=await approvalCycle(maker,reviewer,refundId,refundPrepared.intentId);assert.ok(refund);assert.equal(refund.paymentId,null);
  const refundLines=(await f.pool.query('SELECT gl_account_id,debit::text,credit::text,vat_type FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,refund.journalEntryId])).rows;
  assert.equal(refundLines.length,2);assert.ok(refundLines.every(line=>line.vat_type===null));
  assert.equal(Number(refundLines.find(line=>line.gl_account_id===f.bank)?.[kind==='supplier'?'debit':'credit']),115.23);
  assert.equal((await f.pool.query('SELECT id FROM customer_payments WHERE company_id=$1 AND gl_journal_entry_id=$2 UNION ALL SELECT id FROM supplier_payments WHERE company_id=$1 AND gl_journal_entry_id=$2',[f.fixture.companyA,refund.journalEntryId])).rowCount,0);
 }
 const splitId=await f.source('Browser exact split','-115.23');
 await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
 const splitRow=maker.getByRole('row').filter({hasText:'Browser exact split'});await expect(splitRow).toBeVisible();await splitRow.getByTitle('Split transaction',{exact:true}).click();
 const splitModal=maker.locator('div.max-w-2xl').filter({has:maker.getByRole('heading',{name:'Split Transaction',exact:true})});
 await splitModal.getByRole('button',{name:'Select GL Account',exact:true}).click();await splitModal.getByRole('button',{name:'4000 Browser office costs',exact:true}).filter({has:maker.locator('span').filter({hasText:/^Browser office costs$/})}).click();
 await splitModal.getByPlaceholder('0.00').fill('100.01');await splitModal.getByRole('button',{name:'Add Line',exact:true}).click();
 await splitModal.getByRole('button',{name:'Select GL Account',exact:true}).click();await splitModal.getByRole('button',{name:'4000 Browser office costs',exact:true}).filter({has:maker.locator('span').filter({hasText:/^Browser office costs$/})}).click();
 await splitModal.getByPlaceholder('0.00').nth(1).fill('15.22');await splitModal.getByRole('button',{name:'Review split',exact:true}).click();
 const splitPrepared=await action(maker,'Prepare allocation','prepare_split_allocate');
 const splitPlan=(await f.pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.fixture.companyA,splitPrepared.intentId])).rows[0].payload;
 assert.equal(splitPlan.kind,'split');assert.deepEqual(splitPlan.lines.map((line:{amount:string})=>line.amount),['100.01','15.22']);
 const splitPosted=await approvalCycle(maker,reviewer,splitId,splitPrepared.intentId,false,undefined,true);assert.ok(splitPosted);
 const splitLines=(await f.pool.query('SELECT gl_account_id,debit::text,credit::text FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,splitPosted.journalEntryId])).rows;
 assert.equal(splitLines.length,3);assert.deepEqual(splitLines.filter(line=>line.gl_account_id===f.expense).map(line=>Number(line.debit)).sort((a,b)=>a-b),[15.22,100.01]);
 const oldest=await f.draftCustomerInvoice('2026-09-01'),recent=await f.draftCustomerInvoice('2026-09-08');
 for(const id of [oldest,recent]){
  const response=await maker.evaluate(async invoiceId=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('isaflow_csrf='))?.split('=')[1]??'';
   const result=await fetch('/api/accounting/customer-invoices-detail',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({id:invoiceId,action:'approve'})});return{status:result.status,body:await result.json()};},id);
  assert.equal(response.status,200,JSON.stringify(response.body));
 }
 const defaultId=await f.source('Browser customer default applications','150.23','customer');
 await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
 const defaultRow=maker.getByRole('row').filter({hasText:'Browser customer default applications'});await expect(defaultRow).toBeVisible();await defaultRow.getByTitle('Accept',{exact:true}).click();
 const defaultPrepared=await action(maker,'Prepare allocation','prepare_allocate');
 const defaultPlan=(await f.pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.fixture.companyA,defaultPrepared.intentId])).rows[0].payload;
 assert.deepEqual(defaultPlan.applications,[{invoiceId:oldest,amount:'100'},{invoiceId:recent,amount:'50.23'}]);
 const defaultPosted=await approvalCycle(maker,reviewer,defaultId,defaultPrepared.intentId);assert.ok(defaultPosted?.paymentId);
 const balances=(await f.pool.query('SELECT id,amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.fixture.companyA,[oldest,recent]])).rows;
 assert.equal(Number(balances.find(row=>row.id===oldest)?.amount_paid),100);assert.equal(Number(balances.find(row=>row.id===recent)?.amount_paid),50.23);
 const beneficiary=await prepareBrowserSupplier(f),supplierOldest=await f.draftSupplierInvoice('2026-09-01'),supplierRecent=await f.draftSupplierInvoice('2026-09-08');
 for(const invoiceId of [supplierOldest,supplierRecent]){
  const response=await maker.evaluate(async id=>{const csrf=document.cookie.split('; ').find(value=>value.startsWith('isaflow_csrf='))?.split('=')[1]??'';
   const result=await fetch('/api/accounting/supplier-invoices-action',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({invoiceId:id,action:'approve'})});return{status:result.status,body:await result.json()};},invoiceId);
  assert.equal(response.status,200,JSON.stringify(response.body));
 }
 const supplierDefaultId=await f.source('Browser supplier default applications','-150.23','supplier');
 await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
 const supplierDefaultRow=maker.getByRole('row').filter({hasText:'Browser supplier default applications'});await expect(supplierDefaultRow).toBeVisible();await supplierDefaultRow.getByTitle('Accept',{exact:true}).click();
 const supplierPrepared=await action(maker,'Prepare allocation','prepare_allocate');
 const supplierPlan=(await f.pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.fixture.companyA,supplierPrepared.intentId])).rows[0].payload;
 assert.deepEqual(supplierPlan.applications,[{invoiceId:supplierOldest,amount:'100'},{invoiceId:supplierRecent,amount:'50.23'}]);
 const supplierPosted=await approvalCycle(maker,reviewer,supplierDefaultId,supplierPrepared.intentId);assert.ok(supplierPosted?.paymentId);
 const supplierBalances=(await f.pool.query('SELECT id,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=ANY($2::uuid[])',[f.fixture.companyA,[supplierOldest,supplierRecent]])).rows;
 assert.equal(Number(supplierBalances.find(row=>row.id===supplierOldest)?.amount_paid),100);assert.equal(Number(supplierBalances.find(row=>row.id===supplierRecent)?.amount_paid),50.23);
 proof.push({prerequisite:'two-person shared beneficiary verification with real local evidence; invoice approvals through cookie REST',...beneficiary});
 const staleBankId=await f.source('Browser stale approved source','-115.23');
 await maker.goto(`${origin}/accounting/bank-transactions?account_id=${f.bank}`,{waitUntil:'domcontentloaded'});
 const staleRow=maker.getByRole('row').filter({hasText:'Browser stale approved source'});await expect(staleRow).toBeVisible();await staleRow.getByTitle('Accept',{exact:true}).click();
 const stalePrepared=await action(maker,'Prepare allocation','prepare_allocate');
 await approvalCycle(maker,reviewer,staleBankId,stalePrepared.intentId,false,async()=>{await f.pool.query("UPDATE bank_transactions SET transaction_date='2026-09-08' WHERE company_id=$1 AND id=$2",[f.fixture.companyA,staleBankId]);});
 const [foreignRefusal]=await Promise.all([foreign.waitForResponse(response=>new URL(response.url()).pathname==='/api/accounting/bank-control-state'),foreign.goto(`${origin}/accounting/bank-transactions?bankControlBank=${bankId}&bankControlIntent=${prepared.intentId}`,{waitUntil:'domcontentloaded'})]);
 assert.equal(foreignRefusal.status(),400);
 await expect(foreign.getByRole('dialog').getByRole('alert')).toContainText('Bank control state unavailable',{timeout:30000});await expect(foreign.getByRole('button',{name:'Execute approved allocation',exact:true})).toHaveCount(0);
 await maker.screenshot({path:`${artifacts}/maker-final.png`,fullPage:true});await reviewer.screenshot({path:`${artifacts}/reviewer-final.png`,fullPage:true});
 await writeFile(`${artifacts}/evidence.json`,JSON.stringify({runId:f.fixture.runId,origin,companyId:f.fixture.companyA,proof,coverage:'actual account VAT request/independent approval/refresh/execute and reversal; both party refund directions; exact split; both party default invoice applications; stale source and foreign-tenant refusal',limitations:'transfer browser cases remain separate; supplier beneficiary prerequisite uses shared service, not browser verification UI'},null,2));
 process.stdout.write(`PASS actual local bank browser account VAT and reversal workflows; evidence ${artifacts}/evidence.json\n`);
}catch(error){
 for(const [index,context]of browser.contexts().entries())for(const page of context.pages())await page.screenshot({path:`${artifacts}/failure-context-${index}.png`,fullPage:true}).catch(()=>process.stderr.write('Could not capture browser failure screenshot.\n'));
 await writeFile(`${artifacts}/failure.json`,JSON.stringify({runId:f.fixture.runId,origin,proof,error:error instanceof Error?error.message:'Browser acceptance failed'},null,2));
 throw error;
}finally{await browser.close();await f.close();}
