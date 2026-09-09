import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {extractHistoricalSageGroups} from '@/modules/accounting/services/controls/historicalImportSageAdapter';
const companyId=randomUUID(),sourceKey='sage-ledger';
const snapshot=()=>({version:1,table:'sage_ledger_transactions',companyId,rows:[
 {id:randomUUID(),sageId:'1',accountCode:'S-AR',accountingDate:'2023-02-28',description:'Actual persisted debit',debit:'90071992547409.91',credit:'0',reference:'INV',migrationStatus:'pending',journalEntryId:null},
 {id:randomUUID(),sageId:'2',accountCode:'S-REV',accountingDate:'2023-02-28',description:'Actual persisted credit',debit:'0',credit:'90071992547409.91',reference:'INV',migrationStatus:'pending',journalEntryId:null}],
 mappings:[{id:randomUUID(),sourceAccountCode:'S-AR',glAccountId:randomUUID(),glAccountCode:'1000'},{id:randomUUID(),sourceAccountCode:'S-REV',glAccountId:randomUUID(),glAccountCode:'4000'}]});
const run=(value:unknown)=>extractHistoricalSageGroups(Buffer.from(JSON.stringify(value)),{sourceKey,companyId});
it('derives exact mapped groups from honest persisted column text and stable source row identities',()=>{
 const value=snapshot(),result=run(value);expect(result.recordCount).toBe(2);expect(result.invalidGroupCount).toBe(0);
 expect(result.groups[0]?.normalized?.amount).toBe('90071992547409.91');expect(result.groups[0]?.sourceRecordIds).toEqual(value.rows.map(row=>row.id).sort());
 expect(result.groups[0]?.normalized?.sourceSystem).toBe('sage');expect(result.groups[0]?.normalized?.records.map(row=>row.accountCode).sort()).toEqual(['1000','4000']);
});
it('keeps an unmapped record inside its invalid complete group rather than importing a subset',()=>{
 const value=snapshot();value.mappings.pop();const result=run(value);expect(result.recordCount).toBe(2);expect(result.invalidGroupCount).toBe(1);expect(result.groups[0]?.sourceRecordIds).toHaveLength(2);expect(result.groups[0]?.error).toContain('unmapped');
});
it('refuses cross-tenant snapshots, duplicate mappings/rows and JSON numeric financial values',()=>{
 const value=snapshot();expect(()=>run({...value,companyId:randomUUID()})).toThrow('tenant');
 expect(()=>run({...value,mappings:[...value.mappings,value.mappings[0]]})).toThrow('mapping');
 expect(()=>run({...value,rows:[value.rows[0],value.rows[0]]})).toThrow('identity');
 expect(()=>run({...value,rows:[{...value.rows[0],debit:90071992547409.91},value.rows[1]]})).toThrow('decimal text');
});
it('refuses an already linked or imported source rather than treating it as a new journal',()=>{
 const value=snapshot();expect(()=>run({...value,rows:[{...value.rows[0],journalEntryId:randomUUID()},value.rows[1]]})).toThrow('already');
 expect(()=>run({...value,rows:[{...value.rows[0],migrationStatus:'imported'},value.rows[1]]})).toThrow('already');
});
it('refuses missing staged financial evidence without inventing tax, commercial lines or balancing entries',()=>{
 const value=snapshot();expect(()=>run({...value,table:'sage_customer_invoices'})).toThrow('Unsupported');
 expect(()=>run({...value,rows:[{...value.rows[0],debit:null},value.rows[1]]})).toThrow('decimal text');
 const unbalanced=run({...value,rows:[value.rows[0],{...value.rows[1],credit:'1'}]});expect(unbalanced.invalidGroupCount).toBe(1);
});

it('refuses a different source key for the same persisted economic group',()=>{
 expect(()=>extractHistoricalSageGroups(Buffer.from(JSON.stringify(snapshot())),{sourceKey:'new-key',companyId})).toThrow('identity');
});
it('distinguishes SQL null and empty reference identities without merging or colliding groups',()=>{
 const value=snapshot(),extra=value.rows.map(row=>({...row,id:randomUUID(),reference:''}));
 const result=run({...value,rows:[...value.rows.map(row=>({...row,reference:null})),...extra]});
 expect(result.groups).toHaveLength(2);expect(new Set(result.groups.map(group=>group.normalized?.sourceKey)).size).toBe(2);
});
