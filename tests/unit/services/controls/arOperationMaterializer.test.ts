import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
const mock=vi.hoisted(()=>({invoice:vi.fn(),payment:vi.fn(),accounts:vi.fn(),version:vi.fn(),journal:vi.fn(),sql:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/arSourceMaterial',()=>({lockArInvoiceSources:mock.invoice,lockArPaymentSources:mock.payment}));
vi.mock('@/modules/accounting/services/controls/arControlAccounts',()=>({resolveArAccounts:mock.accounts}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:mock.version}));
vi.mock('@/modules/accounting/services/controls/glOperationMaterializer',()=>({materializeGlOperation:mock.journal}));
import {materializeArOperation} from '@/modules/accounting/services/controls/arOperationMaterializer';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
const id=randomUUID(),company=randomUUID(),period=randomUUID(),journalId=randomUUID();
const ctx={principal:{companyId:company},sql:mock.sql} as unknown as ControlTx;
const ref={entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'} as unknown as OperationRef;
beforeEach(()=>{vi.clearAllMocks();mock.version.mockResolvedValue(null);mock.invoice.mockResolvedValue({header:{id,status:'draft',invoice_date:'2026-08-31',subtotal:'100',tax_amount:'15',total_amount:'115',currency_code:'ZAR',exchange_rate:'1',functional_total:'115'},lines:[{amount:'100',quantity:'1',unit_price:'100'}]});mock.accounts.mockResolvedValue({ledgerCurrency:'ZAR',facts:{ledger:{id:company,default_currency:'ZAR'}}});mock.sql.mockResolvedValue([{id:period,status:'open'}]);});
it('observes authoritative material without recording historical events',async()=>{const result=await materializeArOperation(ctx,ref);expect(result.binding).toMatchObject({amount:'115',currency:'ZAR',accountingDate:'2026-08-31',entityVersion:1});expect(result.versionBasis).toBe('untracked_current_observation');for(const call of mock.sql.mock.calls)expect(String(call[0])).not.toMatch(/INSERT|UPDATE/);});
it('binds line material even when the invoice total does not change',async()=>{const first=await materializeArOperation(ctx,ref);const data=await mock.invoice();data.lines[0].quantity='2';data.lines[0].unit_price='50';const second=await materializeArOperation(ctx,ref);expect(second.binding.amount).toBe(first.binding.amount);expect(second.binding.sourceVersions[0]!.fingerprint).not.toBe(first.binding.sourceVersions[0]!.fingerprint);});
it('rejects stale explicit version and absent target periods',async()=>{mock.version.mockResolvedValue({version:3});await expect(materializeArOperation(ctx,{...ref,expectedVersion:1})).rejects.toThrow('version');mock.sql.mockResolvedValue([]);await expect(materializeArOperation(ctx,ref)).rejects.toThrow('period');});
it('binds the actual reversal target date and journal source facts',async()=>{const data=await mock.invoice();data.header.gl_journal_entry_id=journalId;mock.journal.mockResolvedValue({binding:{accountingDate:'2026-09-09'},observedSources:[{entityType:'journal_entry',entityId:journalId,version:1,tracked:true,fingerprint:'a'.repeat(64),facts:{header:{id:journalId}}}]});const result=await materializeArOperation(ctx,{...ref,operation:'customer_invoice.cancel'} as unknown as OperationRef);expect(result.binding.accountingDate).toBe('2026-09-09');expect(result.binding.sourceVersions.some(s=>s.entityId===journalId)).toBe(true);});
it('rejects prepared recurring invoices whose lines no longer match their template',async()=>{
 const templateId=randomUUID(),runId=randomUUID(),clientId=randomUUID();
 const data=await mock.invoice();Object.assign(data.header,{owned_customer_id:clientId});data.lines[0].description='Old service';
 const template={id:templateId,client_id:clientId,currency_code:'ZAR',tax_rate:'15',line_items:[{description:'New service',quantity:1,unitPrice:100}]};
 mock.sql.mockImplementation(async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');
  if(query.includes('FROM control_recurring_invoice_runs'))return[{id:runId,template_id:templateId,invoice_id:id}];
  if(query.includes('FROM recurring_invoices'))return[template];
  return[{id:period,status:'open'}];
 });
 await expect(materializeArOperation(ctx,{entityType:'recurring_invoice_run',entityId:runId,operation:'recurring_invoice.generate'})).rejects.toThrow('match');
});
it('rejects incompatible entity/operation pairs before reading an intent',async()=>{
 await expect(materializeArOperation(ctx,{entityType:'credit_note_application',entityId:id,operation:'customer_invoice.post'} as OperationRef)).rejects.toThrow('Unsupported');
 expect(mock.sql).not.toHaveBeenCalled();
});
