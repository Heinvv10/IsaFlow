import {capturedStorage} from './capturedEvidenceTestStorage';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ForensicFixture} from '../forensic-fixture';
import type {ControlTx,EvidenceRef} from '@/modules/accounting/services/controls/contracts';
import {proposeBeneficiaryChange,verifyBeneficiaryChange} from '@/modules/accounting/services/controls/beneficiaryService';
export type ReleaseActor=<T>(person:'u1'|'u2',action:(ctx:ControlTx)=>Promise<T>)=>Promise<T>;
/** Synthetic source bytes and real independent beneficiary activation, never a preverified database stub. */
export async function seedReleaseSupplier(pool:Pool,fixture:ForensicFixture,actor:ReleaseActor){
 const supplier=randomUUID(),invoice=randomUUID(),document=randomUUID();
 const bytes=Buffer.from(`Synthetic release bank confirmation ${document}`),hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query(`INSERT INTO suppliers(id,company_id,name,bank_name,bank_account_number,bank_branch_code,bank_account_type)
  VALUES($1,$2,'Synthetic beneficiary','Synthetic bank','00123456789','001234','cheque')`,[supplier,fixture.companyA]);
 await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by)
  VALUES($1,$2,$3,$4,'2026-09-09',$5)`,[invoice,fixture.companyA,supplier,`SYN-${invoice}`,fixture.u1.id]);
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic.pdf','pdf','matched',$3)`,[document,fixture.companyA,invoice]);
 await capturedStorage().seed(pool,fixture.companyA,document,bytes);
 const ref={entityType:'supplier' as const,entityId:supplier};
 const evidence:EvidenceRef[]=[{store:'captured',evidenceId:document,entityType:'supplier_invoice',entityId:invoice,version:null,hash}];
 const bank={bankName:'Synthetic bank',accountNumber:'00987654321',branchCode:'001234',accountType:'cheque'};
 const proposed=await actor('u1',ctx=>proposeBeneficiaryChange(ctx,ref,bank,evidence));
 await actor('u2',ctx=>verifyBeneficiaryChange(ctx,proposed.proposalId,evidence));
 return{supplier,ref,evidence,bank};
}
