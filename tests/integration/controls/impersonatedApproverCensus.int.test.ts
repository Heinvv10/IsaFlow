import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {platformImportApprovalFixture} from './platformImportApprovalFixture';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {approvePayrollRun} from '@/modules/accounting/services/payroll/payrollApprovalService';
import {approveBatch} from '@/modules/accounting/services/ap/batchPaymentService';
import {approveAdjustment} from '@/modules/accounting/services/items/adjustmentService';
import {approveSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {approvePracticeEntries} from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';
import {updateLeaveRequest} from '@/modules/accounting/services/payroll/payrollLeaveService';
import {decideProposal} from '@/modules/accounting/services/gl/closeRun/closeRunService';
import {rejectClaim} from '@/modules/accounting/services/expense/expenseClaimService';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {markSectionReviewed,signOffSection,signOffDocument} from '@/modules/accounting/services/afs/afsReviewService';
import {lockAfsDocument} from '@/modules/accounting/services/afs/afsDocumentService';
import {updateAfsSection} from '@/modules/accounting/services/afs/afsSectionService';
import {updateTaxDirectiveStatus} from '@/modules/accounting/services/payroll/taxDirectiveService';
import {updateTaxDirectiveStatus as updateTaxDirectiveReportStatus} from '@/modules/accounting/services/reports/taxDirectiveReportsService';

/**
 * The census of approver-of-record entry points outside the controls kernel: every
 * service that writes an approver column or posts a journal when it approves. Each is
 * called with an identifier that does not exist, so only a refusal that fires BEFORE the
 * row is read can produce the impersonation message - which is where the guard must sit,
 * because these routes answer 4xx and withAuth commits a 4xx.
 */
describe('every approver-of-record entry point refuses an impersonated principal',()=>{
 let h:Awaited<ReturnType<typeof platformImportApprovalFixture>>;
 const REFUSAL='An impersonated session cannot record an independent review';
 beforeAll(async()=>{h=await platformImportApprovalFixture();},30000);
 afterAll(async()=>{await h?.close();});
 const impersonated=<T>(fn:()=>Promise<T>)=>h.member(h.f.u2.id,()=>fn(),false,h.admin);
 const ordinary=<T>(fn:()=>Promise<T>)=>h.member(h.f.u2.id,()=>fn(),false,null);

 const cases:Array<[string,()=>Promise<unknown>]>=[
  ['customer invoice',()=>approveCustomerInvoice(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['payroll run',()=>approvePayrollRun(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['supplier payment batch',()=>approveBatch(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['accounting adjustment',()=>approveAdjustment(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['supplier payment',()=>approveSupplierPayment(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['practice time entries',()=>approvePracticeEntries(h.f.companyA,[randomUUID()],h.f.u2.id)],
  ['leave request',()=>updateLeaveRequest(randomUUID(),h.f.companyA,{status:'approved',approvedBy:h.f.u2.id})],
  ['close run proposal',()=>decideProposal(h.f.companyA,randomUUID(),randomUUID(),'approve',h.f.u2.id)],
  ['expense claim rejection',()=>rejectClaim(randomUUID(),h.f.companyA,h.f.u2.id,'Rejected')],
  ['supplier invoice',()=>approveSupplierInvoice(h.f.companyA,randomUUID(),h.f.u2.id)],
  // The strongest approver of record in the product: an AFS review, sign-off and lock.
  ['AFS section review',()=>markSectionReviewed(h.f.companyA,randomUUID(),randomUUID(),h.f.u2.id)],
  ['AFS section sign-off',()=>signOffSection(h.f.companyA,randomUUID(),randomUUID(),h.f.u2.id)],
  ['AFS document sign-off',()=>signOffDocument(h.f.companyA,randomUUID(),h.f.u2.id)],
  ['AFS document lock',()=>lockAfsDocument(randomUUID(),h.f.companyA,h.f.u2.id)],
  ['AFS section reviewer supplied by the caller',()=>updateAfsSection(randomUUID(),randomUUID(),h.f.companyA,{reviewedBy:h.f.u2.id})],
  ['AFS section signatory supplied by the caller',()=>updateAfsSection(randomUUID(),randomUUID(),h.f.companyA,{signedOffBy:h.f.u2.id})],
  ['tax directive approval',()=>updateTaxDirectiveStatus(h.f.companyA,randomUUID(),'approved',h.f.u2.id)],
  ['tax directive report approval',()=>updateTaxDirectiveReportStatus(h.f.companyA,randomUUID(),'approved',h.f.u2.id)],
 ];
 it.each(cases)('refuses %s approval under an impersonated session',async(_name,call)=>{
  await expect(impersonated(call)).rejects.toThrow(REFUSAL);
 });
 it.each(cases)('still reaches the ordinary %s path unimpersonated',async(_name,call)=>{
  // The same call from an unimpersonated session gets past the guard - it either
  // succeeds vacuously or fails on the missing row - so the refusal above is the
  // guard and not the lookup.
  const outcome=await ordinary(call).then(()=>'resolved',error=>String(error instanceof Error?error.message:error));
  expect(outcome).not.toContain(REFUSAL);
 });
 it('does not yet refuse a platform-admin request context, and says so loudly',async()=>{
  // Refusing here breaks the Sage migration commit, whose only route today is
  // withPlatformAdmin; withPlatformImportTarget cannot carry it (its ceiling grants no
  // write:invoices and its confinement admits only historical_import.post). Until that
  // path is confined the request is allowed and recorded at error level, and this test
  // is what will fail when the refusal lands, so the decision cannot be forgotten.
  const outcome=await h.platformRequest(()=>approveSupplierInvoice(h.f.companyA,randomUUID(),h.admin))
   .then(()=>'resolved',error=>String(error instanceof Error?error.message:error));
  expect(outcome).not.toContain('independent reviewer');
  expect(outcome).toContain('Supplier invoice');
 });
});
