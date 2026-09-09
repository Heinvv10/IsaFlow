import {expect,it} from 'vitest';
import {parseInvoiceMatchOverride} from '@/modules/accounting/services/ap/invoiceMatchOverridePreparation';
const invoice='11111111-1111-4111-8111-111111111111',document='22222222-2222-4222-8222-222222222222';
const input={invoiceId:invoice,expectedMatchFingerprint:'a'.repeat(64),reason:'Approved contractual price exception',
 evidenceRefs:[{store:'captured',evidenceId:document,entityType:'supplier_invoice',entityId:invoice,version:null,hash:'b'.repeat(64)}]};
it('accepts only bounded same-invoice evidence and an explicit expected material fingerprint',()=>{expect(parseInvoiceMatchOverride(input)).toEqual(input);});
it.each([{...input,evidenceRefs:[]},{...input,evidenceRefs:[...input.evidenceRefs,...input.evidenceRefs]},
 {...input,reason:' '},{...input,expectedMatchFingerprint:'caller said verified'},
 {...input,evidenceRefs:[{...input.evidenceRefs[0]!,entityId:document}]},
 {...input,approver_id:document},{...input,verified:true}])('refuses untrusted or missing override material',value=>{
 expect(()=>parseInvoiceMatchOverride(value)).toThrow();
});
