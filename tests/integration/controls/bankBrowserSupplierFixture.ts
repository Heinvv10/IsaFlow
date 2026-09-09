import {randomUUID} from 'node:crypto';
import type {bankBrowserFixture} from './bankBrowserFixture';
import {bankBrowserEvidenceFixture} from './bankBrowserEvidenceFixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {proposeBeneficiaryChange,verifyBeneficiaryChange} from '@/modules/accounting/services/controls/beneficiaryService';
/** Prerequisite only: genuine shared two-person beneficiary verification over local evidence bytes. */
export async function prepareBrowserSupplier(f:Awaited<ReturnType<typeof bankBrowserFixture>>){
 const storage=await bankBrowserEvidenceFixture(),document=randomUUID(),evidenceInvoice=randomUUID();
 try{
  await f.pool.query("INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,created_by) VALUES($1,$2,$3,$1::uuid::text,'2026-09-09',$4)",[evidenceInvoice,f.fixture.companyA,f.supplier,f.fixture.u1.id]);
  await f.pool.query("INSERT INTO captured_documents(id,company_id,file_name,file_type,status,matched_invoice_id) VALUES($1,$2,'synthetic-browser.pdf','pdf','matched',$3)",[document,f.fixture.companyA,evidenceInvoice]);
  const hash=await storage.seed(f.pool,f.fixture.companyA,document,Buffer.from(`Synthetic browser beneficiary ${document}`));
  const evidence=[{store:'captured' as const,evidenceId:document,entityType:'supplier_invoice' as const,entityId:evidenceInvoice,version:null,hash}];
  async function actor<T>(person:'u1'|'u2',action:()=>Promise<T>){
   const client=await f.pool.connect(),user=f.fixture[person];
   try{
    await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
    const claims={sub:user.id,role:'authenticated',company_id:user.companyId};
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
    const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},action);
    await client.query('COMMIT');return result;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  const proposal=await actor('u1',()=>proposeBeneficiaryChange(requireControlTx(),{entityType:'supplier',entityId:f.supplier},
   {bankName:'Synthetic bank',accountNumber:'00987654321',branchCode:'001234',accountType:'cheque'},evidence));
  await actor('u2',()=>verifyBeneficiaryChange(requireControlTx(),proposal.proposalId,evidence));
  return{proposalId:proposal.proposalId,documentId:document};
 }finally{await storage.close();}
}
