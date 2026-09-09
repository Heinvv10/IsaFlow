import {useRouter} from 'next/router';
import {AppLayout} from '@/components/layout/AppLayout';
import {BankApprovalInbox} from '@/components/accounting/bank-transactions/BankApprovalInbox';
import {BankApprovalDetail} from '@/components/accounting/bank-transactions/BankApprovalDetail';
export default function BankControlApprovalsPage(){
 const router=useRouter(),approvalId=typeof router.query.approvalId==='string'?router.query.approvalId:undefined;
 return <AppLayout><main className="mx-auto max-w-5xl space-y-6 p-6 text-[var(--ff-text-primary)]">
  <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">Bank approvals</h1><a className="text-blue-500 underline" href="/accounting/bank-transactions">Bank transactions</a></header>
  {router.isReady&&(approvalId?<><a className="inline-block text-sm underline" href="/accounting/bank-control-approvals">Back to bank approvals</a><BankApprovalDetail key={approvalId} approvalId={approvalId}/></>:<BankApprovalInbox/>)}
 </main></AppLayout>;
}
