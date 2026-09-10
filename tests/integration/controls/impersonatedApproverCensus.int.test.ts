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
 it('refuses a tenant approval taken directly in a platform-admin request context',async()=>{
  await expect(h.platformRequest(()=>approveSupplierInvoice(h.f.companyA,randomUUID(),h.admin)))
   .rejects.toThrow('A platform administrator is not an independent reviewer');
 });
});
