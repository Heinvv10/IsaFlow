export const EVIDENCE_TYPES = ['supplier','supplier_invoice','sage_supplier_invoice','supplier_payment','bank_transaction',
  'journal_entry','operation_approval','captured_document','procurement_document','bank_attachment',
  'customer_invoice','customer_payment','credit_note','purchase_order','goods_received_note','gl_account','fiscal_period','company_gl_settings'] as const;
export type EvidenceEntityType = typeof EVIDENCE_TYPES[number];
export interface EvidenceIdentity { entityType: EvidenceEntityType; entityId: string }
export interface EvidenceNode extends EvidenceIdentity {
  status: string; version: number | null; recordedSince: string | null;
  hashAvailability: 'available' | 'missing' | 'not_applicable';
  flags: Array<'missing'|'ambiguous'|'reversed'|'untracked'|'forked'>;
}
export interface EvidenceEdge { from: EvidenceIdentity; to: EvidenceIdentity; relation: string; provenance: 'recorded' }
export interface CoverageGap { source: EvidenceIdentity; reason: string }
export interface TransactionEvidenceResult {
  root: EvidenceIdentity; nodes: EvidenceNode[]; edges: EvidenceEdge[]; nextCursor: string | null;
  coverage: {
    status: 'complete'|'partial'; countScope: 'visited_population'; visitedNodes: number; discoveredEdges: number;
    documentCounts: {captured:number;procurement:number;bank_attachment:number};
    historicalCoverage: 'untracked'|'recorded_since'; earliestRecordedEvent: string | null;
    gaps: CoverageGap[]; maxDepth: 6; maxNodes: 500;
  };
}
export interface EvidenceNeighbor { target: EvidenceIdentity; relation: string; gap?: string }
export const evidenceKey = (ref: EvidenceIdentity): string => `${ref.entityType}:${ref.entityId}`;
export function readPermission(type: EvidenceEntityType): string {
  if (type==='supplier') return 'read:contacts';
  if (type==='bank_transaction'||type==='bank_attachment') return 'read:bank-tx';
  if (['journal_entry','gl_account','fiscal_period','company_gl_settings'].includes(type)) return 'read:reports';
  if (type==='operation_approval') return 'read:approvals';
  return 'read:invoices';
}
