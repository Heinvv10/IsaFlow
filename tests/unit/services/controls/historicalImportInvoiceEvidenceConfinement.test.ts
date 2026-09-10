import {beforeEach,expect,it,vi} from 'vitest';
const boundary=vi.hoisted(()=>({assert:vi.fn(),permission:vi.fn(),decode:vi.fn(),open:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:boundary.assert}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:boundary.permission}));
vi.mock('@/modules/accounting/services/controls/historicalImportSourceService',()=>({decodeHistoricalImportSource:boundary.decode,historicalHash:()=>'h'}));
vi.mock('@/modules/accounting/services/controls/changeProtection',()=>({openProtectedChange:boundary.open}));
import {historicalImportInvoiceEvidence} from '@/modules/accounting/services/controls/historicalImportInvoiceEvidence';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const companyId='11111111-1111-4111-8111-111111111111',invoiceId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333';
const importId='44444444-4444-4444-8444-444444444444',journalEntryId='55555555-5555-4555-8555-555555555555',date='2023-01-31';
const doc={partyId:'party',invoiceNumber:'INV-1',dueDate:'2023-02-28',subtotal:'100',taxAmount:'15',totalAmount:'115'};
const source={kind:'customer_invoice',document:doc,sourceSystem:'sage',sourceKey:'k1',mode:'link_existing',accountingDate:date,currency:'ZAR',amount:'115',existingJournalId:journalEntryId};
const hashes={contentHash:'c'.repeat(64),normalizedHash:'n'.repeat(64)};
const body={companyId,importId,sourceId,requesterPersonId:'maker',requesterAuthMethod:'cookie',requesterGrantId:null,requesterGrantedScopes:null,...hashes,
 normalized:source,resolvedPlan:[{glAccountId:'acct',debit:'115',credit:'0',vatType:null}]};
const intent={id:importId,kind:'customer_invoice',requester_person_id:'maker',requester_auth_method:'cookie',requester_grant_id:null,requester_granted_scopes:null,
 payload_hash:'h',source_system:'sage',source_key:'k1',mode:'link_existing',accounting_date:date,currency:'ZAR',amount:'115',payload_envelope:{}};
const result={importId,documentId:invoiceId,kind:'customer_invoice',mode:'link_existing',amount:'115',currency:'ZAR',accountingDate:date,journalEntryId};
const invoice={id:invoiceId,party_id:'party',invoice_number:'INV-1',invoice_date:date,due_date:'2023-02-28',subtotal:'100.00',tax_amount:'15.00',
 total_amount:'115.00',currency_code:'ZAR',exchange_rate:'1.000000',gl_journal_entry_id:journalEntryId};
const sql=vi.fn();
const ctxFor=(authMethod:string)=>({sql,principal:{companyId,personId:'maker',authMethod}}) as unknown as ControlTx;
beforeEach(()=>{
 vi.resetAllMocks();
 boundary.decode.mockReturnValue({normalized:source,sourceId,...hashes});boundary.open.mockReturnValue({after:body});
 sql.mockResolvedValueOnce([{result,intent,source:{}}]).mockResolvedValueOnce([invoice])
  .mockResolvedValueOnce([{id:journalEntryId,status:'posted',entry_date:date}])
  .mockResolvedValueOnce([{gl_account_id:'acct',debit:'115.00',credit:'0.00',vat_type:null}]);
});
it('refuses platform import authority before reading any historical invoice summary',async()=>{
 await expect(historicalImportInvoiceEvidence(ctxFor('platform_import'),'customer_invoice',invoiceId)).rejects.toThrow('Platform import authority');
 expect(sql).not.toHaveBeenCalled();
});
it('still returns the verified archival summary to an ordinary member',async()=>{
 expect(await historicalImportInvoiceEvidence(ctxFor('cookie'),'customer_invoice',invoiceId))
  .toEqual({subtotal:'100',taxAmount:'15',totalAmount:'115',currency:'ZAR',accountingDate:date,importId,sourceId,journalEntryId});
 expect(sql).toHaveBeenCalledTimes(4);
});
