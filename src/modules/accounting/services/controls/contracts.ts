import type { TxSql } from '@/lib/neon';

export const CONTROL_OPERATIONS = [
  'supplier_invoice.approve', 'supplier_invoice.post', 'supplier_invoice.cancel',
  'supplier_payment.process', 'supplier_payment.void', 'supplier_payment_batch.process',
  'payment_release.dispatch', 'payroll_run.approve', 'payroll_run.post', 'payroll_run.reopen',
  'payroll_compensation.change', 'journal.post', 'journal.reverse', 'fiscal_period.close',
  'fiscal_period.lock', 'fiscal_period.reopen', 'year.close', 'company_lockdown.change',
  'vat_period.lock', 'beneficiary.propose', 'beneficiary.verify', 'beneficiary.activate',
  'historical_import.post', 'bank_transfer.post', 'asset_depreciation.post',
  'customer_invoice.post', 'customer_invoice.cancel', 'customer_payment.confirm', 'customer_payment.cancel',
  'credit_note.approve', 'credit_note.cancel', 'credit_note_application.apply', 'recurring_invoice.generate',
] as const;
export type ControlOperation = typeof CONTROL_OPERATIONS[number];
export interface ControlPrincipal {
  companyId: string;
  personId: string;
  connectionId: string | null;
  grantId: string | null;
  actingFirmId: string | null;
  requestId: string;
  operationId: string;
  authMethod: 'cookie' | 'pat' | 'oauth' | 'job';
  provenance: 'human' | 'agent' | 'job';
  delegatedByPersonId: string | null;
  /** Null for cookies; bearer/job grant is an authority ceiling, never proof. */
  grantedScopes: readonly string[] | null;
}
export interface ControlTx { sql: TxSql; principal: ControlPrincipal }
export interface EntityRef { entityType: string; entityId: string }
export interface OperationRef extends EntityRef { operation: ControlOperation; expectedVersion?: number; reversalDate?: string }
export interface EntityVersionRef extends EntityRef { version: number; fingerprint: string }
export interface BeneficiaryBinding extends EntityVersionRef {
  entityType: 'supplier' | 'employee';
  beneficiaryId: string;
  amount: string | null;
  currency: string | null;
}
export interface PolicyBinding {
  policyId: string; policyVersion: number; approverRole: string; mandatory: boolean;
}
export interface OperationBinding extends EntityRef {
  companyId: string;
  operation: ControlOperation;
  entityVersion: number;
  accountingDate: string | null;
  amount: string | null;
  currency: string | null;
  beneficiaries: readonly BeneficiaryBinding[];
  sourceVersions: readonly EntityVersionRef[];
  policies: readonly PolicyBinding[];
}
export interface ApprovalDecision {
  policyId: string; personId: string; decidedAt: string;
  decision: 'approved' | 'rejected'; evidenceIds: readonly string[];
}
export interface OperationApproval {
  id: string; companyId: string; operationId: string; binding: OperationBinding;
  bindingHash: string; requesterPersonId: string; requestedAt: string; expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'consumed';
  decisions: readonly ApprovalDecision[]; consumedEffectId: string | null;
}
export interface EvidenceRef extends EntityRef {
  store: 'captured' | 'procurement' | 'bank_attachment' | 'protected';
  evidenceId: string; version: number | null; hash: string | null;
}
export interface ChangeEventInput extends EntityRef {
  /** Persisted server-derived intent ID; never copied from transport arguments. */
  operationId?: string;
  previousVersion: number | null; newVersion: number; action: string;
  accountingDate: string | null; before: Record<string, unknown> | null;
  after: Record<string, unknown> | null; bindingHash: string | null;
  protectedEvidenceRef: EvidenceRef | null;
}
export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'error';
export interface ControlFinding {
  key: string; kind: string; severity: 'low' | 'medium' | 'high';
  classification: 'candidate' | 'confirmed'; entities: readonly EntityRef[];
  message: string; evidence: readonly EvidenceRef[];
}
export interface ControlCheckResult {
  checkId: string; checkVersion: number; status: CheckStatus;
  populationCount: number; excludedCount: number; findingCount: number;
  amountTotals: Readonly<Record<string, string>>;
  findings: readonly ControlFinding[]; nextCursor: string | null;
  coverage: readonly string[]; missingSources: readonly string[];
  capturedAt: string; cutoff: string | null; sourceVersions: readonly EntityVersionRef[];
}
