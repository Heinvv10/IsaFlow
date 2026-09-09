import {afterEach,expect,it,vi} from 'vitest';
import {sealAuditSnapshot,verifyAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {deriveIndexPermissions,indexHeader} from '@/modules/accounting/services/controls/auditSnapshotIndexValidation';
import {AUDIT_CHECK_IDS} from '@/modules/accounting/services/controls/auditJobContract';
afterEach(()=>vi.unstubAllEnvs());
it('indexes the aggregate of a legal retained snapshot with600000findings plus records/checks',()=>{
 vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-index-boundary-key-0000000000000001');
 const identity={companyId:'00000000-0000-4000-8000-000000000001',snapshotId:'00000000-0000-4000-8000-000000000002'};
 const data={version:1 as const,...identity,cutoff:'2026-09-09',capturedAt:'2026-09-10T01:00:00.000Z',
  records:[{source:'journal_entry',id:'one',version:1,data:{}}],
  populations:['journal_entry','journal_line','customer_invoice','customer_invoice_line','customer_payment','customer_payment_allocation',
   'sage_supplier_invoice','supplier_invoice','supplier_invoice_line','supplier_payment','supplier_payment_allocation',
   'bank_transaction','bank_statement_import','bank_statement_attestation_intent','payroll_run','payroll_run_line']
   .map(source=>({source,count:source==='journal_entry'?1:0,excludedCount:0,exclusions:[]})),
  checks:AUDIT_CHECK_IDS.map(checkId=>({checkId,checkVersion:1,status:'fail' as const,populationCount:100000,excludedCount:0,findingCount:100000,
   amountTotals:{},findings:Array.from({length:100000},()=>({})),nextCursor:null,coverage:[],missingSources:[],
   capturedAt:'2026-09-10T01:00:00.000Z',cutoff:'2026-09-09',sourceVersions:[]})),evidence:[],coverage:[],missingSources:[]};
 const sealed=sealAuditSnapshot(data);expect(Buffer.byteLength(sealed.canonicalData)).toBeLessThan(3*1024*1024);
 const snapshot=verifyAuditSnapshot(sealed,identity);
 const permissions=deriveIndexPermissions(snapshot,['read:reports','read:invoices','read:bank-tx','read:payroll']);
 const counts={records:snapshot.records.length,checks:snapshot.checks.length,findings:snapshot.checks.reduce((sum,row)=>sum+row.findings.length,0),evidence:0,gaps:0};
 expect(Object.values(counts).reduce((sum,n)=>sum+n,0)).toBe(600007);
 expect(indexHeader.safeParse({...identity,canonicalHash:sealed.canonicalHash,version:1,permissions,counts}).success).toBe(true);
},30000);
