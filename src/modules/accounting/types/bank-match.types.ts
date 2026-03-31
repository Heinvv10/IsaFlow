/**
 * Shared types for the bank Find & Match feature.
 * Imported by both the API routes and the FindMatchModal component.
 */

export type CandidateType = 'supplier_invoice' | 'customer_invoice' | 'purchase_order' | 'journal_line';

export interface MatchCandidate {
  type: CandidateType;
  id: string;
  label: string;
  amount: number;
  date: string;
  /** Composite match score 0–100+ (amount + date + description + bonuses) */
  score: number;
  /** Human-readable reason why this candidate matched */
  matchReason?: string;
}
