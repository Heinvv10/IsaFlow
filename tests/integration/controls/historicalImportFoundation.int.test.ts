import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeHistoricalImportSource,readHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {materializeHistoricalImportOperation} from '@/modules/accounting/services/controls/historicalImportMaterializer';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
let fixture:ForensicFixture,sourceId:string,importId:string;
const account=randomUUID();
const source=()=>({version:1,sourceSystem:'csv',sourceKey:'H2-SYNTHETIC',kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records:[
 {recordId:'1',accountCode:'H2-1000',debit:'100.01',credit:'0',description:'Synthetic debit'},
 {recordId:'2',accountCode:'H2-4000',debit:'0',credit:'100.01',description:'Synthetic credit'}]});
const prepare=(id=sourceId)=>({sourceSystem:'csv' as const,sourceKey:'H2-SYNTHETIC',kind:'gl' as const,mode:'post_journal' as const,accountingDate:'2023-02-28',evidenceId:id,sourceRecordIds:['1','2']});
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>){const client=await pool.connect(),user=fixture[person];try{
 await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
 await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
 const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
 if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
beforeAll(async()=>{fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level)
 VALUES($1,$2,'H2-1000','Synthetic H2 asset','asset','debit',true,3),($3,$2,'H2-4000','Synthetic H2 revenue','revenue','credit',true,3)`,[account,fixture.companyA,randomUUID()]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic H2 closed period',2,2023,'2023-02-01','2023-02-28','closed')",[fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
it('persists actual encrypted evidence, prepares one exact immutable group and creates no financial effects',async()=>{
 const bytes=Buffer.from(JSON.stringify(source()));
 const stored=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}));sourceId=stored.sourceId;
 expect((await actor('u2',ctx=>readHistoricalImportSource(ctx,sourceId))).bytes.equals(bytes)).toBe(true);
 const prepared=await actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()));importId=prepared.importId;
 expect(prepared).toMatchObject({amount:'100.01',currency:'ZAR',requiresApproval:true});
 expect((await actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).importId).toBe(importId);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('refuses foreign evidence, missing artifacts, changed dates and partial source record selections',async()=>{
 await expect(actor('u3',ctx=>readHistoricalImportSource(ctx,sourceId))).rejects.toThrow('unavailable');
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare(randomUUID())))).rejects.toThrow('unavailable');
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...prepare(),accountingDate:'2023-03-01'}))).rejects.toThrow();
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...prepare(),sourceRecordIds:['1']}))).rejects.toThrow();
});
it('fingerprints current material changes and refuses missing currency and inactive owned accounts',async()=>{
 const read=()=>actor('u2',ctx=>materializeHistoricalImportOperation(ctx,{entityType:'historical_import',entityId:importId,operation:'historical_import.post'}));
 const before=canonicalJson((await read()).binding);
 await pool.query("UPDATE gl_accounts SET account_name='Changed synthetic classification evidence' WHERE company_id=$1 AND id=$2",[fixture.companyA,account]);
 expect(canonicalJson((await read()).binding)).not.toBe(before);
 try{await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);await expect(read()).rejects.toThrow('account');}
 finally{await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);}
 try{await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA]);await expect(read()).rejects.toThrow('currency');}
 finally{await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);}
});
it('refuses revoked import authority and tampered source bytes metadata',async()=>{
 try{await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).rejects.toThrow();}
 finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);}
 const old=(await pool.query('SELECT content_hash FROM control_historical_import_sources WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId])).rows[0].content_hash;
 try{await pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId,'a'.repeat(64)]);await expect(actor('u2',ctx=>readHistoricalImportSource(ctx,sourceId))).rejects.toThrow('unavailable or changed');}
 finally{await pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId,old]);}
});
it('keeps persisted source and preparation immutable to the application role',async()=>{
 await expect(actor('u1',ctx=>ctx.sql`UPDATE control_historical_import_sources SET content_hash=${'b'.repeat(64)} WHERE company_id=${fixture.companyA}::uuid AND id=${sourceId}::uuid`)).rejects.toThrow('permission denied');
 await expect(actor('u1',ctx=>ctx.sql`DELETE FROM control_historical_imports WHERE company_id=${fixture.companyA}::uuid AND id=${importId}::uuid`)).rejects.toThrow('permission denied');
});
it('refuses locked periods and company lockdown before preparing any source effect',async()=>{
 try{await pool.query("UPDATE fiscal_periods SET status='locked' WHERE company_id=$1",[fixture.companyA]);await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).rejects.toThrow('period');}
 finally{await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1",[fixture.companyA]);}
 try{await pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2023-02-28' WHERE id=$1",[fixture.companyA]);await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).rejects.toThrow('lockdown');}
 finally{await pool.query('UPDATE companies SET lockdown_enabled=false WHERE id=$1',[fixture.companyA]);}
});
it('refuses changed source bytes under an existing immutable group identity',async()=>{
 const changed=source();changed.records[0]!.description='Changed evidence';
 const staged=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(changed)),mimeType:'application/json'}));
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare(staged.sourceId)))).rejects.toThrow('different evidence');
});
it.each([true,false])('binds exact existing invoice and allocated settlement; rejects unrelated or reversed journals (AR=%s)',async ar=>{
 const company=fixture.companyA,user=fixture.u1.id,party=randomUUID(),control=randomUUID(),base=randomUUID(),bank=randomUUID(),journal=randomUUID(),paymentJournal=randomUUID(),invoice=randomUUID(),payment=randomUUID();
 const number=ar?'H2-AR':'H2-AP';
 await pool.query(ar?"INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic import customer')":"INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic import supplier')",[party,company]);
 for(const [id,code,type,subtype] of [[control,number+'-C',ar?'asset':'liability',ar?'receivable':'payable'],[base,number+'-B',ar?'revenue':'expense',null],[bank,number+'-BANK','asset','bank']])
  await pool.query('INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level) VALUES($1,$2,$3,$3,$4,$5,$6,true,3)',[id,company,code,type,subtype,['liability','revenue'].includes(String(type))?'credit':'debit']);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic import bank',$2,'ZAR')",[company,bank]);
 // Trusted fixture seeds an already posted historical invoice/payment, not an application write path.
 for(const [id,label] of [[journal,number],[paymentJournal,number+'-PAY']])await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by) VALUES($1,$2,$3,'2023-02-28','posted','auto_migration',$4)",[id,company,label,user]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$5,$6),($1,$2,$4,$6,$5)',[company,journal,control,base,ar?100:0,ar?0:100]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$5,$6),($1,$2,$4,$6,$5)',[company,paymentJournal,control,bank,ar?0:100,ar?100:0]);
 if(ar){
  await pool.query("INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,created_by,gl_journal_entry_id) VALUES($1,$2,$3,$3,$4,'2023-02-28',100,0,100,'ZAR',$5,$6)",[invoice,company,party,number,user,journal]);
  await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,status,bank_account_id,gl_journal_entry_id,created_by) VALUES($1,$2,$3,'2023-02-28',100,'confirmed',$4,$5,$6)",[payment,company,party,bank,paymentJournal,user]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[payment,invoice]);
 }else{
  await pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency,created_by,gl_journal_entry_id) VALUES($1,$2,$3,$4,'2023-02-28',100,0,100,'ZAR',$5,$6)",[invoice,company,party,number,user,journal]);
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,bank_account_id,gl_journal_entry_id,created_by) VALUES($1,$2,$3,'2023-02-28',100,'processed',$4,$5,$6)",[payment,company,party,bank,paymentJournal,user]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,100)',[payment,invoice]);
 }
 const body={...source(),sourceKey:number,kind:ar?'customer_invoice' as const:'supplier_invoice' as const,mode:'attach_subledger' as const,existingJournalId:journal,
  records:[{recordId:'1',accountCode:number+'-C',debit:ar?'100':'0',credit:ar?'0':'100',description:'Control'},
   {recordId:'2',accountCode:number+'-B',debit:ar?'0':'100',credit:ar?'100':'0',description:'Base'}],
  document:{partyId:party,invoiceNumber:number,dueDate:'2023-03-01',subtotal:'100',taxAmount:'0',totalAmount:'100',amountPaid:'100',settlements:[{journalId:paymentJournal,amount:'100'}]}};
 const stage=()=>actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes:Buffer.from(JSON.stringify(body)),mimeType:'application/json'}));
 const staged=await stage();
 const input={...prepare(staged.sourceId),sourceKey:number,kind:body.kind,mode:body.mode};
 const prepared=await actor('u1',ctx=>prepareHistoricalImport(ctx,input));expect(prepared.amount).toBe('100');
 const read=()=>actor('u2',ctx=>materializeHistoricalImportOperation(ctx,{entityType:'historical_import',entityId:prepared.importId,operation:'historical_import.post'}));
 expect(canonicalJson((await read()).observedSources[0]!.facts)).toContain(paymentJournal);
 try{await pool.query('UPDATE gl_journal_entries SET reversed_at=NOW() WHERE company_id=$1 AND id=$2',[company,paymentJournal]);await expect(read()).rejects.toThrow('Historical settlement');}
 finally{await pool.query('UPDATE gl_journal_entries SET reversed_at=NULL WHERE company_id=$1 AND id=$2',[company,paymentJournal]);}
 const beforeHeader=canonicalJson((await read()).binding);
 try{await pool.query(ar?'UPDATE customer_invoices SET amount_paid=99 WHERE company_id=$1 AND id=$2':'UPDATE supplier_invoices SET amount_paid=99 WHERE company_id=$1 AND id=$2',[company,invoice]);
  expect(canonicalJson((await read()).binding)).not.toBe(beforeHeader);}
 finally{await pool.query(ar?'UPDATE customer_invoices SET amount_paid=0 WHERE company_id=$1 AND id=$2':'UPDATE supplier_invoices SET amount_paid=0 WHERE company_id=$1 AND id=$2',[company,invoice]);}
 try{await pool.query(ar?'UPDATE customer_invoices SET gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2':'UPDATE supplier_invoices SET gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2',[company,invoice,paymentJournal]);
  await expect(read()).rejects.toThrow('prior journal');}
 finally{await pool.query(ar?'UPDATE customer_invoices SET gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2':'UPDATE supplier_invoices SET gl_journal_entry_id=$3 WHERE company_id=$1 AND id=$2',[company,invoice,journal]);}
 const extraJournal=randomUUID(),extraPayment=randomUUID();
 await pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by) VALUES($1,$2,$3,'2023-02-28','posted','auto_migration',$4)",[extraJournal,company,number+'-EXTRA',user]);
 await pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) VALUES($1,$2,$3,$5,$6),($1,$2,$4,$6,$5)',[company,extraJournal,control,bank,ar?0:25,ar?25:0]);
 if(ar){
  await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,status,bank_account_id,gl_journal_entry_id,created_by) VALUES($1,$2,$3,'2023-02-28',25,'confirmed',$4,$5,$6)",[extraPayment,company,party,bank,extraJournal,user]);
  await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,25)',[extraPayment,invoice]);
 }else{
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,status,bank_account_id,gl_journal_entry_id,created_by) VALUES($1,$2,$3,'2023-02-28',25,'processed',$4,$5,$6)",[extraPayment,company,party,bank,extraJournal,user]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,25)',[extraPayment,invoice]);
 }
 try{await expect(read()).rejects.toThrow('population');}
 finally{await pool.query(ar?'DELETE FROM customer_payments WHERE company_id=$1 AND id=$2':'DELETE FROM supplier_payments WHERE company_id=$1 AND id=$2',[company,extraPayment]);}
 const originalSettlements=body.document.settlements;body.document.amountPaid='0';body.document.settlements=[];
 const omitted=await stage();await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...input,evidenceId:omitted.sourceId}))).rejects.toThrow('population');
 body.document.amountPaid='100';body.document.settlements=originalSettlements;
 body.document.invoiceNumber=number+'-UNRELATED';const unrelated=await stage();
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...input,evidenceId:unrelated.sourceId}))).rejects.toThrow('allocation');
 try{await pool.query('UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1 AND journal_entry_id=$2',[company,journal]);await expect(read()).rejects.toThrow('lines differ');}
 finally{await pool.query('UPDATE gl_journal_lines SET debit=debit/2,credit=credit/2 WHERE company_id=$1 AND journal_entry_id=$2',[company,journal]);}
});
it('refuses actual filed VAT population during preparation without exempting historical dates',async()=>{
 const lock=randomUUID();
 await pool.query("UPDATE gl_accounts SET account_subtype='vat_input' WHERE company_id=$1 AND id=$2",[fixture.companyA,account]);
 try{
  await pool.query("INSERT INTO vat_period_locks(id,company_id,period_start,period_end,output_tax,input_tax,net_vat,posted_through,locked_by,actor_type) VALUES($1,$2,'2023-02-01','2023-02-28',0,100.01,-100.01,NOW(),$3,'human')",[lock,fixture.companyA,fixture.u1.id]);
  await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).rejects.toThrow('filed VAT');
 }finally{
  await pool.query('DELETE FROM vat_period_locks WHERE company_id=$1 AND id=$2',[fixture.companyA,lock]);
  await pool.query('UPDATE gl_accounts SET account_subtype=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);
 }
});

it.each([['gl','reports'],['customer_invoice','customers'],['supplier_invoice','suppliers']])('requires current domain reads as well as imports reads for %s',async(kind,module)=>{
 const [intent]=(await pool.query('SELECT id,source_id FROM control_historical_imports WHERE company_id=$1 AND kind=$2 ORDER BY created_at LIMIT 1',[fixture.companyA,kind])).rows;
 expect(intent).toBeDefined();
 try{
  await pool.query('INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,$3,false)',[fixture.companyA,fixture.u2.id,module]);
  await expect(actor('u2',ctx=>assertEffectivePermission(ctx,'read:imports'))).resolves.toBeUndefined();
  await expect(actor('u2',ctx=>readHistoricalImportSource(ctx,intent.source_id))).rejects.toThrow('Current permissions');
  await expect(actor('u2',ctx=>materializeHistoricalImportOperation(ctx,{entityType:'historical_import',entityId:intent.id,operation:'historical_import.post'}))).rejects.toThrow('Current permissions');
 }finally{await pool.query('DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key=$3',[fixture.companyA,fixture.u2.id,module]);}
});
