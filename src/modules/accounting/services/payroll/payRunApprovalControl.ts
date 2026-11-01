/** R-035 clearance for the exact journal plan a person reviewed for a pay run. */
import { sql } from '@/lib/neon';
import {
  assertApprovalClearedForDocument,
  describeApprovalGateForDocument,
} from '@/modules/accounting/services/gl/approvalGate';
import type { ApprovalDocument } from '@/modules/accounting/services/gl/approvalDocuments';
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';
import { judgePayrollApproval } from './payrollApprovalGate';

type Header = {
  status: string;
  period_month?: number;
  period_year?: number;
  total_gross?: number;
  approval_grandfathered_at: string | null;
  approved_plan_hash?: string | null;
};

export interface PayRunClearance {
  grandfathered: boolean;
  planHash: string | null;
}

const reference = (row: Header): string | null => row.period_month && row.period_year
  ? `${String(row.period_month).padStart(2, '0')}/${row.period_year}` : null;

const document = (row: Header, digest: string): ApprovalDocument => ({
  amount: Number(row.total_gross ?? 0), reference: reference(row), digest,
});

async function header(companyId: string, runId: string): Promise<Header | null> {
  const rows = (await sql`
    SELECT status, period_month, period_year, total_gross,
           approval_grandfathered_at, approved_plan_hash
    FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Header[];
  return rows[0] ?? null;
}

/**
 * Store the locked plan hash just before generic R-035 request/decision SQL.
 * The SQL definer derives its digest from this tenant-scoped cache.
 */
export async function preparePayRunApprovalRequest(companyId: string, runId: string): Promise<string> {
  const gate = await judgePayrollApproval(companyId, runId);
  if (!gate) throw new Error('Payroll run not found');
  await sql`
    UPDATE payroll_run_headers SET approval_plan_hash = ${gate.planHash}
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;
  return gate.planHash;
}

/** Read-only UI state against the live plan, not a cached digest. */
export async function describePayRunApproval(companyId: string, runId: string): Promise<DocumentApprovalState> {
  const [row, gate] = await Promise.all([header(companyId, runId), judgePayrollApproval(companyId, runId)]);
  if (!row || !gate) throw new Error('Payroll run not found');
  return describeApprovalGateForDocument(companyId, 'pay_run', runId, document(row, gate.planHash));
}

/**
 * Reusable finalisation guard for posting now and future payslip/EFT/paid flows.
 * New runs need human R-035 clearance for the exact plan hash. Historical
 * approved/paid rows marked by migration 951 remain valid without retroactive approval.
 */
export async function assertPayRunApproved(
  companyId: string,
  runId: string,
  expectedPlanHash?: string,
): Promise<PayRunClearance> {
  const row = await header(companyId, runId);
  if (!row) throw new Error('Payroll run not found');
  if (row.approval_grandfathered_at && (row.status === 'approved' || row.status === 'paid')) {
    return { grandfathered: true, planHash: null };
  }
  const planHash = expectedPlanHash ?? row.approved_plan_hash;
  if (!planHash) throw new Error('Pay run has no reviewed approval plan');
  await assertApprovalClearedForDocument(companyId, 'pay_run', runId, document(row, planHash));
  return { grandfathered: false, planHash };
}
