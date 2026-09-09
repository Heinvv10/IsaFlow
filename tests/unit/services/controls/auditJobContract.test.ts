import {expect,it} from 'vitest';
import {parseAuditSnapshotRequest,auditSnapshotPermissions} from '@/modules/accounting/services/controls/auditJobContract';
const input={cutoff:'2026-09-09',sources:['journals','ap'],checks:['duplicate_invoice_checks'],idempotencyKey:'synthetic-snapshot-1'};
it('canonicalizes set inputs without changing accounting cutoff or retry identity',()=>{
 expect(parseAuditSnapshotRequest({...input,sources:['ap','journals','ap']})).toEqual({...input,sources:['ap','journals']});
});
it('refuses forged authority, invalid dates, unknown checks and absent source families',()=>{
 for(const changed of [{personId:'forged'},{role:'admin'},{cutoff:'2026-02-30'},{checks:['unregistered_check']},{sources:['journals']},{idempotencyKey:''}])
  expect(()=>parseAuditSnapshotRequest({...input,...changed})).toThrow();
});
it('requires all current requested domain reads and never posting authority',()=>{
 const request=parseAuditSnapshotRequest({...input,sources:['journals','ap','ar','bank','payroll'],checks:[]});
 expect(auditSnapshotPermissions(request)).toEqual(['read:bank-tx','read:invoices','read:payroll','read:reports']);
 expect(auditSnapshotPermissions(parseAuditSnapshotRequest({...input,sources:['journals'],checks:[]}))).toEqual(['read:reports']);
});
it('bounds caller-controlled lists and identifiers before work or storage',()=>{
 expect(()=>parseAuditSnapshotRequest({...input,sources:Array(101).fill('journals')})).toThrow();
 expect(()=>parseAuditSnapshotRequest({...input,idempotencyKey:'x'.repeat(129)})).toThrow();
});
